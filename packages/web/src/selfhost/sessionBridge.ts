import {
  conversationTopic,
  workspaceConfigTopic,
  sessionsIndexTopic,
  V4_WIRE_PROTOCOL_VERSION,
  encodeTopicWireFrames,
  measureTopicNotificationEnvelopeBytes,
  commandEnvelopeSchema,
  type V4ConversationResyncResult,
} from "@zcode/shared/zcode-protocol-v4";
import { Gateway, wireId, type Message, type RemoteModel } from "./gateway.js";
import {
  applyCodexRecoveryEvent,
  array,
  nativeHistoryRowStart,
  nativeMode,
  num,
  prependNativeHistoryPage,
  projectThread,
  providerId,
  rec,
  str,
  threadName,
  threadPhase,
} from "./threadProjection.js";
import { z } from "zod";
import { codexRequest } from "./capabilities.js";
import { applyCanonicalEventToHistory } from "virtual:gateway-terminal-stream";
type Subscription = {
  kind: "conversation" | "index" | "config";
  session?: string;
  topic: string;
  subscriptionId: string;
  epoch: string;
  ordinal: number;
  busy: boolean;
  dirty: boolean;
  rowIds: Map<string, number>;
  activation?: Message;
  lastId?: number;
  epochId?: string;
  timer?: ReturnType<typeof setTimeout>;
  queued?: Message[];
  generation: number;
  older?: Promise<void>;
  oldestRowId: number;
};
type Emit = (channel: string, event: string, value: unknown) => void;

/** Translate the original ZCode service/channel contracts. Codex alone creates and persists Thread IDs. */
export class SessionBridge {
  readonly epoch = wireId();
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly acknowledgements = new Map<string, Promise<unknown>>();
  private readonly disposeEvents: () => void;
  private readonly lastTurn = new Map<string, string>();
  constructor(
    readonly gateway: Gateway,
    readonly hostId: number,
    readonly cwd: string,
    readonly models: RemoteModel[],
    private readonly emit: Emit,
    private readonly nativeProjectId: (id: string) => Promise<string | undefined>,
  ) {
    this.disposeEvents = gateway.on((msg) => {
      if (msg.type === "thread.event") {
        const event = rec(msg.event),
          id = str(event.threadId);
        if (num(event.hostId) !== this.hostId) return;
        for (const sub of this.subscriptions.values()) {
          if (sub.kind === "index" && rec(event.event).type === "turn.completed") {
            this.defer(sub, 300);
            continue;
          }
          if (sub.session !== id) continue;
          if (!sub.activation) {
            (sub.queued ??= []).push(event);
            continue;
          }
          this.applyEvent(sub, event);
        }
      } else if (
        msg.type === "ready" ||
        msg.type === "thread.events.gap" ||
        msg.type === "config.catalog.changed"
      ) {
        for (const sub of this.subscriptions.values()) {
          if (
            msg.type === "thread.events.gap" &&
            (sub.session !== msg.threadId || msg.hostId !== this.hostId)
          )
            continue;
          if (msg.type === "config.catalog.changed" && sub.kind === "conversation") continue;
          if (sub.session) this.opened.delete(sub.session);
          sub.generation += 1;
          sub.queued = [];
          sub.activation = undefined;
          this.defer(sub);
        }
      }
    });
  }
  dispose() {
    this.disposeEvents();
    for (const sub of this.subscriptions.values()) {
      clearTimeout(sub.timer);
      if (sub.session)
        void this.gateway
          .send({ type: "thread.unsubscribe", hostId: this.hostId, threadId: sub.session })
          .catch(() => {});
    }
    this.subscriptions.clear();
  }
  private defer(sub: Subscription, delay = 40) {
    if (sub.timer) return;
    sub.timer = setTimeout(() => {
      sub.timer = undefined;
      this.schedule(sub);
    }, delay);
  }
  private applyEvent(sub: Subscription, envelope: Message) {
    const info = sub.activation;
    if (!info || !sub.session) return;
    const id = num(envelope.id);
    if (id && id <= (sub.lastId ?? 0)) return;
    if (id) sub.lastId = id;
    const event = rec(envelope.event);
    if (event.type === "notice" && event.source === "thread/name/updated") {
      info.thread = { ...rec(info.thread), name: rec(event.params).threadName ?? null };
    }
    applyCodexRecoveryEvent(info, envelope, sub.session);
    if (event.type === "thread.goal.updated") info.goal = event.goal;
    if (event.type === "thread.goal.cleared") info.goal = null;
    if (event.type === "turn.plan.updated") info.nativePlan = event;
    if (event.type === "thread.settings.updated") info.threadSettings = event.threadSettings;
    const history = applyCanonicalEventToHistory(info.history, info.thread, sub.session, event);
    if (history) info.history = history;
    this.defer(sub);
  }
  async threads(cwd?: string, search?: string) {
    const query = new URLSearchParams({
      hostId: String(this.hostId),
      limit: "100",
      useRemoteStateIndexOnly: "true",
    });
    if (cwd) query.set("cwd", cwd);
    if (search) query.set("searchTerm", search);
    const all = new Map<string, Message>();
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      if (cursor) query.set("cursor", cursor);
      const page: { data: Message[]; nextCursor: string | null } = await this.gateway.request(
        "/api/threads?" + query,
        z.object({
          data: z.array(z.record(z.string(), z.unknown())),
          nextCursor: z.string().nullable().default(null),
        }),
      );
      for (const t of page.data) all.set(str(t.id), t);
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw Error("Codex 返回了重复的会话游标");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return [...all.values()];
  }
  meta(t: Message) {
    const now = (v: unknown) => {
      const n = num(v);
      return n < 1e12 ? n * 1000 : n;
    };
    return {
      taskId: str(t.id),
      traceId: str(t.id),
      title: threadName(t),
      workspacePath: str(t.cwd, this.cwd),
      cwd: str(t.cwd, this.cwd),
      createdAt: now(t.createdAt),
      updatedAt: now(t.updatedAt),
      mode: "build",
      provider: "glm",
      status: rec(t.status).type === "active" ? "running" : "completed",
      archived: false,
    };
  }
  private async publish(sub: Subscription) {
    if (!this.subscriptions.has(sub.subscriptionId)) return;
    let snapshot: unknown;
    if (sub.kind === "conversation" && sub.session) {
      const id = sub.session;
      if (!sub.activation) {
        const generation = sub.generation;
        const info = await this.activation(id);
        if (generation !== sub.generation || !this.subscriptions.has(sub.subscriptionId)) return;
        this.opened.delete(id);
        sub.activation = info;
        sub.lastId = num(info.lastEventId);
        sub.epochId = str(info.eventEpoch);
        for (const event of sub.queued ?? []) this.applyEvent(sub, event);
        sub.queued = [];
        // 历史与 Goal 是独立读取。Goal 慢或旧版缺少 Goal 方法时先渲染会话。
        void this.gateway
          .call("thread.goal.get", { hostId: this.hostId, threadId: id })
          .then((goal) => {
            if (sub.activation !== info || info.goal !== undefined) return;
            info.goal = goal.goal ?? null;
            this.defer(sub);
          })
          .catch(() => {});
      }
      const info = sub.activation;
      const turns = array(rec(rec(info.history).thread).turns);
      const active = turns.findLast((t) => t.status === "inProgress");
      if (active) this.lastTurn.set(id, str(active.id));
      else this.lastTurn.delete(id);
      const projection = projectThread(
        info,
        id,
        sub.epoch,
        sub.ordinal + 1,
        this.models,
        sub.rowIds,
      );
      const visible = projection.rows.window.slice(-100);
      projection.rows.window = visible;
      snapshot = projection;
    } else if (sub.kind === "index") {
      const sessions = (await this.threads(this.cwd)).map((t) => ({
        sessionId: str(t.id),
        workspaceId: this.cwd,
        title: threadName(t),
        phase: rec(t.status).type === "active" ? "running" : "completedSuccess",
        sessionEnded: false,
        hasBackgroundWork: false,
        createdAt: num(t.createdAt) * 1000,
        lastActivityAt: num(t.updatedAt) * 1000,
        lastAssistantPreview: str(t.preview),
      }));
      snapshot = { protocolVersion: 1, workspaceId: this.cwd, logEpoch: sub.epoch, sessions };
    } else {
      snapshot = {
        protocolVersion: 1,
        workspaceId: this.cwd,
        logEpoch: sub.epoch,
        config: { configOptions: [], slashCommands: [] },
      };
    }
    if (!this.subscriptions.has(sub.subscriptionId)) return;
    const ordinal = ++sub.ordinal;
    const frame = {
      topic: sub.topic,
      subscriptionId: sub.subscriptionId,
      fromSeq: 0,
      toSeq: ordinal,
      sentAt: Date.now(),
      payload: { kind: "snapshot", snapshot },
    };
    const event =
      sub.kind === "conversation"
        ? "onDynamicConversationFrame"
        : sub.kind === "index"
          ? "onDynamicSessionsIndexFrame"
          : "onDynamicWorkspaceConfigFrame";
    const wires = encodeTopicWireFrames(frame, {
      topic: sub.topic,
      subscriptionId: sub.subscriptionId,
      logicalFrameId: wireId(),
      logicalFrameOrdinal: ordinal,
      deliveryKind: ordinal === 1 ? "initial" : "recovery",
      measurePhysicalFrameBytes: (w) => measureTopicNotificationEnvelopeBytes(w).maxBytes,
    });
    for (const wire of wires) this.emit("zcode-agent", event, wire);
  }
  private schedule(sub: Subscription) {
    if (sub.busy) {
      sub.dirty = true;
      return;
    }
    sub.busy = true;
    void (async () => {
      try {
        do {
          sub.dirty = false;
          await this.publish(sub);
        } while (sub.dirty && this.subscriptions.has(sub.subscriptionId));
      } catch (e) {
        if (!this.subscriptions.has(sub.subscriptionId)) return;
        this.emit("zcode-agent", "onAgentRuntimeRestarted", {
          workspacePath: this.cwd,
          error: String(e),
        });
      } finally {
        sub.busy = false;
      }
    })();
  }
  private readonly opened = new Map<string, Promise<Message>>();
  private async activation(id: string) {
    const cached = this.opened.get(id);
    if (cached) return cached;
    const promise = (async () => {
      const scope = { hostId: this.hostId, threadId: id };
      const info = await this.gateway.call("thread.activate", {
        ...scope,
        limit: 100,
        retryWriter: true,
      });
      info.nativePlan = array(info.recentEvents)
        .map((e) => rec(e.event))
        .findLast((e) => e.type === "turn.plan.updated");
      for (const event of array(info.recentEvents)) applyCodexRecoveryEvent(info, event, id);
      return info;
    })();
    this.opened.set(id, promise);
    try {
      return await promise;
    } catch (error) {
      if (this.opened.get(id) === promise) this.opened.delete(id);
      throw error;
    }
  }

  private loadOlder(sub: Subscription, info: Message, threadId: string) {
    if (sub.older) return sub.older;
    const cursor = str(info.oldestTimelineCursor);
    const pending = this.gateway
      .call("thread.timeline.load", {
        hostId: this.hostId,
        threadId,
        cursor,
        limit: 100,
      })
      .then((page) => {
        if (sub.activation !== info || !this.subscriptions.has(sub.subscriptionId)) return;
        const next = str(page.nextCursor);
        if (next === cursor) throw Error("Codex 返回了重复的历史游标");
        sub.oldestRowId = prependNativeHistoryPage(
          info,
          page,
          threadId,
          this.models,
          sub.rowIds,
          sub.oldestRowId,
        );
      })
      .finally(() => {
        if (sub.older === pending) sub.older = undefined;
      });
    sub.older = pending;
    return pending;
  }
  async lifecycle(session: string) {
    if (![...this.subscriptions.values()].some((sub) => sub.session === session && sub.activation))
      await this.activation(session);
    return { sessionId: session, state: "ready", generation: 1, revision: 0, lastError: null };
  }
  async handle(method: string, p: Message): Promise<unknown> {
    if (
      method === "conversationRowsRangeV4" ||
      method === "conversationPlansV4" ||
      method === "conversationFileChangesV4"
    ) {
      const session = str(p.sessionId),
        sub = [...this.subscriptions.values()].find((s) => s.session === session);
      const info = sub?.activation ?? (await this.activation(session));
      const seq = sub?.ordinal ?? 1,
        epoch = sub?.epoch ?? this.epoch;
      let snapshot = projectThread(
        info,
        session,
        epoch,
        seq,
        this.models,
        sub?.rowIds ?? new Map(),
      );
      const versions = { atSeq: seq, atRevision: seq, atLogEpoch: epoch };
      if (method === "conversationRowsRangeV4") {
        let rows = snapshot.rows.window.filter(
          (r) => typeof p.beforeRowId !== "number" || r.rowId < p.beforeRowId,
        );
        const limit = Math.max(1, num(p.limit, 100));
        while (sub && rows.length < limit && info.oldestTimelineCursor) {
          await this.loadOlder(sub, info, session);
          if (!this.subscriptions.has(sub.subscriptionId) || sub.activation !== info)
            throw Error("Codex 历史快照已更新");
          snapshot = projectThread(info, session, epoch, seq, this.models, sub.rowIds);
          rows = snapshot.rows.window.filter(
            (r) => typeof p.beforeRowId !== "number" || r.rowId < p.beforeRowId,
          );
        }
        return {
          ...versions,
          rows: rows.slice(-limit),
          hasMore: rows.length > limit || Boolean(info.oldestTimelineCursor),
        };
      }
      if (method === "conversationPlansV4")
        return {
          atSeq: seq,
          atLogEpoch: epoch,
          plans: snapshot.rows.window.filter(
            (r) => r.kind === "toolCall" && r.toolName === "ExitPlanMode",
          ),
        };
      const changes = array(rec(rec(info.history).thread).turns)
        .flatMap((t) => array(t.items))
        .filter((i) => i.type === "fileChange")
        .flatMap((i) => array(i.changes));
      const items = changes.map((c) => {
        const lines = str(c.diff).split("\n");
        return {
          path: str(c.path),
          writeCount: 1,
          toolNames: ["fileChange"],
          patches: [],
          additions: lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length,
          deletions: lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length,
        };
      });
      return {
        files: items.length,
        items,
        additions: items.reduce((n, i) => n + i.additions, 0),
        deletions: items.reduce((n, i) => n + i.deletions, 0),
      };
    }
    if (method === "helloConversationV4")
      return {
        kind: "hello",
        protocolVersion: V4_WIRE_PROTOCOL_VERSION,
        connectionId: this.epoch,
        clientMode: "web-remote-replayable",
        deliveryProfile: "replayable",
        serverTime: Date.now(),
        capabilities: {
          nativeDialogs: false,
          localTerminal: true,
          binaryFrames: false,
          compression: "none",
          independentPlanState: true,
        },
        auth: {},
      };
    if (method === "initializeConversationV4") return;
    if (
      [
        "subscribeConversationV4",
        "subscribeSessionsIndexV4",
        "subscribeWorkspaceConfigV4",
      ].includes(method)
    ) {
      const kind =
        method === "subscribeConversationV4"
          ? "conversation"
          : method === "subscribeSessionsIndexV4"
            ? "index"
            : "config";
      const session = str(p.sessionId),
        topic =
          kind === "conversation"
            ? conversationTopic(session)
            : kind === "index"
              ? sessionsIndexTopic(this.cwd)
              : workspaceConfigTopic(this.cwd);
      const sub: Subscription = {
        kind,
        session: kind === "conversation" ? session : undefined,
        topic,
        epoch: this.epoch,
        subscriptionId: wireId(),
        ordinal: 0,
        busy: false,
        dirty: false,
        rowIds: new Map(),
        generation: 0,
        oldestRowId: nativeHistoryRowStart,
      };
      this.subscriptions.set(sub.subscriptionId, sub);
      this.schedule(sub);
      return { ack: { subscriptionId: sub.subscriptionId, mode: "snapshot", logEpoch: sub.epoch } };
    }
    if (method.startsWith("unsubscribe")) {
      const sub = this.subscriptions.get(str(p.subscriptionId));
      this.subscriptions.delete(str(p.subscriptionId));
      if (sub) clearTimeout(sub.timer);
      if (
        sub?.session &&
        !Array.from(this.subscriptions.values()).some((s) => s.session === sub.session)
      )
        await this.gateway.send({
          type: "thread.unsubscribe",
          hostId: this.hostId,
          threadId: sub.session,
        });
      return;
    }
    if (method.startsWith("resync")) {
      const sub = this.subscriptions.get(str(p.subscriptionId));
      if (!sub) throw Error("fault.subscription.notOwned");
      this.schedule(sub);
      // 补同步接收端通过 result.ack 核对订阅；平铺响应会让正在流式输出的会话进入错误页。
      return {
        ack: { subscriptionId: sub.subscriptionId, mode: "snapshot", logEpoch: sub.epoch },
      } satisfies V4ConversationResyncResult;
    }
    if (method === "sendConversationCommandV4") {
      const command = commandEnvelopeSchema.parse(p.envelope);
      const previous = this.acknowledgements.get(command.commandId);
      if (previous) return previous;
      const operation = this.command(
        command.type,
        command.sessionId,
        rec(command.payload),
        command.commandId,
        str(p.projectId),
      ).then(
        (result) => ({
          commandId: command.commandId,
          status: "accepted",
          revisionAtDecision: 0,
          ...(result === undefined ? {} : { result }),
        }),
        (err) => ({
          commandId: command.commandId,
          status: "failed",
          revisionAtDecision: 0,
          reasonCode: "codex.commandFailed",
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      this.acknowledgements.set(command.commandId, operation);
      if (this.acknowledgements.size > 2048)
        this.acknowledgements.delete(this.acknowledgements.keys().next().value!);
      return operation;
    }
    throw new Error("Unsupported native agent operation: " + method);
  }
  private async command(
    type: string,
    sessionId: string | null,
    p: Message,
    commandId: string,
    projectId: string,
  ): Promise<unknown> {
    const config = rec(p.config),
      first = rec(p.firstInput),
      selection = rec(p.modelSelection ?? first.modelSelection ?? config.modelSelection),
      model = str(selection.modelId) || str(p.model) || undefined;
    const effort = str(rec(selection.options).reasoningLevel) || str(p.thought) || undefined;
    if (type === "createSession") {
      const created = await this.gateway.call("thread.start", {
        hostId: this.hostId,
        cwd: this.cwd,
        model,
        effort,
        ...(projectId ? { projectId: await this.nativeProjectId(projectId) } : {}),
        ...(config.mode ? nativeMode(config.mode) : {}),
      });
      const id = str(created.threadId);
      if (!id) throw Error("Codex returned no native thread id");
      const input =
        typeof first.text === "string" && first.text.trim()
          ? await this.sendText(id, { ...first, modelSelection: selection }, commandId)
          : undefined;
      for (const s of this.subscriptions.values()) if (s.kind === "index") this.schedule(s);
      this.emit("zcode-task", "onDynamicWorkspaceEvent", {
        type: "workspace_task_list_changed",
        workspacePath: this.cwd,
      });
      this.emit("broadcast", "onMessage", { channel: "state:projects", payload: {} });
      return { type: "createSession", sessionId: id, ...(input ? { input } : {}) };
    }
    if (!sessionId) throw Error("No native thread selected");
    const opened = [...this.subscriptions.values()].find(
      (sub) => sub.session === sessionId,
    )?.activation;
    if (opened?.readOnly === true && type !== "forkAssistant")
      throw Error("此会话由另一端持有，释放后请重新连接");
    if (type === "sendText") return this.sendText(sessionId, p, commandId);
    if (type === "sendGoalCommand" || type === "pauseGoal" || type === "resumeGoal") {
      const scope = { hostId: this.hostId, threadId: sessionId };
      const text = str(p.text)
        .replace(/^\/goal\s*/i, "")
        .trim();
      if (type === "sendGoalCommand" && !text) throw Error("请输入目标");
      const response = await this.gateway.call("thread.goal.set", {
        ...scope,
        ...(type === "sendGoalCommand" ? { objective: text } : {}),
        status: type === "pauseGoal" ? "paused" : "active",
      });
      for (const sub of this.subscriptions.values())
        if (sub.session === sessionId && sub.activation) {
          sub.activation.goal = response.goal;
          this.defer(sub);
        }
      if (type === "sendGoalCommand" && !this.lastTurn.has(sessionId))
        return this.sendText(sessionId, { ...p, text }, commandId);
      return;
    }
    if (type === "forkAssistant") {
      const sub = [...this.subscriptions.values()].find((s) => s.session === sessionId),
        turnId = str(rec(p.target).turnId) || str(rec(p.target).productTurnId);
      const rowId = num(rec(p.target).rowId);
      const row = sub?.activation
        ? projectThread(
            sub.activation,
            sessionId,
            sub.epoch,
            sub.ordinal,
            this.models,
            sub.rowIds,
          ).rows.window.find((r) => r.rowId === rowId)
        : undefined;
      const fork = await this.gateway.call("thread.fork", {
        hostId: this.hostId,
        threadId: sessionId,
        turnId: turnId || row?.turnId,
        boundary: "after",
      });
      return { type: "forkAssistant", sessionId: str(fork.threadId) || str(rec(fork.thread).id) };
    }
    if (type === "compact") {
      await codexRequest(this.gateway, this.hostId, "thread/compact/start", {
        threadId: sessionId,
      });
      return;
    }
    if (type === "stop") {
      const id = this.lastTurn.get(sessionId);
      if (id)
        await this.gateway.call("turn.interrupt", {
          hostId: this.hostId,
          threadId: sessionId,
          turnId: id,
        });
      return;
    }
    if (type === "resolveInteraction") {
      const raw = str(p.interactionId),
        answer = rec(p.answer),
        choice = str(answer.optionId) || str(answer.action);
      const live = [...this.subscriptions.values()].find(
        (s) => s.kind === "conversation" && s.session === sessionId && s.activation,
      )?.activation;
      const items = array(rec(rec(live?.history).thread).turns).flatMap((t) => array(t.items));
      const item = items.find(
        (i) => String(i.requestId ?? rec(i.pendingApproval).requestId) === raw,
      );
      if (!item) throw Error("此审批已处理或已失效，请刷新会话");
      const pending = rec(item.pendingApproval),
        method = str(item.method ?? pending.method),
        params = rec(item.params ?? pending.params);
      let result: unknown;
      if (method === "mcpServer/elicitation/request") {
        // MCP 回答使用 action/content；命令审批的 decision 会被远端拒绝。
        const action = answer.action;
        if (action !== "accept" && action !== "decline" && action !== "cancel")
          throw Error("无效的 MCP 决定");
        const value = rec(answer.content).value;
        if (action === "accept" && params.mode !== "url" && value === undefined)
          throw Error("MCP 表单未填写");
        result = {
          action,
          content: action === "accept" && params.mode !== "url" ? value : null,
          _meta: null,
        };
      } else if (method === "item/tool/requestUserInput") {
        const answers = rec(rec(answer.content).answers),
          response: Message = {};
        for (const q of array(params.questions)) {
          const value =
            answers[str(q.id)] ??
            answers[str(q.question)] ??
            (array(params.questions).length === 1
              ? (answer.freeText ?? answer.optionId)
              : undefined);
          const typed = rec(value).answers ?? value;
          if (typed === undefined) throw Error("请回答全部问题");
          response[str(q.id)] = {
            answers: Array.isArray(typed) ? typed.map(String) : [String(typed)],
          };
        }
        result = { answers: response };
      } else {
        if (!["accept", "decline"].includes(choice)) throw Error("Unrecognized approval decision");
        if (method === "item/permissions/requestApproval")
          result = { permissions: choice === "accept" ? params.permissions : {}, scope: "turn" };
        else if (
          method === "item/commandExecution/requestApproval" ||
          method === "item/fileChange/requestApproval"
        )
          result = { decision: choice };
        else throw Error("当前 Codex 请求不能作为命令批准：" + method);
      }
      const request = item.requestId ?? pending.requestId;
      await this.gateway.call("serverRequest.respond", {
        hostId: this.hostId,
        threadId: sessionId,
        serverRequestId: request,
        result,
      });
      return {
        type: "resolveInteraction",
        resolvedBy: { clientId: this.epoch, optionId: choice || undefined },
      };
    }
    if (type === "switchModelConfig" || type === "switchCollaborationMode") {
      const settings: Message = { hostId: this.hostId, threadId: sessionId };
      if (model) settings.model = model;
      if (effort) settings.effort = effort;
      if (p.mode) settings.approvalPolicy = nativeMode(p.mode).approvalPolicy;
      if (typeof p.planEnabled === "boolean" || p.mode !== undefined)
        settings.collaborationMode = {
          mode: p.planEnabled || p.mode === "plan" ? "plan" : "default",
          settings: {
            model: model ?? this.models.find((m) => m.isDefault)?.model ?? this.models[0]?.model,
            reasoningEffort: effort ?? null,
            developerInstructions: null,
          },
        };
      await this.gateway.request("/api/threads/settings", z.unknown(), "POST", settings);
      for (const s of this.subscriptions.values())
        if (s.session === sessionId) {
          s.activation = undefined;
          this.defer(s);
        }
      return;
    }
    throw Error("This operation is unavailable for the selected Codex CLI: " + type);
  }
  private async sendText(id: string, p: Message, commandId: string) {
    const model = str(rec(p.modelSelection).modelId) || undefined;
    const effort = str(rec(rec(p.modelSelection).options).reasoningLevel) || undefined;
    const running = this.lastTurn.get(id);
    if (running && (p.requestedDelivery === "guide" || !p.requestedDelivery)) {
      await this.gateway.call("turn.steer", {
        hostId: this.hostId,
        threadId: id,
        expectedTurnId: running,
        text: str(p.text),
        clientUserMessageId: commandId,
      });
      return { type: "inputAccepted", delivery: "guide", inputId: commandId };
    }
    const files = array(p.attachments).map((a) => ({
      path: str(a.ref),
      name: str(a.fileName),
      mimeType: str(a.mime) || null,
      size: num(a.bytes),
      isImage: str(a.mime).startsWith("image/"),
    }));
    const active = [...this.subscriptions.values()].find((sub) => sub.session === id)?.activation;
    const modeModel = model || str(rec(active?.threadSettings).model);
    const result = await this.gateway.call("turn.start", {
      hostId: this.hostId,
      threadId: id,
      files,
      images: files.filter((f) => f.isImage).map((f) => ({ path: f.path })),
      text: str(p.text),
      clientUserMessageId: commandId,
      model,
      effort,
      ...(p.mode ? { approvalPolicy: nativeMode(p.mode).approvalPolicy } : {}),
      ...(typeof p.planEnabled === "boolean" && modeModel
        ? {
            collaborationMode: {
              mode: p.planEnabled ? "plan" : "default",
              settings: {
                model: modeModel,
                reasoningEffort: effort ?? null,
                developerInstructions: null,
              },
            },
          }
        : {}),
    });
    this.lastTurn.set(id, str(rec(result.turn).id));
    return { type: "inputAccepted", delivery: "startNow", inputId: commandId };
  }
}
