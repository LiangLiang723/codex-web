import { RemoteServiceAccess } from "@zcode/client";
import { appSettingsSchema, type AgentsListResult } from "@zcode/shared";
import type { IChannel, IChannelClient } from "@zcode/rpc";
import { z } from "zod";
import { Gateway, type Message, type Project, type RemoteModel } from "./gateway.js";
import { rec, str, array, num, providerId } from "./threadProjection.js";
import { codexRequest, extensionRequest } from "./capabilities.js";
import { createCodexAppsService } from "./codexApps.js";
import { FileWatches } from "./fileWatches.js";
import { AttachmentBridge } from "./attachments.js";
import { shareOperation } from "./shares.js";
import { SessionBridge } from "./sessionBridge.js";
import {
  decodeTerminalStreamFrame,
  decodeTerminalTextPayload,
} from "virtual:gateway-terminal-stream";

const settingsSchema = z.record(z.string(), z.unknown());
const remoteChannels = new Set(["file", "system", "git", "memory", "commands", "output-style"]);
function modelView(models: RemoteModel[], preference: unknown, hostDefault: Message = {}) {
  const input = rec(preference);
  const model =
    models.find((v) => v.model === input.modelId) ??
    models.find((v) => v.model === hostDefault.model) ??
    models.find((v) => v.isDefault) ??
    models[0];
  const efforts = model?.supportedReasoningEfforts?.map((e) => e.reasoningEffort) ?? [];
  const reasoningLevel =
    [
      model?.model === input.modelId ? str(rec(input.options).reasoningLevel) : "",
      model?.model === hostDefault.model ? str(hostDefault.effort) : "",
      model?.defaultReasoningEffort,
      efforts[0],
    ].find((value) => value && (!efforts.length || efforts.includes(value))) ?? "";
  const selection = model
    ? {
        providerId,
        modelId: model.model,
        options: reasoningLevel ? { reasoningLevel } : {},
      }
    : undefined;
  return {
    revision: 1,
    providers: [
      {
        providerId,
        providerName: "OpenAI Codex",
        config: { enabled: true, api: { type: "codex-app-server" } },
        models: models.map((m) => ({
          modelId: m.model,
          config: {
            enabled: true,
            properties: { inputFormat: { supportsImage: m.inputModalities?.includes("image") } },
            optionSpecs: {
              reasoningLevel: {
                values: m.supportedReasoningEfforts?.map((e) => e.reasoningEffort) ?? [],
              },
            },
          },
        })),
      },
    ],
    preferredSelection: selection,
    effectiveSelection: selection,
  };
}
function projectForDirectory(projects: Project[], directory: unknown) {
  if (typeof directory !== "string") return;
  const path = directory.replace(/\/$/, "") || "/";
  let best: Project | undefined,
    score = -1;
  for (const project of projects)
    for (const alias of project.aliases ?? [project.remotePath]) {
      const root = alias.replace(/\/$/, "") || "/";
      if (
        (path === root || path.startsWith(root === "/" ? "/" : root + "/")) &&
        root.length > score
      ) {
        best = project;
        score = root.length;
      }
    }
  return best;
}
function projectRow(project: Project, position: number) {
  return {
    id: project.id ?? project.remotePath,
    hostId: "local",
    name: project.name,
    nameOverridden: true,
    roots: (project.roots ?? [project.remotePath]).map((rootPath, index) => ({
      rootPath,
      isPrimary: index === 0,
      position: index,
    })),
    position,
    pinned: false,
    deleted: false,
    createdAt: 0,
    updatedAt: 0,
  };
}

export function readWorkspaceSettings(gateway: Gateway) {
  return gateway.request("/api/selfhost/settings", settingsSchema);
}

export async function openWorkspace(
  gateway: Gateway,
  hostId: number,
  cwd: string,
  manage: () => void,
  onThreadDeleted?: (threadId: string) => void,
  initialPreferences?: Promise<Message>,
) {
  // 模型目录可单独失败，文件和可读历史不以 model/list 成功作为工作区挂载条件。
  let preferences = await (initialPreferences ?? readWorkspaceSettings(gateway));
  const models: RemoteModel[] = [];
  const catalogs = new Map<string, Promise<RemoteModel[]>>();
  function catalog(provider = "") {
    const known = catalogs.get(provider);
    if (known) return known;
    const request = gateway
      .models(hostId, provider || undefined)
      .then((rows) => {
        if (!provider && catalogs.get(provider) === request)
          models.splice(0, models.length, ...rows);
        return rows;
      })
      .catch((error) => {
        if (catalogs.get(provider) === request) catalogs.delete(provider);
        throw error;
      });
    catalogs.set(provider, request);
    return request;
  }
  const projectDefaults = new Map<string, Promise<Message>>();
  let directoryLookup: Promise<string> | undefined;
  const workspaceDirectory = () =>
    (directoryLookup ??= gateway
      .request("/api/selfhost/workspace", z.object({ value: z.string().startsWith("/") }), "POST", {
        hostId,
        channel: "system",
        method: "resolveDirectory",
        args: [{ path: cwd }],
      })
      .then(({ value }) => value)
      .catch(() => {
        directoryLookup = undefined;
        return cwd;
      }));
  function defaultModelView(path: string, selection: unknown, provider?: string) {
    let pending = projectDefaults.get(path);
    if (!pending) {
      // model/list 默认强度是目录里的推荐值，Codex 自己的分层配置可能不同。
      pending = gateway
        .call("project.defaults.read", { hostId, cwd: path })
        .then((value) => rec(value.defaults))
        .catch(() => {
          projectDefaults.delete(path);
          return {};
        });
      projectDefaults.set(path, pending);
    }
    return pending.then(async (defaults) =>
      modelView(await catalog(provider || str(defaults.modelProvider)), selection, defaults),
    );
  }
  let providerRevision = 0;
  type Listener = { arg: unknown; fn: (value: unknown) => void };
  const listeners = new Map<string, Set<Listener>>();
  // ZCode subscribes after create() resolves. Retain the snapshot and any intervening PTY output.
  const terminalSessions = new Map<string, string | null>();
  let terminalGeneration = 0;
  let terminalRecovery: Promise<void> | undefined;
  const emit = (channel: string, event: string, value: unknown, target?: unknown) => {
    for (const entry of listeners.get(channel + "." + event) ?? [])
      if (target === undefined || target === entry.arg) entry.fn(value);
  };
  function recoverTerminals() {
    const generation = ++terminalGeneration;
    const openedIds = [...terminalSessions.keys()];
    if (!openedIds.length) return Promise.resolve();
    return gateway.call("terminal.list").then((reply) => {
      if (generation !== terminalGeneration) return;
      if (!Array.isArray(reply.sessions)) throw Error("远程终端列表不可用");
      const alive = new Set(
        array(reply.sessions)
          .filter((s) => s.hostId === hostId)
          .map((s) => s.sessionId),
      );
      for (const id of openedIds) {
        if (!alive.has(id) && terminalSessions.delete(id))
          emit("terminal", "onDynamicExit", null, id);
      }
    });
  }
  const fileWatches = new FileWatches(gateway, hostId, (id, event) =>
    emit("file-watcher", "onDynamicChange", event, id),
  );
  const uploads = new AttachmentBridge(gateway, hostId);
  const bridges = new Map<string, SessionBridge>();
  const scopedBridge = (path: unknown) => {
    const target = typeof path === "string" && path.startsWith("/") ? path : cwd;
    let bridge = bridges.get(target);
    if (!bridge) {
      bridge = new SessionBridge(
        gateway,
        hostId,
        target,
        models,
        emit,
        async (projectId) =>
          (await gateway.projects(hostId)).find((project) => project.nativeId === projectId)
            ?.nativeId,
        catalog,
      );
      bridges.set(target, bridge);
    }
    return bridge;
  };
  const bridge = scopedBridge(cwd);
  let disposed = false;
  const publishDeletion = (taskId: string) => {
    for (const scope of bridges.values()) scope.tasks.invalidate(taskId);
    emit("broadcast", "onMessage", { channel: "selfhost:thread-deleted", payload: { taskId } });
    onThreadDeleted?.(taskId);
  };
  let lastList = "";
  let polling = false;
  const refreshIndex = async () => {
    if (document.hidden || polling) return;
    polling = true;
    try {
      const page = await bridge.tasks.page({ sortKey: "updated_at" }, 25);
      const signature = JSON.stringify(
        page.data.slice(0, 25).map((t) => [t.id, t.title, t.updatedAt, t.status]),
      );
      if (lastList && signature !== lastList)
        emit("broadcast", "onMessage", { channel: "state:projects", payload: {} });
      lastList = signature;
    } catch {
    } finally {
      polling = false;
    }
  };
  void refreshIndex();
  const poll = setInterval(() => void refreshIndex(), 7000);
  document.addEventListener("visibilitychange", refreshIndex);
  const disposers = [
    () => {
      clearInterval(poll);
      document.removeEventListener("visibilitychange", refreshIndex);
    },
    gateway.onTerminal((buffer) => {
      const frame = decodeTerminalStreamFrame(new Uint8Array(buffer));
      if (!frame) return;
      const data = decodeTerminalTextPayload(frame);
      if (data === null) return;
      const early = terminalSessions.get(frame.sessionId);
      if (typeof early === "string")
        terminalSessions.set(frame.sessionId, (early + data).slice(-65536));
      else if (early === null) emit("terminal", "onDynamicData", data, frame.sessionId);
    }),
    gateway.on((msg) => {
      if (msg.type === "disconnected") terminalGeneration++;
      if (msg.type === "ready") {
        terminalRecovery = recoverTerminals();
        void terminalRecovery.catch(() => {});
      }
      if (msg.type === "terminal.exited" || msg.type === "terminal.closed.event") {
        if (terminalSessions.delete(str(msg.sessionId)))
          emit("terminal", "onDynamicExit", num(msg.code), msg.sessionId);
      }
      if (msg.type === "config.pinnedThreads.changed") {
        emit("broadcast", "onMessage", { channel: "state:projects", payload: {} });
        emit("zcode-task", "onDynamicWorkspaceEvent", {
          type: "workspace_task_list_changed",
          workspacePath: cwd,
        });
      }
      if (msg.type === "ready") {
        projectDefaults.clear();
        directoryLookup = undefined;
      }
      if (msg.type === "config.catalog.changed") {
        const deleted = rec(msg.deleted);
        if (deleted.hostId === hostId && typeof deleted.threadId === "string")
          publishDeletion(deleted.threadId);
        else bridge.tasks.invalidate();
        emit("broadcast", "onMessage", { channel: "state:projects", payload: {} });
        void readWorkspaceSettings(gateway)
          .then((v) => {
            preferences = v;
            emit("setting", "onDidChange", appSettingsSchema.parse(v));
          })
          .catch(() => {});
      }
    }),
  ];
  async function rpc(channel: string, method: string, args: unknown[]): Promise<unknown> {
    const p = rec(args[0]);
    if (channel === "hooks" && method === "listNativeHooks") {
      const path = str(p.workspacePath) || cwd;
      const reply = await codexRequest(gateway, hostId, "hooks/list", { cwds: [path] });
      const { data } = z
        .object({
          data: z
            .array(
              z.object({
                hooks: z.array(
                  z.object({
                    key: z.string(),
                    eventName: z.string(),
                    sourcePath: z.string(),
                    enabled: z.boolean(),
                  }),
                ),
                warnings: z.array(z.string()),
                errors: z.array(z.object({ path: z.string(), message: z.string() })),
              }),
            )
            .length(1),
        })
        .parse(reply);
      const scope = data[0]!;
      return {
        hooks: scope.hooks,
        diagnostics: [
          ...scope.warnings,
          ...scope.errors.map(({ path, message }) => `${path} · ${message}`),
        ],
      };
    }
    if (channel === "coding-plan-subscription" && method === "getDynamicWorkflowClientConfig")
      return { mode: "disabled", enabled: false, source: "default" };
    if (channel === "zcode-agent" && method === "listSavedWorkflowRuns") return { runs: [] };
    if (channel === "subagents" && method === "list") {
      // App Server 提供会话内的子智能体活动。原生配置目录缺少列表接口时返回不可用能力。
      return {
        agents: [],
        userAgents: [],
        pluginAgents: [],
        capability: { userScopeAvailable: false },
      } satisfies AgentsListResult;
    }
    if (channel === "mcp-sync" && method === "listWorkspaceMcpServerStatuses")
      return extensionRequest(
        gateway,
        hostId,
        str(p.workspacePath) || cwd,
        "listMcpServerStatuses",
        p,
      );
    if (
      (channel === "zcode-agent" || channel === "plugin-management" || channel === "plugins") &&
      [
        "getPluginsOverview",
        "getOverview",
        "listPlugins",
        "getPluginReferenceCatalog",
        "getPluginDetail",
        "describePlugin",
        "addPluginMarketplace",
        "removePluginMarketplace",
        "updatePluginMarketplace",
        "installPlugin",
        "uninstallPlugin",
        "setPluginEnabled",
        "updatePlugin",
        "getSkillReferenceCatalog",
        "listMcpServerStatuses",
      ].includes(method)
    )
      return extensionRequest(gateway, hostId, str(p.workspacePath) || cwd, method, p);
    if (channel === "skills") {
      if (method === "list" || method === "setEnabled")
        return extensionRequest(
          gateway,
          hostId,
          str(p.workspacePath) || cwd,
          method === "setEnabled" ? "setSkillEnabled" : "listSkills",
          p,
        );
      throw Error("This skill operation is unavailable on the selected Codex host.");
    }
    if (
      channel === "zcode-agent" &&
      [
        "listSavedWorkflows",
        "getSavedWorkflow",
        "updateSavedWorkflowMeta",
        "deleteSavedWorkflow",
        "moveSavedWorkflow",
      ].includes(method)
    ) {
      const response = await gateway.request(
        "/api/selfhost/workspace",
        z.object({ value: z.unknown().optional() }),
        "POST",
        {
          hostId: hostId,
          channel: "workflows",
          method,
          args: [{ ...p, cwd: str(p.workspacePath) || cwd }],
        },
      );
      return response.value;
    }
    if (remoteChannels.has(channel)) {
      const response = await gateway.request(
        "/api/selfhost/workspace",
        z.object({ value: z.unknown().optional() }),
        "POST",
        { hostId: hostId, channel, method, args },
      );
      if (channel === "file" && method === "readFileRange") {
        const b = str(rec(response.value).binary);
        return Uint8Array.from(atob(b), (v) => v.charCodeAt(0));
      }
      return response.value;
    }
    if (channel === "setting") {
      if (method === "get") return appSettingsSchema.parse(preferences);
      if (method === "getUserInstructions" || method === "saveUserInstructions") {
        if (disposed) throw Error("SSH 工作区已切换，请重新打开设置");
        const response = await gateway.request(
          "/api/selfhost/workspace",
          z.object({
            value: z.object({
              content: z.string().optional(),
              filePath: z.string().startsWith("/"),
            }),
          }),
          "POST",
          {
            hostId,
            channel: "user-instructions",
            method: method === "getUserInstructions" ? "get" : "save",
            args,
          },
        );
        if (method === "getUserInstructions" && typeof response.value.content !== "string")
          throw Error("Codex 指令读取结果无效");
        return response.value;
      }
      if (method === "update") {
        preferences = await gateway.request("/api/selfhost/settings", settingsSchema, "PATCH", p);
        emit("setting", "onDidChange", appSettingsSchema.parse(preferences));
        return;
      }
    }
    if (channel === "broadcast" && method === "send") {
      emit(channel, "onMessage", args[0]);
      return;
    }
    if (channel === "model-selection" && method === "getView")
      return defaultModelView(
        str(p.workspacePath) || cwd,
        p.selection ?? preferences.defaultModelSelection,
        str(p.nativeModelProvider),
      );
    if (channel === "provider-settings" && (method === "getView" || method === "refresh")) {
      if (method === "refresh") {
        // 工作区设置的刷新必须重新查询当前 SSH 主机的原生目录。
        catalogs.clear();
        projectDefaults.delete(cwd);
        providerRevision++;
      }
      const revision = providerRevision;
      const selection = await defaultModelView(cwd, undefined);
      const view = {
        revision,
        providerTemplates: [],
        providerOrder: [providerId],
        providers: selection.providers.map(
          ({ providerId: id, providerName, config, models: entries }) => ({
            providerId: id,
            providerName,
            enabled: true,
            executable: entries.length > 0,
            effectiveBuiltinConfig: config,
            effectiveConfig: config,
            issues: [],
            models: entries.map(({ modelId, config: modelConfig }) => ({
              kind: "candidate",
              modelId,
              builtin: true,
              effectiveBuiltinConfig: modelConfig,
              effectiveConfig: modelConfig,
              enabled: true,
              executable: true,
              selectable: true,
              issues: [],
            })),
          }),
        ),
      };
      if (method === "refresh" && revision === providerRevision)
        emit("provider-settings", "onDidChange", view);
      return view;
    }
    if (
      channel === "zcode-agent" &&
      (method === "getSessionLifecycle" || method === "ensureSessionReady")
    )
      return scopedBridge(p.workspacePath).lifecycle(str(p.sessionId));
    if (channel === "zcode-agent" && /^attachment(Begin|Chunk|Commit|Abort)V4$/.test(method))
      return uploads.handle(method, p);
    if (channel === "zcode-agent" && (method.endsWith("V4") || method === "listSessionSubagents"))
      return scopedBridge(p.workspacePath).handle(method, p);
    if (channel === "oauth") {
      if (method === "getProviders") return [];
      if (method === "restoreCachedSessionState") return { status: "none", user: null };
      if (
        [
          "getWebsiteSession",
          "getActiveProvider",
          "restoreSession",
          "restoreCachedSession",
          "pollPendingOAuth",
        ].includes(method)
      )
        return null;
      if (method === "getAccountAvailability") return { china: false, global: false };
    }
    if (channel === "project") {
      if (method === "readTree") {
        const [catalog, activeThreads, archivedThreads, currentDirectory] = await Promise.all([
          gateway.projectCatalog(hostId),
          bridge.tasks.threads(),
          bridge.tasks.threads(undefined, undefined, true),
          workspaceDirectory(),
        ]);
        const threads = [
          ...new Map([...activeThreads, ...archivedThreads].map((t) => [str(t.id), t])).values(),
        ];
        const projects = catalog.items;
        const byId = new Map(
          projects.map((project) => [project.id ?? project.remotePath, project]),
        );
        return {
          projects: projects.map(projectRow),
          tasks: threads.map((t) => {
            // 老 Mac 只有项目被迁移到 app-server；使用已保存的桌面归属，
            // 否则从目录猜测会把手动移过项目的会话又显示到原目录。
            const stored = catalog.memberships[str(t.id)];
            const owner =
              typeof t.projectId === "string"
                ? byId.get(t.projectId)
                : stored === null
                  ? undefined
                  : stored !== undefined
                    ? byId.get(stored)
                    : projectForDirectory(projects, t.cwd);
            return {
              ...bridge.tasks.meta(t),
              hostId: "local",
              // 原生 cwd 可能是用户所选 SSH 路径的规范形式。导航身份保留所选项目，文件操作保留原生 cwd。
              workspacePath: t.cwd === currentDirectory ? cwd : str(t.cwd),
              cwd: str(t.cwd),
              projectId: owner ? (owner.id ?? owner.remotePath) : null,
              pinned: t.pinned === true,
              archived: t.archived === true,
            };
          }),
        };
      }
      const projects = await gateway.projects(hostId);
      if (method === "readProjects") return projects.map(projectRow);
      if (method === "prepareSession" || method === "resolveSessionDirectories") {
        const selected =
          p.projectId === null
            ? undefined
            : (projects.find((project) => (project.id ?? project.remotePath) === p.projectId) ??
              projectForDirectory(projects, p.workspacePath ?? cwd));
        const roots = selected?.roots ?? [];
        return {
          projectId: selected ? (selected.id ?? selected.remotePath) : null,
          workspacePath: selected?.remotePath ?? cwd,
          additionalDirectories: roots.slice(1),
        };
      }
      if (method === "readDirectory") {
        const path = str(p.path) || cwd;
        return {
          path,
          entries: await rpc("file", "readdir", [{ path, includeHidden: p.includeHidden }]),
        };
      }
      if (method === "saveProject") {
        const path = str(p.primaryRoot) || (Array.isArray(p.roots) ? str(p.roots[0]) : "");
        if (!path) throw Error("需要远程项目路径");
        const value = {
          hostId: hostId,
          remotePath: path,
          name: str(p.name) || path.split("/").pop() || path,
        };
        await gateway.request("/api/projects", z.unknown(), "POST", value);
        return projectRow(value, projects.length);
      }
    }
    if (channel === "file-watcher") {
      if (method === "watch") return fileWatches.watch(str(p.path), p.recursive === true);
      if (method === "unwatch") return fileWatches.unwatch(str(p.id));
      if (method === "disposeAll") return fileWatches.clear();
    }
    if (channel === "terminal") {
      if (method === "write" || method === "resize") {
        await gateway.connect();
        if (terminalRecovery) {
          try {
            await terminalRecovery;
          } catch {
            terminalRecovery = recoverTerminals();
            await terminalRecovery;
          }
        }
        if (!terminalSessions.has(str(p.id))) throw Error("SSH 终端已退出");
      }
      if (method === "create") {
        const response = await gateway.call("terminal.open", {
          hostId: hostId,
          scope: "project",
          cwd: str(p.cwd) || cwd,
          cols: p.cols,
          rows: p.rows,
        });
        const session = z
          .object({ sessionId: z.string().uuid(), output: z.string() })
          .parse(response.session);
        terminalSessions.set(session.sessionId, session.output.slice(-65536));
        return {
          id: session.sessionId,
          shell: "SSH",
          fontFamily: "monospace",
          fontFamilySource: "fallback",
        };
      }
      if (method === "write")
        return gateway.send({ type: "terminal.input", sessionId: p.id, data: p.data });
      if (method === "resize")
        return gateway.send({
          type: "terminal.resize",
          sessionId: p.id,
          cols: p.cols,
          rows: p.rows,
        });
      if (method === "dispose") {
        const id = str(p.id);
        if (!terminalSessions.has(id)) return;
        try {
          await gateway.call("terminal.close", { sessionId: id });
        } catch (error) {
          // The shell may have exited between the dispose request and the server lookup.
          if (!(error instanceof Error && error.message === "Terminal session not found"))
            throw error;
        }
        terminalSessions.delete(id);
        return;
      }
      if (method === "listTerminalIdsUnderPath") {
        const path = str(p.path);
        return array((await gateway.call("terminal.list")).sessions)
          .filter(
            (t) => t.hostId === hostId && (t.cwd === path || str(t.cwd).startsWith(path + "/")),
          )
          .map((s) => s.sessionId);
      }
    }
    if (channel === "window-controller" || channel === "zcode-task") {
      if (method === "initialize") return { available: true };
      if (method === "releaseWorkspacePreparation" || method === "syncTaskSessionBinding") return;
      const scope = str(p.workspacePath) || cwd;
      if (
        [
          "listTasks",
          "listTaskList",
          "listActiveTaskIds",
          "listArchivedTasks",
          "listPinnedTasks",
          "listPinnedTaskIds",
          "listDeletedTaskIds",
        ].includes(method)
      ) {
        return bridge.tasks.list(method, p);
      }
      if (method === "getTaskMeta") {
        const t = await bridge.tasks.point(str(p.taskId ?? rec(p.address).taskId));
        return t ? bridge.tasks.meta(t) : null;
      }
      if (method === "getTaskSessionFilePath") {
        const path = str((await bridge.tasks.point(str(p.taskId)))?.path);
        return { path: path || null, exists: Boolean(path) };
      }
      if (
        [
          "archiveTask",
          "unarchiveTask",
          "renameTask",
          "setTaskPinned",
          "setTaskUnread",
          "deleteTask",
        ].includes(method) ||
        (method === "mutateTask" &&
          ["pin", "archive", "rename", "mark-unread", "mark-read", "delete"].includes(
            str(rec(p.mutation).kind),
          ))
      ) {
        if (disposed) throw Error("SSH 工作区已切换，请重新选择会话");
        const outcome = await bridge.tasks.mutate(method, p);
        if (disposed) return outcome;
        if (method === "deleteTask" || rec(p.mutation).kind === "delete")
          publishDeletion(str(p.taskId ?? rec(p.address).taskId));
        emit("broadcast", "onMessage", { channel: "state:projects", payload: {} });
        return outcome;
      }
      if (method === "getTaskConfigOptions") return [];
      if (method === "getTaskModelSelection")
        return (await defaultModelView(scope, preferences.defaultModelSelection))
          .effectiveSelection;
    }
    if (
      channel === "task-groups" ||
      (channel === "zcode-agent" && method.toLowerCase().includes("automation"))
    ) {
      const result = await gateway.request(
        "/api/selfhost/organization",
        z.object({ value: z.unknown().optional() }),
        "POST",
        { hostId: hostId, cwd, channel, method, args },
      );
      return result.value;
    }
    if (channel === "remote-projects" && method === "readDirectory")
      return { hosts: [], entries: [] };
    if (channel === "remote-projects" && method.startsWith("list")) return [];
    if (channel === "conversation-share")
      return shareOperation(gateway, hostId, method, p, args[0]);
    if (channel === "selfhost" && method === "manage") {
      manage();
      return;
    }
    throw Error("当前远程服务不支持 " + channel + "." + method);
  }
  const client: IChannelClient = {
    getChannel<T extends IChannel>(channel: string): T {
      const api: IChannel = {
        call<T>(method: string, args: unknown[] = []): Promise<T> {
          return rpc(channel, method, args) as Promise<T>;
        },
        listen<T>(event: string, arg?: unknown) {
          return (listener: (v: T) => unknown) => {
            const key = channel + "." + event;
            const group = listeners.get(key) ?? new Set<Listener>();
            listeners.set(key, group);
            const entry = { arg, fn: listener as (v: unknown) => void };
            group.add(entry);
            if (channel === "terminal" && event === "onDynamicData" && typeof arg === "string") {
              const buffered = terminalSessions.get(arg);
              if (buffered !== undefined) terminalSessions.set(arg, null);
              if (buffered)
                queueMicrotask(() => {
                  if (group.has(entry)) entry.fn(buffered);
                });
            }
            return {
              dispose() {
                group.delete(entry);
                if (!group.size) listeners.delete(key);
              },
            };
          };
        },
      };
      return api as T;
    },
  };
  return {
    services: Object.assign(new RemoteServiceAccess(client), {
      codexAppsService: createCodexAppsService(gateway, hostId),
    }),
    dispose() {
      disposed = true;
      for (const bridge of bridges.values()) bridge.dispose();
      bridges.clear();
      fileWatches.dispose();
      disposers.forEach((fn) => fn());
      listeners.clear();
      terminalSessions.clear();
    },
  };
}
