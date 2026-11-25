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
    .object({ ...scope, operation: z.literal("installed"), force: z.boolean().default(false) })
    .strict(),
  z.object({ ...scope, operation: z.literal("available"), threadId: id.optional() }).strict(),
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
  | Omit<Extract<z.infer<typeof appRequest>, { operation: "installed" }>, "hostId">
  | Omit<Extract<z.infer<typeof appRequest>, { operation: "available" }>, "hostId">
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
  logoUrl: optionalText,
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
      iconUrl: optionalText,
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
async function directory(
  rpc: NativeRequest,
  force: boolean,
  cursor: string | null,
  threadId?: string,
) {
  return directoryPage.parse(
    await rpc("app/list", {
      cursor,
      limit: 100,
      forceRefetch: force && cursor === null,
      ...(threadId && { threadId }),
    }),
  );
}
async function installed(rpc: NativeRequest, force: boolean, threadId?: string) {
  try {
    const { apps } = installedSnapshot.parse(
      await rpc("app/installed", { forceRefresh: force, ...(threadId && { threadId }) }),
    );
    return new Map(apps.map((app) => [app.id, app]));
  } catch (error) {
    if (missingMethod(error, "app/installed")) return null;
    throw error;
  }
}
async function currentSnapshot(rpc: NativeRequest, force: boolean, threadId?: string) {
  const current = await installed(rpc, force, threadId);
  // 无缓存与空目录在原生响应中同为 []，首次为空时等待一次权威刷新。
  return !force && current?.size === 0 ? installed(rpc, true, threadId) : current;
}
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function appRow(
  key: string,
  entry?: z.infer<typeof directoryApp>,
  state?: z.infer<typeof installedSnapshot>["apps"][number],
  runtimeKnown = false,
) {
  return {
    id: key,
    name: entry?.name ?? state?.runtimeName ?? key,
    description: entry?.description ?? null,
    installUrl: installUrl(entry?.installUrl),
    iconUrl: installUrl(entry?.logoUrl),
    plugins: entry?.pluginDisplayNames ?? [],
    accessible: entry?.isAccessible ?? null,
    installed: runtimeKnown ? Boolean(state) : null,
    enabled: state?.enabled ?? entry?.isEnabled ?? null,
    callable: state?.callable ?? null,
  };
}

async function runtimeApps(rpc: NativeRequest, force: boolean, threadId?: string) {
  // Codex 已提交的快照可以直接读。只有冷启动留下空缓存时再刷新真实运行态。
  const snapshot = await currentSnapshot(rpc, force, threadId);
  if (snapshot)
    return {
      apps: [...snapshot.values()].map((app) => appRow(app.id, undefined, app, true)),
      runtimeKnown: true,
    };

  // 旧版没有运行快照，逐页只采纳原生明确可访问的条目。保留未知运行态。
  const found = new Map<string, ReturnType<typeof appRow>>();
  const visited = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await directory(rpc, force, cursor, threadId);
    for (const item of page.data)
      if (item.isAccessible === true) found.set(item.id, appRow(item.id, item));
    cursor = page.nextCursor ?? null;
    if (cursor && visited.has(cursor)) throw Error("Codex returned a repeated app cursor");
    if (cursor) visited.add(cursor);
  } while (cursor);
  return { apps: [...found.values()], runtimeKnown: false };
}

async function explainEmptyApps(rpc: NativeRequest) {
  // API Key 模式和显式禁用应用也会返回空目录，不能把它们显示为尚未安装。
  const [account, settings] = await Promise.allSettled([
    rpc("account/read", { refreshToken: false }),
    rpc("config/read", { includeLayers: false }),
  ]);
  if (settings.status === "fulfilled") {
    const value = z
      .object({
        config: z.object({ features: z.object({ apps: z.boolean().optional() }).nullish() }),
      })
      .safeParse(settings.value);
    if (value.success && value.data.config.features?.apps === false) return "disabled";
  }
  if (account.status === "fulfilled") {
    const value = z
      .object({ account: z.object({ type: z.string() }).nullable() })
      .safeParse(account.value);
    if (value.success && (value.data.account === null || value.data.account.type === "apiKey"))
      return "chatgpt";
  }
  return null;
}

async function list(rpc: NativeRequest, force: boolean, cursor: string | null = null) {
  // 首次进入管理页需要当前运行快照；原生冷缓存的空数组无法证明没有安装。
  const [catalogue, runtime] = await Promise.allSettled([
    directory(rpc, force, cursor),
    cursor ? Promise.resolve(null) : currentSnapshot(rpc, force),
  ]);
  const entries = catalogue.status === "fulfilled" ? catalogue.value.data : [];
  const listed = new Map(entries.map((app) => [app.id, app]));
  const active = runtime.status === "fulfilled" ? runtime.value : null;
  if (catalogue.status === "rejected" && !active) throw catalogue.reason;
  const ids = new Set([...listed.keys(), ...(active?.keys() ?? [])]);
  const apps = Array.from(ids, (id) =>
    appRow(id, listed.get(id), active?.get(id), active !== null),
  );
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
          app.iconUrl = installUrl(metadata.iconUrl);
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
const toolSettings = z.object({
  default_tools_enabled: z.boolean().nullish(),
  tools: z.record(z.string(), z.object({ enabled: z.boolean().nullish() })).nullish(),
});
const configApps = z.object({
  config: z.object({ apps: z.record(z.string(), z.unknown()).nullish() }),
});
async function readAppTools(rpc: NativeRequest, appId: string) {
  try {
    // app/read 的公开清单不读取 SSH 用户写下的覆盖值，仅摘取当前应用的配置，其他设置留在 Gateway。
    const result = configApps.parse(await rpc("config/read", { includeLayers: false }));
    const app = result.config.apps?.[appId];
    return { settings: app ? toolSettings.parse(app) : undefined, issue: null };
  } catch (error) {
    return { settings: undefined, issue: errorMessage(error) };
  }
}
export async function manageCodexApps(rpc: NativeRequest, request: Operation) {
  if (request.operation === "list") return list(rpc, request.force, request.cursor ?? null);
  if (request.operation === "installed") {
    const result = await runtimeApps(rpc, request.force);
    const emptyReason = result.apps.length ? null : await explainEmptyApps(rpc);
    return { ...result, emptyReason, nextCursor: null, directoryIssue: null, runtimeIssue: null };
  }
  if (request.operation === "available") {
    const result = await runtimeApps(rpc, false, request.threadId);
    return {
      apps: result.apps.filter((app) =>
        result.runtimeKnown ? app.callable === true : app.enabled === true,
      ),
    };
  }
  if (request.operation === "detail") {
    const [metadata, config] = await Promise.all([
      lookup(rpc, request.id, true),
      readAppTools(rpc, request.id),
    ]);
    return {
      configIssue: config.issue,
      name: metadata?.name ?? null,
      description: metadata?.description ?? null,
      iconUrl: installUrl(metadata?.iconUrl),
      accessible: metadata ? true : null,
      plugins: metadata?.pluginDisplayNames ?? [],
      installUrl: installUrl(metadata?.installUrl),
      tools:
        metadata?.toolSummaries?.map((tool) => ({
          name: tool.name,
          title: tool.title ?? null,
          description: tool.description ?? null,
          enabled:
            tool.isEnabled === false
              ? false
              : (config.settings?.tools?.[tool.name]?.enabled ??
                config.settings?.default_tools_enabled ??
                tool.isEnabled ??
                null),
          configurable: !config.issue && tool.isEnabled !== false,
          readOnly: tool.isReadOnly ?? null,
          disabledReason: tool.disabledReason ?? null,
        })) ?? null,
    };
  }
  if (request.id === "_default") throw Error("A concrete Codex app is required");
  if (request.tool) {
    const metadata = await lookup(rpc, request.id, true);
    const tool = metadata?.toolSummaries?.find((item) => item.name === request.tool);
    if (!tool) throw Error("Codex did not report this tool for the selected app");
    if (request.enabled && tool.isEnabled === false)
      throw Error(tool.disabledReason || "The app provider disabled this tool");
  } else if (
    !(await installed(rpc, false))?.has(request.id) &&
    !(await lookup(rpc, request.id, false)) &&
    !(await canConfigureLegacyApp(rpc, request.id))
  ) {
    throw Error("Codex did not report this app as accessible");
  }
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
