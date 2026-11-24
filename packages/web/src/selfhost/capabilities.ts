import {
  zcodePluginsReferenceCatalogResultSchema,
  zcodeSkillsReferenceCatalogResultSchema,
  zcodePluginsOverviewResultSchema,
  zcodePluginsListResultSchema,
  type ZCodeMcpServerStatusSnapshot,
} from "@zcode/shared";
import { z } from "zod";
import { type Gateway, type Message } from "./gateway.js";
import { array, rec, str } from "./nativeValues.js";

function projectMcpServerStatus(server: Message, updatedAt: string): ZCodeMcpServerStatusSnapshot {
  const snapshot: Omit<ZCodeMcpServerStatusSnapshot, "status"> = {
    transport: str(server.httpOrigin) ? "http" : "stdio",
    toolCount: Object.keys(rec(server.tools)).length,
    updatedAt,
  };
  switch (server.runtimeStatus) {
    case "disabled":
      return { ...snapshot, status: "disabled" };
    case "starting":
      return { ...snapshot, status: "connecting" };
    case "notStarted":
    case "cancelled":
      return { ...snapshot, status: "disconnected" };
  }
  const error = str(server.toolsError);
  const needsAuth =
    server.runtimeStatus === "authenticationRequired" || server.authStatus === "notLoggedIn";
  let failureKind: ZCodeMcpServerStatusSnapshot["failureKind"];
  if (needsAuth) failureKind = "not_authenticated";
  else if (error) failureKind = "tool_list_failed";
  else if (server.runtimeStatus === "failed") failureKind = "connection_failed";
  if (failureKind) {
    return {
      ...snapshot,
      status: "failed",
      failureKind,
      ...(error ? { error } : {}),
    };
  }
  // Codex 在无会话上下文时返回空运行状态，旧响应也可能省略该字段。
  // 已初始化服务或工具目录能提供连接证据，单凭注册名称无法确认连接。
  const discovered =
    server.runtimeStatus == null &&
    (snapshot.toolCount > 0 || server.serverInfo != null || server.serverCapabilities != null);
  return {
    ...snapshot,
    status: server.runtimeStatus === "connected" || discovered ? "connected" : "disconnected",
  };
}

export const codexRequest = async (g: Gateway, hostId: number, method: string, params: Message) => {
  const { value } = await g.request(
    "/api/selfhost/capability",
    z.object({ value: z.unknown() }),
    "POST",
    { hostId, method, params },
  );
  return rec(value);
};
export async function extensionRequest(
  g: Gateway,
  id: number,
  cwd: string,
  method: string,
  p: Message,
): Promise<unknown> {
  const call = (name: string, params: Message) => codexRequest(g, id, name, params);
  if (method === "getSkillReferenceCatalog" || method === "listSkills") {
    const reply = await call("skills/list", { cwds: [cwd] });
    const batches = array(reply.data);
    const batch =
      batches.find((group) => group.cwd === cwd) ?? (batches.length === 1 ? batches[0] : undefined);
    const skillsByPath = new Map(
      array(batch?.skills).flatMap((item) => {
        const path = str(item.path);
        const name = str(item.name);
        const pluginId = str(item.pluginId);
        if (!path || !name) return [];
        return [
          [
            path,
            {
              id: path,
              name,
              description: str(item.description),
              path,
              scope:
                pluginId || item.scope === "plugin"
                  ? "plugin"
                  : item.scope === "repo"
                    ? "workspace"
                    : "user",
              enabled: item.enabled === true,
              ...(pluginId ? { pluginName: pluginId } : {}),
            },
          ],
        ];
      }),
    );
    const skills = [...skillsByPath.values()];
    if (method === "getSkillReferenceCatalog")
      return zcodeSkillsReferenceCatalogResultSchema.parse({
        authority: "workspace",
        skills: skills.filter((x) => x.enabled),
      });
    return {
      skills: skills.map((skill) => ({ ...skill, body: "" })),
      diagnostics: array(batch?.errors).map((e) => ({
        code: "skill_read_failed",
        severity: "error",
        message: str(e.message),
        path: str(e.path),
      })),
      capability: { userScopeAvailable: true },
    };
  }
  if (method === "setSkillEnabled")
    return call("skills/config/write", { path: p.path ?? p.skillId, enabled: p.enabled });
  if (method === "listMcpServerStatuses") {
    const statuses = new Map<string, ZCodeMcpServerStatusSnapshot>();
    let cursor: string | null = null;
    do {
      const page = await call("mcpServerStatus/list", { cursor, limit: 100 });
      const updatedAt = new Date().toISOString();
      for (const server of array(page.data)) {
        const name = str(server.name);
        if (name) statuses.set(name, projectMcpServerStatus(server, updatedAt));
      }
      cursor = str(page.nextCursor) || null;
    } while (cursor);
    return { statuses: Object.fromEntries(statuses) };
  }
  const mutation: Record<string, [string, Message]> = {
    addPluginMarketplace: ["marketplace/add", { source: p.source }],
    removePluginMarketplace: ["marketplace/remove", { marketplaceName: p.marketplace }],
    updatePluginMarketplace: ["marketplace/upgrade", { marketplaceName: p.marketplace }],
    uninstallPlugin: ["plugin/uninstall", { pluginId: p.pluginId ?? p.id ?? p.pluginName }],
  };
  if (mutation[method]) {
    if (p.dryRun) return { requiresConfirmation: true, source: p.source };
    const [name, params] = mutation[method];
    return call(name, params);
  }
  const installedOnly = method === "getPluginReferenceCatalog" || method === "listPlugins";
  const dirs = { cwds: [cwd] };
  const result = installedOnly
    ? await call("plugin/installed", dirs).catch((error) => {
        // Older app-servers expose only plugin/list. Keep mention discovery local there too.
        if (
          !/method not found|unknown (method|variant)|unsupported method|-32601/i.test(
            String(error),
          )
        )
          throw error;
        return call("plugin/list", { ...dirs, marketplaceKinds: ["local"] });
      })
    : await call("plugin/list", dirs);
  const markets = array(result.marketplaces);
  const marketplaces = markets.map((m) => ({
    id: str(m.name),
    name: str(m.name),
    source: m.path ? { type: "directory", path: m.path } : { type: "remote", name: m.name },
    pluginCount: array(m.plugins).length,
  }));
  const entries = markets.flatMap((m) =>
    array(m.plugins).map((a) => ({
      id: str(a.id),
      name: str(a.name),
      marketplace: str(m.name),
      description: str(rec(a.interface).shortDescription),
      displayName: str(rec(a.interface).displayName) || undefined,
      version: str(a.version),
      enabled: a.enabled === true,
      installed: a.installed === true,
      source: str(m.path) || str(m.name),
      scope: "user",
    })),
  );
  if (method === "installPlugin" || method === "getPluginDetail") {
    const market = markets.find((m) => m.name === p.marketplace);
    const name = p.pluginName ?? p.name ?? entries.find((a) => a.id === p.pluginId)?.name;
    if (!market || !name) throw Error("找不到插件市场或插件");
    return call(method === "installPlugin" ? "plugin/install" : "plugin/read", {
      pluginName: name,
      ...(market.path ? { marketplacePath: market.path } : { remoteMarketplaceName: market.name }),
    });
  }
  const diagnostics = array(result.marketplaceLoadErrors).map((e) => ({
    message: str(e.message) || str(e.error) || "插件市场读取失败",
    source: str(e.marketplaceName) || "codex",
  }));
  if (method === "getPluginReferenceCatalog") {
    // 预读 Skills 或逐项详情曾让一个独立服务故障挡住整个加号。这里直接用原生
    // 已安装摘要，以 Codex 的完整 pluginId 区分跨市场同名插件。
    const byId = new Map(
      entries.flatMap((item) =>
        item.enabled && item.installed && item.id && item.name && item.marketplace
          ? [
              [
                item.id,
                {
                  pluginId: item.id,
                  name: item.name,
                  marketplace: item.marketplace,
                  description: item.description,
                  displayName: item.displayName,
                  enabled: true,
                  conflictingPluginIds: [],
                  skillQualifiedNames: [],
                  mcpServerNames: [],
                },
              ],
            ]
          : [],
      ),
    );
    return zcodePluginsReferenceCatalogResultSchema.parse({
      authority: "workspace",
      plugins: [...byId.values()],
    });
  }
  if (method === "listPlugins")
    return zcodePluginsListResultSchema.parse({
      plugins: entries
        .filter((a) => a.installed)
        .map(({ id, name, marketplace, description, version, enabled, source }) => ({
          id,
          name,
          marketplace,
          description,
          version,
          enabled,
          source,
        })),
      diagnostics: diagnostics.map((d) => ({
        code: "marketplace_load_failed",
        message: d.message,
        severity: "warning",
      })),
    });
  const availablePlugins = entries.map(
    ({ id, name, marketplace, description, version, installed }) => ({
      id,
      name,
      marketplace,
      description,
      version,
      installed,
    }),
  );
  const installedPlugins = entries
    .filter((a) => a.installed)
    .map(({ id, name, marketplace, description, version, enabled }) => ({
      id,
      name,
      marketplace,
      description,
      version,
      enabled,
      scope: "user",
    }));
  return zcodePluginsOverviewResultSchema.parse({
    marketplaces,
    availablePlugins,
    installedPlugins,
    restorableBuiltins: [],
    diagnostics: diagnostics.map((d) => ({
      code: "marketplace_load_failed",
      message: d.message,
      severity: "warning",
    })),
    capability: { supported: true },
  });
}
