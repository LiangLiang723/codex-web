import { posix } from "node:path";
import { z } from "zod";
import { remoteFiles, sshConnections } from "./gateway/infra/host-services";
import { codexRemotePayload, remoteLoginShellCommand } from "./gateway/infra/ssh/remote-command";
import { shellQuote } from "./gateway/infra/ssh/shell";
import type { HostWithSecret } from "./gateway/infra/ssh/ssh-types";
import { threadBroker } from "./gateway/runtime/broker";

const segment = "[A-Za-z0-9_][A-Za-z0-9_.-]*";
const marketplace = z
  .string()
  .max(128)
  .regex(new RegExp(`^${segment}$`, "u"));
const pluginId = z
  .string()
  .max(257)
  .regex(new RegExp(`^${segment}@${segment}$`, "u"));
const cwd = z
  .string()
  .max(4096)
  .startsWith("/")
  .refine((path) => !path.includes("\0"));
const source = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((value) => {
    if (
      Array.from(value).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })
    )
      return false;
    if (/^(?:\/|\.\.?\/)/u.test(value)) return true;
    if (/^[\w.-]+\/[\w.-]+(?:@[\w./-]+)?$/u.test(value)) return !value.startsWith("-");
    if (/^[\w.-]+@[\w.-]+:[\w./-]+$/u.test(value)) return !value.startsWith("-");
    try {
      const url = new URL(value);
      // Git 支持外部 transport，表单只接收 Codex 声明的普通 Git URL 和本地路径。
      return (
        !url.password && ((url.protocol === "https:" && !url.username) || url.protocol === "ssh:")
      );
    } catch {
      return false;
    }
  }, "Use a remote absolute path, owner/repository, an HTTPS Git URL or an SSH Git URL.");
const base = z.object({ hostId: z.number().int().positive(), cwd });
export const nativePluginRequestSchema = z.discriminatedUnion("operation", [
  base.extend({ operation: z.literal("catalog") }).strict(),
  base.extend({ operation: z.literal("describe"), pluginId }).strict(),
  base.extend({ operation: z.literal("install"), pluginId }).strict(),
  base.extend({ operation: z.literal("uninstall"), pluginId }).strict(),
  base.extend({ operation: z.literal("setEnabled"), pluginId, enabled: z.boolean() }).strict(),
  base.extend({ operation: z.literal("marketplaceAdd"), source }).strict(),
  base.extend({ operation: z.literal("marketplaceRemove"), marketplace }).strict(),
  base
    .extend({ operation: z.literal("marketplaceUpgrade"), marketplace: marketplace.optional() })
    .strict(),
]);
type PluginRequest = z.infer<typeof nativePluginRequestSchema>;

const marketplaceSource = z.object({ sourceType: z.string(), source: z.string() });
const catalogEntry = z.object({
  pluginId: z.string(),
  name: z.string(),
  marketplaceName: z.string(),
  version: z.string().nullish(),
  installed: z.boolean(),
  enabled: z.boolean(),
  source: z.object({ source: z.string(), path: z.string().optional() }),
  marketplaceSource: marketplaceSource.optional(),
  installPolicy: z.string().optional(),
});
const catalogResponse = z.object({
  installed: z.array(catalogEntry),
  available: z.array(catalogEntry),
});
const marketResponse = z.object({
  marketplaces: z.array(
    z.object({
      name: z.string(),
      root: z.string(),
      marketplaceSource: marketplaceSource.optional(),
    }),
  ),
});
const manifestSchema = z.object({
  description: z.string().optional(),
  version: z.string().optional(),
  homepage: z.string().optional(),
  author: z.object({ name: z.string().optional(), url: z.string().optional() }).optional(),
  interface: z
    .object({ displayName: z.string().optional(), shortDescription: z.string().optional() })
    .optional(),
});

async function pluginCommand(host: HostWithSecret, directory: string, argv: string[]) {
  // SSH exec 接口接受 shell 字符串，动态值只能通过上游的 POSIX 单参数引用边界。
  const payload = codexRemotePayload(
    `cd ${shellQuote(directory)} && exec "$CODEX_BIN" plugin ${argv.map(shellQuote).join(" ")}`,
  );
  const result = await sshConnections.exec(host, remoteLoginShellCommand(payload), {
    timeoutMs: 90000,
    maxOutputBytes: 4 * 1024 * 1024,
  });
  const stderr = result.stderr.trim();
  if (result.code !== 0) {
    if (/unrecognized (subcommand|option)|unexpected argument/u.test(stderr)) {
      throw Error("The installed Codex CLI does not support this plugin operation.");
    }
    throw Error(
      stderr.slice(0, 2000) ||
        `Codex plugin command failed (${result.code ?? "SSH channel closed"}).`,
    );
  }
  try {
    return { value: JSON.parse(result.stdout) as unknown, warning: stderr.slice(0, 2000) };
  } catch {
    throw Error("The installed Codex CLI returned an invalid plugin response.");
  }
}

async function pluginCatalog(host: HostWithSecret, directory: string, market?: string) {
  const result = await pluginCommand(host, directory, [
    "list",
    "--json",
    "--available",
    ...(market ? ["--marketplace", market] : []),
  ]);
  const { installed, available } = catalogResponse.parse(result.value);
  return { entries: [...installed, ...available], warning: result.warning };
}

async function readLocalManifest(host: HostWithSecret, root: string) {
  const path = posix.join(root, ".codex-plugin", "plugin.json");
  try {
    const { stream } = await remoteFiles.openRemoteFile(host, path, { maxSize: 128 * 1024 });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > 128 * 1024) throw Error("Codex plugin manifest exceeds 128 KiB.");
      chunks.push(buffer);
    }
    return manifestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch (error) {
    if (error instanceof Error && error.name === "RemoteFileNotFoundError") return;
    throw error;
  }
}

export async function manageNativePlugins(host: HostWithSecret, request: PluginRequest) {
  const { cwd: directory, operation } = request;
  if (operation === "catalog") {
    const [plugins, markets] = await Promise.allSettled([
      pluginCatalog(host, directory),
      pluginCommand(host, directory, ["marketplace", "list", "--json"]).then((reply) => ({
        markets: marketResponse.parse(reply.value).marketplaces,
        warning: reply.warning,
      })),
    ]);
    if (plugins.status === "rejected" && markets.status === "rejected") throw plugins.reason;
    return {
      entries: plugins.status === "fulfilled" ? plugins.value.entries : [],
      markets: markets.status === "fulfilled" ? markets.value.markets : [],
      issues: [plugins, markets].flatMap((result) => {
        const message =
          result.status === "fulfilled" ? result.value.warning : String(result.reason);
        return message ? [message] : [];
      }),
    };
  }
  if (operation === "marketplaceAdd")
    return (
      await pluginCommand(host, directory, ["marketplace", "add", "--json", "--", request.source])
    ).value;
  if (operation === "marketplaceRemove")
    return (
      await pluginCommand(host, directory, [
        "marketplace",
        "remove",
        "--json",
        "--",
        request.marketplace,
      ])
    ).value;
  if (operation === "marketplaceUpgrade")
    return (
      await pluginCommand(host, directory, [
        "marketplace",
        "upgrade",
        "--json",
        ...(request.marketplace ? ["--", request.marketplace] : []),
      ])
    ).value;
  if (operation === "uninstall")
    return (await pluginCommand(host, directory, ["remove", "--json", "--", request.pluginId]))
      .value;
  if (operation === "install")
    return (await pluginCommand(host, directory, ["add", "--json", "--", request.pluginId])).value;

  const { entries } = await pluginCatalog(host, directory, request.pluginId.split("@")[1]);
  const entry = entries.find((candidate) => candidate.pluginId === request.pluginId);
  if (operation === "describe") {
    if (!entry) return {};
    const root = entry.source.source === "local" ? entry.source.path : undefined;
    return {
      entry,
      manifest: root?.startsWith("/") ? await readLocalManifest(host, root) : undefined,
    };
  }
  if (!entry?.installed) throw Error("This plugin is not installed on the selected Codex host.");
  if (entry.source.source === "remote")
    throw Error("Manage this plugin's enablement in your Codex account.");
  // 配置只写插件的布尔叶子。保留同插件的 MCP 配置，并检查管理策略覆盖。
  const result = z.object({ status: z.string(), overriddenMetadata: z.unknown().nullish() }).parse(
    await threadBroker.selfhostCapability(host, "config/value/write", {
      keyPath: `plugins.${JSON.stringify(entry.pluginId)}.enabled`,
      value: request.enabled,
      mergeStrategy: "replace",
    }),
  );
  if (result.status === "okOverridden" || result.overriddenMetadata)
    throw Error("The SSH host's Codex configuration policy overrides this plugin setting.");
  const updated = await pluginCatalog(host, directory, entry.marketplaceName);
  const plugin = updated.entries.find((candidate) => candidate.pluginId === request.pluginId);
  if (!plugin?.installed || plugin.enabled !== request.enabled)
    throw Error("The effective plugin status did not change on the selected Codex host.");
  return plugin;
}
