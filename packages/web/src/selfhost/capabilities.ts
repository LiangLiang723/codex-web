import {
  zcodePluginsReferenceCatalogResultSchema,
  zcodeSkillsReferenceCatalogResultSchema,
  zcodePluginsOverviewResultSchema,
  zcodePluginsListResultSchema,
} from "@zcode/shared";
import { z } from "zod";
import { type Gateway, type Message } from "./gateway.js";
import { array, rec, str } from "./threadProjection.js";
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
    const batch = array(reply.data).find((group) => group.cwd === cwd) ?? array(reply.data)[0];
    const skills = array(batch?.skills)
      .map((item) => ({
        id: str(item.path),
        name: str(item.name),
        description: str(item.description),
        path: str(item.path),
        scope: item.scope === "repo" ? "workspace" : item.scope === "plugin" ? "plugin" : "user",
        enabled: item.enabled !== false,
      }))
      .filter((item) => item.id && item.name);
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
    const statuses: Message = {};
    let cursor: string | null = null;
    do {
      const page = await call("mcpServerStatus/list", { cursor, limit: 100 });
      for (const server of array(page.data)) {
        statuses[str(server.name)] = {
          status: "connected",
          toolCount: Object.keys(rec(server.tools)).length,
          tools: server.tools,
          resources: server.resources,
          resourceTemplates: server.resourceTemplates,
          updatedAt: new Date().toISOString(),
          authStatus: server.authStatus,
        };
      }
      cursor = str(page.nextCursor) || null;
    } while (cursor);
    return { statuses };
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
  const result = await call("plugin/list", { cwds: [cwd] }),
    markets = array(result.marketplaces);
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
    // The original picker inspects conflict IDs immediately after the asynchronous catalog resolves.
    // A marketplace summary and a reference entry are distinct ZCode protocol DTOs.
    const enabled = entries.filter((item) => item.enabled);
    const plugins = enabled.map((item) => ({
      pluginId: item.id,
      name: item.name,
      marketplace: item.marketplace,
      description: item.description,
      enabled: true,
      conflictingPluginIds: enabled
        .filter((other) => other.id !== item.id && other.name === item.name)
        .map((other) => other.id),
      skillQualifiedNames: [] as string[],
      mcpServerNames: [] as string[],
      subagentNames: [] as string[],
    }));
    await Promise.all(
      Array.from({ length: Math.min(4, plugins.length) }, async (_, lane) => {
        for (let index = lane; index < plugins.length; index += 4) {
          const entry = plugins[index];
          if (!entry) continue;
          const market = markets.find((m) => m.name === entry.marketplace);
          if (!market) continue;
          const key = JSON.stringify([id, cwd, entry.pluginId]);
          const info = await cachedPluginDetail(g, key, () =>
            call("plugin/read", {
              pluginName: entry.name,
              ...(market.path
                ? { marketplacePath: market.path }
                : { remoteMarketplaceName: market.name }),
            }),
          );
          const detail = rec(info.plugin ?? info);
          entry.skillQualifiedNames = array(detail.skills)
            .filter((s) => s.enabled !== false)
            .map((s) => entry.name + ":" + str(s.name))
            .filter((name) => !name.endsWith(":"));
          entry.mcpServerNames = Array.isArray(detail.mcpServers)
            ? detail.mcpServers
                .map((s) => (typeof s === "string" ? s : str(rec(s).name)))
                .filter(Boolean)
            : Object.keys(rec(detail.mcpServers));
        }
      }),
    );
    return zcodePluginsReferenceCatalogResultSchema.parse({ authority: "workspace", plugins });
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
type DetailCache = Map<string, { expires: number; value: Promise<Message> }>;
const details = new WeakMap<Gateway, DetailCache>();
function cachedPluginDetail(gateway: Gateway, key: string, read: () => Promise<Message>) {
  const cache = details.get(gateway) ?? new Map();
  details.set(gateway, cache);
  const existing = cache.get(key);
  if (existing && existing.expires > Date.now()) return existing.value;
  const value = read().catch((error) => {
    cache.delete(key);
    throw error;
  });
  if (cache.size > 400) cache.delete(cache.keys().next().value!);
  cache.set(key, { expires: Date.now() + 60000, value });
  return value;
}
