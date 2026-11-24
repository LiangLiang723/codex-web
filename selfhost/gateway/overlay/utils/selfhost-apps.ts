import { z } from "zod";

type NativeRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>;
const id = z
  .string()
  .min(1)
  .max(512)
  .refine((value) =>
    Array.from(value).every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127),
  );
const scope = { hostId: z.number().int().positive() };
export const appRequest = z.discriminatedUnion("operation", [
  z
    .object({
      ...scope,
      operation: z.literal("list"),
      force: z.boolean().default(false),
      cursor: z.string().min(1).max(8192).optional(),
    })
    .strict(),
  z.object({ ...scope, operation: z.literal("detail"), id }).strict(),
  z
    .object({
      ...scope,
      operation: z.literal("setEnabled"),
      id,
      enabled: z.boolean(),
      tool: id.optional(),
    })
    .strict(),
]);
type Operation =
  | Omit<Extract<z.infer<typeof appRequest>, { operation: "list" }>, "hostId">
  | Omit<Extract<z.infer<typeof appRequest>, { operation: "detail" }>, "hostId">
  | Omit<Extract<z.infer<typeof appRequest>, { operation: "setEnabled" }>, "hostId">;
const labels = z.array(z.string()).nullish();
const optionalText = z.string().nullish();
const directoryApp = z.object({
  id,
  name: z.string(),
  description: optionalText,
  installUrl: optionalText,
  isAccessible: z.boolean().nullish(),
  isEnabled: z.boolean().nullish(),
  pluginDisplayNames: labels,
});
const directoryPage = z.object({ data: z.array(directoryApp), nextCursor: z.string().nullish() });
const installedSnapshot = z.object({
  apps: z.array(
    z.object({ id, enabled: z.boolean(), callable: z.boolean(), runtimeName: optionalText }),
  ),
});
const toolInfo = z.object({
  name: id,
  title: optionalText,
  description: optionalText,
  isEnabled: z.boolean().nullish(),
  isReadOnly: z.boolean().nullish(),
  disabledReason: optionalText,
});
const details = z.object({
  apps: z.array(
    z.object({
      id,
      name: z.string(),
      description: optionalText,
      pluginDisplayNames: labels,
      installUrl: optionalText,
      toolSummaries: z.array(toolInfo).nullish(),
    }),
  ),
});
const writeResult = z.object({
  status: z.enum(["ok", "okOverridden"]),
  overriddenMetadata: z.object({ message: z.string() }).nullish(),
});
function missingMethod(error: unknown, method: string) {
  if (typeof error !== "object" || !error || !("rpcCode" in error)) return false;
  if (error.rpcCode === -32601) return true;
  // 原生反序列化未知方法也可能使用 -32600。普通参数错误仍需呈现。
  return (
    error.rpcCode === -32600 &&
    error instanceof Error &&
    new RegExp("unknown (?:variant|method)\\s+[`'\"]?" + method + "(?:[`'\",\\s]|$)", "i").test(
      error.message,
    )
  );
}

function installUrl(value: string | null | undefined) {
  if (!value || !URL.canParse(value)) return null;
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
}
async function directory(rpc: NativeRequest, force: boolean, cursor: string | null) {
  return directoryPage.parse(
    await rpc("app/list", { cursor, limit: 100, forceRefetch: force && cursor === null }),
  );
}
async function installed(rpc: NativeRequest, force: boolean) {
  try {
    const { apps } = installedSnapshot.parse(await rpc("app/installed", { forceRefresh: force }));
    return new Map(apps.map((app) => [app.id, app]));
  } catch (error) {
    if (missingMethod(error, "app/installed")) return null;
    throw error;
  }
}
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
async function list(rpc: NativeRequest, force: boolean, cursor: string | null = null) {
  // 首次进入管理页需要当前运行快照；原生冷缓存的空数组无法证明没有安装。
  const [catalogue, runtime] = await Promise.allSettled([
    directory(rpc, force, cursor),
    cursor ? Promise.resolve(null) : installed(rpc, true),
  ]);
  const entries = catalogue.status === "fulfilled" ? catalogue.value.data : [];
  const listed = new Map(entries.map((app) => [app.id, app]));
  const active = runtime.status === "fulfilled" ? runtime.value : null;
  if (catalogue.status === "rejected" && !active) throw catalogue.reason;
  const ids = new Set([...listed.keys(), ...(active?.keys() ?? [])]);
  const apps = Array.from(ids, (id) => {
    const entry = listed.get(id),
      state = active?.get(id);
    return {
      id,
      name: entry?.name ?? state?.runtimeName ?? id,
      description: entry?.description ?? null,
      installUrl: installUrl(entry?.installUrl),
      plugins: entry?.pluginDisplayNames ?? [],
      accessible: entry?.isAccessible ?? null,
      installed: active ? Boolean(state) : null,
      enabled: state?.enabled ?? entry?.isEnabled ?? null,
      callable: state?.callable ?? null,
    };
  });
  // 离首个目录页较远的已安装应用仍需可辨认。一次按 ID 补元数据，不遍历整个市场。
  const missing = apps.filter((app) => app.installed && !listed.has(app.id));
  let metadataIssue: string | null = null;
  try {
    for (let offset = 0; offset < missing.length; offset += 100) {
      const batch = missing.slice(offset, offset + 100);
      const response = details.parse(
        await rpc("app/read", { appIds: batch.map((app) => app.id), includeTools: false }),
      );
      const metadataById = new Map(response.apps.map((row) => [row.id, row]));
      for (const app of batch) {
        const metadata = metadataById.get(app.id);
        if (metadata) {
          app.name = metadata.name;
          app.description = metadata.description ?? null;
          app.installUrl = installUrl(metadata.installUrl);
          app.plugins = metadata.pluginDisplayNames ?? [];
        }
      }
    }
  } catch (error) {
    if (!missingMethod(error, "app/read")) metadataIssue = errorMessage(error);
  }
  return {
    apps,
    nextCursor: catalogue.status === "fulfilled" ? (catalogue.value.nextCursor ?? null) : null,
    runtimeKnown: active !== null,
    directoryIssue:
      catalogue.status === "rejected" ? errorMessage(catalogue.reason) : metadataIssue,
    runtimeIssue: runtime.status === "rejected" ? errorMessage(runtime.reason) : null,
  };
}

async function canConfigureLegacyApp(rpc: NativeRequest, appId: string) {
  const snapshot = await installed(rpc, false);
  if (snapshot?.has(appId)) return true;
  let cursor: string | null = null;
  const visited = new Set<string>();
  do {
    const page = await directory(rpc, false, cursor);
    const app = page.data.find((entry) => entry.id === appId);
    if (app) return app.isAccessible === true;
    cursor = page.nextCursor ?? null;
    if (cursor && visited.has(cursor)) throw Error("Codex returned a repeated app cursor");
    if (cursor) visited.add(cursor);
  } while (cursor);
  return false;
}
async function lookup(rpc: NativeRequest, appId: string, includeTools: boolean) {
  try {
    const result = details.parse(await rpc("app/read", { appIds: [appId], includeTools }));
    return result.apps.find((app) => app.id === appId) ?? null;
  } catch (error) {
    if (missingMethod(error, "app/read")) return null;
    throw error;
  }
}
export async function manageCodexApps(rpc: NativeRequest, request: Operation) {
  if (request.operation === "list") return list(rpc, request.force, request.cursor ?? null);
  const metadata = await lookup(
    rpc,
    request.id,
    request.operation === "detail" || Boolean(request.tool),
  );
  if (request.operation === "detail")
    return {
      plugins: metadata?.pluginDisplayNames ?? [],
      installUrl: installUrl(metadata?.installUrl),
      tools:
        metadata?.toolSummaries?.map((tool) => ({
          name: tool.name,
          title: tool.title ?? null,
          description: tool.description ?? null,
          enabled: tool.isEnabled ?? null,
          readOnly: tool.isReadOnly ?? null,
          disabledReason: tool.disabledReason ?? null,
        })) ?? null,
    };
  if (request.id === "_default") throw Error("A concrete Codex app is required");
  if (request.tool && !metadata?.toolSummaries?.some((tool) => tool.name === request.tool))
    throw Error("Codex did not report this tool for the selected app");
  if (!metadata && !(await canConfigureLegacyApp(rpc, request.id)))
    throw Error("Codex did not report this app as accessible");
  // 远端按 TOML dotted key 解析。将原生 ID 和工具名各自写成单个带引号的键，保留点号和斜杠。
  const keys = ["apps", JSON.stringify(request.id)];
  if (request.tool) keys.push("tools", JSON.stringify(request.tool));
  keys.push("enabled");
  const result = writeResult.parse(
    await rpc("config/value/write", {
      keyPath: keys.join("."),
      value: request.enabled,
      mergeStrategy: "upsert",
    }),
  );
  return {
    overridden: result.status === "okOverridden",
    message: result.overriddenMetadata?.message ?? null,
  };
}
