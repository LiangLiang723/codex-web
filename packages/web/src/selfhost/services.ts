import { RemoteServiceAccess } from "@zcode/client";
import { appSettingsSchema } from "@zcode/shared";
import type { IChannel, IChannelClient } from "@zcode/rpc";
import { z } from "zod";
import { Gateway, type Host, type Message, type Project, type RemoteModel } from "./gateway.js";
import { rec, str, array, num, providerId } from "./threadProjection.js";
import { extensionRequest, codexRequest } from "./capabilities.js";
import { FileWatches } from "./fileWatches.js";
import { AttachmentBridge } from "./attachments.js";
import { shareOperation } from "./shares.js";
import { SessionBridge } from "./sessionBridge.js";
import {
  decodeTerminalStreamFrame,
  decodeTerminalTextPayload,
} from "virtual:gateway-terminal-stream";

const settingsSchema = z.record(z.string(), z.unknown());
const remoteChannels = new Set([
  "file",
  "system",
  "git",
  "memory",
  "skills",
  "commands",
  "output-style",
]);
function modelView(models: RemoteModel[], preference: unknown) {
  const input = rec(preference);
  const model =
    models.find((v) => v.model === input.modelId) ?? models.find((v) => v.isDefault) ?? models[0];
  const selection = model
    ? {
        providerId,
        modelId: model.model,
        options: {
          reasoningLevel:
            str(rec(input.options).reasoningLevel) || model.defaultReasoningEffort || "",
        },
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
    id: project.remotePath,
    hostId: "local",
    name: project.name,
    nameOverridden: true,
    roots: [{ rootPath: project.remotePath, isPrimary: true, position: 0 }],
    position,
    pinned: false,
    deleted: false,
    createdAt: 0,
    updatedAt: 0,
  };
}

export async function openWorkspace(gateway: Gateway, host: Host, cwd: string, manage: () => void) {
  const [models, initialPrefs] = await Promise.all([
    gateway.models(host.id),
    gateway.request("/api/selfhost/settings", settingsSchema),
  ]);
  let preferences = initialPrefs;
  type Listener = { arg: unknown; fn: (value: unknown) => void };
  const listeners = new Map<string, Set<Listener>>();
  // ZCode subscribes after create() resolves. Retain the snapshot and any intervening PTY output.
  const terminalSessions = new Map<string, string | null>();
  const emit = (channel: string, event: string, value: unknown, target?: unknown) => {
    for (const entry of listeners.get(channel + "." + event) ?? [])
      if (target === undefined || target === entry.arg) entry.fn(value);
  };
  const fileWatches = new FileWatches(gateway, host.id, (id, event) =>
    emit("file-watcher", "onDynamicChange", event, id),
  );
  const uploads = new AttachmentBridge(gateway, host.id);
  const bridges = new Map<string, SessionBridge>();
  const scopedBridge = (path: unknown) => {
    const target = typeof path === "string" && path.startsWith("/") ? path : cwd;
    let bridge = bridges.get(target);
    if (!bridge) {
      bridge = new SessionBridge(gateway, host.id, target, models, emit);
      bridges.set(target, bridge);
    }
    return bridge;
  };
  const bridge = scopedBridge(cwd);
  let lastList = "";
  let polling = false;
  const refreshIndex = async () => {
    if (document.hidden || polling) return;
    polling = true;
    try {
      const page = await gateway.request(
        "/api/threads?" +
          new URLSearchParams({
            hostId: String(host.id),
            limit: "25",
            useRemoteStateIndexOnly: "true",
          }),
        z.object({ data: z.array(z.record(z.string(), z.unknown())) }),
      );
      const signature = JSON.stringify(
        page.data.map((t) => [t.id, t.title, t.updatedAt, t.status]),
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
      if (msg.type === "terminal.exited" || msg.type === "terminal.closed.event") {
        if (terminalSessions.delete(str(msg.sessionId)))
          emit("terminal", "onDynamicExit", num(msg.code), msg.sessionId);
      }
      if (msg.type === "config.catalog.changed") {
        emit("broadcast", "onMessage", { channel: "state:projects", payload: {} });
        void gateway
          .request("/api/selfhost/settings", settingsSchema)
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
    if (
      (channel === "zcode-agent" || channel === "plugin-management" || channel === "plugins") &&
      [
        "getPluginsOverview",
        "getOverview",
        "listPlugins",
        "getPluginReferenceCatalog",
        "getPluginDetail",
        "addPluginMarketplace",
        "removePluginMarketplace",
        "updatePluginMarketplace",
        "installPlugin",
        "uninstallPlugin",
        "getSkillReferenceCatalog",
        "listMcpServerStatuses",
      ].includes(method)
    )
      return extensionRequest(gateway, host.id, cwd, method, p);
    if (channel === "skills" && (method === "list" || method === "setEnabled"))
      return extensionRequest(
        gateway,
        host.id,
        cwd,
        method === "setEnabled" ? "setSkillEnabled" : "listSkills",
        p,
      );
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
          hostId: host.id,
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
        { hostId: host.id, channel, method, args },
      );
      if (channel === "file" && method === "readFileRange") {
        const b = str(rec(response.value).binary);
        return Uint8Array.from(atob(b), (v) => v.charCodeAt(0));
      }
      return response.value;
    }
    if (channel === "setting") {
      if (method === "get") return appSettingsSchema.parse(preferences);
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
      return modelView(models, p.selection ?? preferences.defaultModelSelection);
    if (channel === "provider-settings" && method === "getView")
      return { ...modelView(models, undefined), templates: [] };
    if (
      channel === "zcode-agent" &&
      (method === "getSessionLifecycle" || method === "ensureSessionReady")
    )
      return scopedBridge(p.workspacePath).lifecycle(str(p.sessionId));
    if (channel === "zcode-agent" && /^attachment(Begin|Chunk|Commit|Abort)V4$/.test(method))
      return uploads.handle(method, p);
    if (channel === "zcode-agent" && method.endsWith("V4"))
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
      const projects = await gateway.projects(host.id);
      const mapped = projects.map(projectRow);
      if (method === "readProjects") return mapped;
      if (method === "readTree") {
        const threads = await bridge.threads();
        return {
          projects: mapped,
          tasks: threads.map((t) => {
            const owner = projectForDirectory(projects, t.cwd);
            return {
              ...bridge.meta(t),
              hostId: "local",
              workspacePath: owner?.remotePath ?? str(t.cwd),
              cwd: str(t.cwd),
              projectId: owner?.remotePath ?? null,
              pinned: false,
              archived: false,
            };
          }),
        };
      }
      if (method === "prepareSession" || method === "resolveSessionDirectories") {
        const selected = projectForDirectory(projects, p.projectId ?? p.workspacePath ?? cwd);
        return {
          projectId: selected?.remotePath ?? null,
          workspacePath: selected?.remotePath ?? cwd,
          additionalDirectories: [],
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
          hostId: host.id,
          remotePath: path,
          name: str(p.name) || path.split("/").pop() || path,
        };
        await gateway.request("/api/projects", z.unknown(), "POST", value);
        return projectRow(value, mapped.length);
      }
    }
    if (channel === "file-watcher") {
      if (method === "watch") return fileWatches.watch(str(p.path), p.recursive === true);
      if (method === "unwatch") return fileWatches.unwatch(str(p.id));
      if (method === "disposeAll") return fileWatches.clear();
    }
    if (channel === "terminal") {
      if (method === "create") {
        const response = await gateway.call("terminal.open", {
          hostId: host.id,
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
            (t) => t.hostId === host.id && (t.cwd === path || str(t.cwd).startsWith(path + "/")),
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
        const kind =
          method === "listArchivedTasks"
            ? "archived"
            : method === "listPinnedTasks" || method === "listPinnedTaskIds"
              ? "pinned"
              : p.kind;
        const rows = (
          await bridge.threads(p.workspaceScopes === "host" ? undefined : scope, str(p.search))
        ).map((t) => ({
          ...bridge.meta(t),
          sourceAvailability: "online",
          liveStatus: rec(t.status).type === "active" ? "running" : "idle",
        }));
        const selected =
          kind === "archived" || kind === "pinned" || method === "listDeletedTaskIds"
            ? []
            : rows.filter(
                (t) =>
                  ((kind !== "active" && method !== "listActiveTaskIds") ||
                    t.status === "running") &&
                  (!Array.isArray(p.taskIds) || p.taskIds.includes(t.taskId)),
              );
        if (method === "listTaskList") {
          const limit = num(p.limit, selected.length);
          return {
            items: selected.slice(0, limit),
            total: selected.length,
            hasMore: limit < selected.length,
          };
        }
        return method.endsWith("Ids") ? selected.map((t) => t.taskId) : selected;
      }
      const address = rec(p.address),
        id = str(p.taskId ?? address.taskId);
      if (method === "getTaskMeta") {
        const found = (await bridge.threads()).find((t) => t.id === id);
        return found ? bridge.meta(found) : null;
      }
      if (method === "renameTask" || (method === "mutateTask" && rec(p.mutation).kind === "rename"))
        return gateway.request("/api/threads/rename", z.unknown(), "POST", {
          hostId: host.id,
          threadId: id,
          name: p.title ?? rec(p.mutation).title,
        });
      if (
        method === "archiveTask" ||
        method === "unarchiveTask" ||
        (method === "mutateTask" && rec(p.mutation).kind === "archive")
      ) {
        const archive = method === "archiveTask" || rec(p.mutation).archived === true;
        return codexRequest(gateway, host.id, archive ? "thread/archive" : "thread/unarchive", {
          threadId: id,
        });
      }
      if (method === "getTaskConfigOptions") return [];
      if (method === "getTaskModelSelection")
        return modelView(models, preferences.defaultModelSelection).effectiveSelection;
    }
    if (
      channel === "task-groups" ||
      (channel === "zcode-agent" && method.toLowerCase().includes("automation"))
    ) {
      const result = await gateway.request(
        "/api/selfhost/organization",
        z.object({ value: z.unknown().optional() }),
        "POST",
        { hostId: host.id, cwd, channel, method, args },
      );
      return result.value;
    }
    if (channel === "remote-projects" && method === "readDirectory")
      return { hosts: [], entries: [] };
    if (channel === "remote-projects" && method.startsWith("list")) return [];
    if (channel === "conversation-share")
      return shareOperation(gateway, host.id, method, p, args[0]);
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
    services: new RemoteServiceAccess(client),
    dispose() {
      for (const bridge of bridges.values()) bridge.dispose();
      bridges.clear();
      fileWatches.dispose();
      disposers.forEach((fn) => fn());
      listeners.clear();
      terminalSessions.clear();
    },
  };
}
