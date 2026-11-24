import {
  zcodeSkillsReferenceCatalogResultSchema,
  type ZCodeMcpServerStatusSnapshot,
} from "@zcode/shared";
import { z } from "zod";
import { type Gateway, type Message } from "./gateway.js";
import { array, rec, str } from "./nativeValues.js";
import { nativePluginManagement } from "./nativePluginManagement.js";

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
    const reply = await call("skills/list", {
      cwds: [cwd],
      ...(method === "listSkills" ? { forceReload: true } : {}),
    });
    const batches = array(reply.data);
    const batch =
      batches.find((group) => group.cwd === cwd) ?? (batches.length === 1 ? batches[0] : undefined);
    const skillsByPath = new Map(
      array(batch?.skills).flatMap((item) => {
        const path = str(item.path);
        const name = str(item.name);
        const pluginId = str(item.pluginId);
        const pluginName = pluginId.split("@")[0];
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
              ...(pluginId ? { pluginId, pluginName } : {}),
              ...(item.scope === "system" || item.scope === "admin"
                ? { codexScope: item.scope }
                : {}),
            },
          ],
        ];
      }),
    );
    const skills = [...skillsByPath.values()];
    if (method === "getSkillReferenceCatalog")
      return zcodeSkillsReferenceCatalogResultSchema.parse({
        authority: "workspace",
        skills: skills
          .filter((x) => x.enabled)
          .map(({ id, name, description, path, scope, enabled, pluginName }) => ({
            id,
            name,
            description,
            path,
            scope,
            enabled,
            pluginName,
          })),
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
  if (method === "setSkillEnabled") {
    const path = str(p.skillId);
    if (!path.startsWith("/") || typeof p.enabled !== "boolean")
      throw Error("Codex skill enablement requires an absolute skill path and a boolean value.");
    const result = await call("skills/config/write", { path, enabled: p.enabled });
    if (typeof result.effectiveEnabled === "boolean" && result.effectiveEnabled !== p.enabled)
      throw Error("The SSH host’s Codex policy overrides this skill setting.");
    return;
  }
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
  return nativePluginManagement(g, id, cwd, method, p, call);
}
