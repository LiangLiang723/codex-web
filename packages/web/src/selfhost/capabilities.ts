import {
  zcodeSkillsReferenceCatalogResultSchema,
  type SkillsListResult,
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

const nativeSkillsReply = z.object({
  data: z.array(
    z.object({
      cwd: z.string(),
      skills: z.array(
        z.object({
          path: z.string().min(1),
          name: z.string().min(1),
          description: z.string(),
          shortDescription: z.string().nullish(),
          scope: z.enum(["user", "repo", "system", "admin"]),
          enabled: z.boolean(),
          pluginId: z.string().nullish(),
          interface: z
            .object({ displayName: z.string().nullish(), shortDescription: z.string().nullish() })
            .nullish(),
          dependencies: z
            .object({
              tools: z.array(
                z.object({
                  type: z.string(),
                  value: z.string(),
                  description: z
                    .string()
                    .nullish()
                    .transform((value) => value ?? undefined),
                }),
              ),
            })
            .nullish(),
        }),
      ),
      errors: z.array(z.object({ path: z.string(), message: z.string() })),
    }),
  ),
});

function projectNativeSkills(reply: Message, cwd: string): SkillsListResult {
  const parsed = nativeSkillsReply.safeParse(reply);
  if (!parsed.success) throw Error("Codex returned an invalid skill directory.");
  const batches = parsed.data.data;
  const batch =
    batches.find((entry) => entry.cwd === cwd) ?? (batches.length === 1 ? batches[0] : undefined);
  if (!batch) throw Error("Codex returned no skill directory for the selected SSH workspace.");
  const skills = new Map<string, SkillsListResult["skills"][number]>();
  for (const item of batch.skills) {
    const pluginId = item.pluginId || undefined;
    // 插件技能也可能标记为 user。完整插件 ID 表示归属，始终按原生路径区分同名技能。
    skills.set(item.path, {
      id: item.path,
      path: item.path,
      name: item.name,
      description: item.description,
      body: "",
      displayName: item.interface?.displayName?.trim() || undefined,
      shortDescription:
        item.interface?.shortDescription?.trim() || item.shortDescription?.trim() || undefined,
      scope: pluginId ? "plugin" : item.scope === "repo" ? "workspace" : "user",
      enabled: item.enabled,
      pluginId,
      pluginName: pluginId?.split("@")[0],
      codexScope: item.scope,
      codexToolDependencies: item.dependencies?.tools,
    });
  }
  return {
    skills: [...skills.values()],
    diagnostics: batch.errors.map(({ path, message }) => ({
      code: "skill_read_failed",
      severity: "error",
      path,
      message,
    })),
    capability: { userScopeAvailable: true },
  };
}

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
    const listing = projectNativeSkills(reply, cwd);
    if (method === "listSkills") return listing;
    return zcodeSkillsReferenceCatalogResultSchema.parse({
      authority: "workspace",
      skills: listing.skills
        .filter((skill) => skill.enabled)
        .map(
          ({
            id,
            name,
            description,
            displayName,
            shortDescription,
            path,
            scope,
            enabled,
            pluginName,
            codexScope,
            pluginId,
          }) => ({
            id,
            name,
            description,
            displayName,
            shortDescription,
            path,
            scope,
            enabled,
            pluginName,
            codexScope,
            pluginId,
          }),
        ),
    });
  }
  if (method === "setSkillEnabled") {
    const path = str(p.skillId);
    if (!path.startsWith("/") || typeof p.enabled !== "boolean")
      throw Error("Codex skill enablement requires an absolute skill path and a boolean value.");
    const result = await call("skills/config/write", { path, enabled: p.enabled });
    if (typeof result.effectiveEnabled !== "boolean")
      throw Error("Codex did not confirm the skill setting.");
    if (result.effectiveEnabled !== p.enabled)
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
