import {
  conversationTopic,
  workspaceConfigTopic,
  sessionsIndexTopic,
  encodeTopicWireFrames,
  measureTopicNotificationEnvelopeBytes,
  type V4ConversationResyncResult,
} from "@zcode/shared/zcode-protocol-v4";
import { applyCanonicalEventToHistory } from "virtual:gateway-terminal-stream";
import { wireId, type Gateway, type Message, type RemoteModel } from "./gateway.js";
import {
  applyCodexRecoveryEvent,
  array,
  nativeHistoryRowStart,
  num,
  prependNativeHistoryPage,
  projectThread,
  rec,
  refreshNativeHistoryPage,
  str,
  threadName,
} from "./threadProjection.js";
import { projectNativeSubagents } from "./nativeSubagents.js";
import { loadTurnFileSummaries, markTurnFilesReverted } from "./turnFileChanges.js";
import { applyNativeInteractionEvent } from "./nativeInteractions.js";

type Subscription = {
  kind: "conversation" | "index" | "config";
  session?: string;
  topic: string;
  subscriptionId: string;
  epoch: string;
  ordinal: number;
  dirty: boolean;
  publishing?: Promise<void>;
  rowIds: Map<string, number>;
  activation?: Message;
  needsActivation: boolean;
  readOnlyHistoryEpoch?: string;
  recoveryError?: { message: string; at: number };
  lastId?: number;
  epochId?: string;
  timer?: ReturnType<typeof setTimeout>;
  queued?: Message[];
  generation: number;
  older?: Promise<void>;
  olderCursors: Set<string>;
  rowIdStart: number;
  oldestRowId: number;
  controlsRequest?: object;
};
type Emit = (channel: string, event: string, value: unknown) => void;

/** Owns browser subscriptions and reduces native replay into independent conversation views. */
export class SessionSubscriptions {
  readonly epoch = wireId();
  readonly subscriptions = new Map<string, Subscription>();
  readonly lastTurn = new Map<string, string>();
  followupMode: "queue" | "guide" = "guide";
  private readonly disposeEvents: () => void;
  private readonly fileSummaryRequests = new WeakMap<Message, Set<string>>();
  constructor(
    private readonly gateway: Gateway,
    private readonly hostId: number,
    private readonly cwd: string,
    private readonly models: RemoteModel[],
    private readonly emit: Emit,
    private readonly threads: (cwd?: string) => Promise<Message[]>,
    private readonly loadModelCatalog?: (provider?: string) => Promise<RemoteModel[]>,
  ) {
    this.disposeEvents = gateway.on((msg) => {
      if (msg.type === "thread.event") {
        const event: Message = { ...rec(msg.event), eventEpoch: msg.eventEpoch },
          id = str(event.threadId);
        if (num(event.hostId) !== this.hostId) return;
        for (const sub of this.subscriptions.values()) {
          if (sub.kind === "index" && rec(event.event).type === "turn.completed") {
            this.defer(sub, 300);
            continue;
          }
          if (sub.session !== id) continue;
          if (sub.needsActivation) {
            if (!sub.recoveryError || sub.publishing) (sub.queued ??= []).push(event);
            continue;
          }
          this.applyEvent(sub, event);
        }
      } else if (msg.type === "thread.history.changed" && msg.hostId === this.hostId) {
        const epoch = str(msg.eventEpoch);
        if (!epoch) return;
        for (const sub of this.subscriptions.values()) {
          if (sub.kind !== "conversation" || sub.session !== msg.threadId) continue;
          if (
            !sub.needsActivation &&
            (sub.epochId !== epoch || sub.activation?.readOnlyReason !== "activeWriter")
          ) continue;
          sub.readOnlyHistoryEpoch = epoch;
          this.defer(sub);
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
          if (sub.kind === "conversation") {
            if (msg.type === "config.catalog.changed") continue;
            // 首次 ready 发生在原生激活发出前，不应取消已经登记的首个订阅。
            if (msg.type === "ready" && !sub.activation) continue;
            this.invalidate(sub);
          }
          this.defer(sub);
        }
      }
    });
  }
  dispose() {
    this.disposeEvents();
    for (const id of this.subscriptions.keys()) void this.removeSubscription(id);
  }
  defer(sub: Subscription, delay = 40) {
    if (sub.timer) return;
    sub.timer = setTimeout(() => {
      sub.timer = undefined;
      void this.schedule(sub).catch(() => {});
    }, delay);
  }
  invalidate(sub: Subscription) {
    sub.generation += 1;
    if (sub.publishing) sub.dirty = true;
    sub.queued = [];
    sub.readOnlyHistoryEpoch = undefined;
    sub.needsActivation = true;
  }
  private applyEvent(sub: Subscription, envelope: Message) {
    const info = sub.activation;
    if (!info || !sub.session) return;
    const epoch = str(envelope.eventEpoch);
    if (epoch && sub.epochId && epoch !== sub.epochId) return;
    const id = num(envelope.id);
    if (id && id <= (sub.lastId ?? 0)) return;
    if (id) sub.lastId = id;
    const event = rec(envelope.event);
    if (event.type === "notice" && event.source === "thread/name/updated") {
      info.thread = { ...rec(info.thread), name: rec(event.params).threadName ?? null };
    }
    if (event.type === "notice" && event.source === "selfhost/turn-files/reverted")
      markTurnFilesReverted(info, str(rec(event.params).turnId));
    applyCodexRecoveryEvent(info, envelope, sub.session);
    if (event.type === "thread.goal.updated") info.goal = event.goal;
    if (event.type === "thread.goal.cleared") info.goal = null;
    // 早到的文件项或快照可能已查询过这一轮，但持久凭据直到权威完成事件才就绪。
    if (event.type === "turn.completed") {
      const turnId = str(rec(event.turn).id);
      if (turnId) this.fileSummaryRequests.get(info)?.delete(turnId);
    }
    if (event.type === "turn.plan.updated") info.nativePlan = event;
    if (event.type === "thread.settings.updated") info.threadSettings = event.threadSettings;
    if (event.type === "thread.usage.updated") info.tokenUsage = event.tokenUsage;
    if (event.type === "notice" && event.source === "thread/queue/changed")
      this.refreshNativeControls(sub);
    if (!applyNativeInteractionEvent(info, envelope)) {
      const history = applyCanonicalEventToHistory(info.history, info.thread, sub.session, event);
      if (history) info.history = history;
    }
    this.defer(sub);
  }
  private refreshNativeControls(sub: Subscription) {
    const info = sub.activation;
    const threadId = sub.session;
    if (!info || !threadId || info.readOnly === true) return;
    const request = {};
    const generation = sub.generation;
    sub.controlsRequest = request;
    void this.gateway
      .call("thread.native.controls", { hostId: this.hostId, threadId })
      .then((reply) => {
        if (
          !this.subscriptions.has(sub.subscriptionId) ||
          sub.generation !== generation ||
          sub.activation !== info ||
          sub.controlsRequest !== request
        )
          return;
        info.nativeControls = reply;
        this.defer(sub, 0);
      })
      .catch(() => {});
  }
  refreshThreadControls(threadId: string) {
    for (const sub of this.subscriptions.values())
      if (sub.session === threadId) this.refreshNativeControls(sub);
  }
  private async publish(sub: Subscription) {
    if (!this.subscriptions.has(sub.subscriptionId)) return;
    let snapshot: unknown;
    if (sub.kind === "conversation" && sub.session) {
      const id = sub.session;
      if (sub.needsActivation) {
        const generation = sub.generation;
        try {
          // 多个渲染订阅可以共用原生激活请求，但每个订阅各自归约事件。
          const info = { ...(await this.activation(id)) };
          if (generation !== sub.generation || !this.subscriptions.has(sub.subscriptionId)) return;
          sub.activation = info;
          sub.needsActivation = false;
          sub.recoveryError = undefined;
          sub.lastId = num(info.lastEventId);
          sub.epochId = str(info.eventEpoch);
          sub.older = undefined;
          sub.olderCursors.clear();
          for (const event of sub.queued ?? []) this.applyEvent(sub, event);
          sub.queued = [];
          this.refreshNativeControls(sub);
          // 历史与 Goal 是独立读取。Goal 慢或旧版缺少 Goal 方法时先渲染会话。
          void this.gateway
            .call("thread.goal.get", { hostId: this.hostId, threadId: id })
            .then((goal) => {
              if (sub.activation !== info || info.goal !== undefined) return;
              info.goal = goal.goal ?? null;
              this.defer(sub);
            })
            .catch(() => {});
        } catch (error: unknown) {
          if (generation !== sub.generation || !this.subscriptions.has(sub.subscriptionId)) return;
          if (!sub.activation) throw error;
          sub.queued = [];
          sub.recoveryError = {
            message: error instanceof Error ? error.message : String(error),
            at: Date.now(),
          };
        }
      }
      const info = sub.activation;
      if (!info) return;
      const historyEpoch = sub.readOnlyHistoryEpoch;
      sub.readOnlyHistoryEpoch = undefined;
      if (
        historyEpoch &&
        historyEpoch === sub.epochId &&
        !sub.needsActivation &&
        info.readOnlyReason === "activeWriter"
      ) {
        await this.refreshReadOnlyHistory(sub, info, id);
        if (sub.needsActivation || !this.subscriptions.has(sub.subscriptionId)) return;
      }
      info.followupMode = this.followupMode;
      const turns = array(rec(rec(info.history).thread).turns);
      this.refreshFileSummaries(sub, info, turns).catch(() => {});
      const active = turns.findLast(
        (turn) => turn.status === "inProgress" && !str(turn.id).startsWith("server-request-turn-"),
      );
      if (active) this.lastTurn.set(id, str(active.id));
      else this.lastTurn.delete(id);
      const projection = projectThread(
        info,
        id,
        sub.epoch,
        sub.ordinal + 1,
        this.models,
        sub.rowIds,
        sub.rowIdStart,
      );
      const visible = projection.rows.window.slice(-100);
      projection.rows.window = visible;
      if (sub.recoveryError) {
        // SSH 恢复失败时保留已读正文与订阅，并让界面显示可重试的错误。
        projection.control.lastError = {
          code: "codex.historyRecoveryFailed",
          source: "network",
          recoverable: true,
          ...sub.recoveryError,
        };
      }
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
    if (sub.publishing) {
      sub.dirty = true;
      return sub.publishing;
    }
    const publishing = (async () => {
      do {
        sub.dirty = false;
        await this.publish(sub);
      } while (sub.dirty && this.subscriptions.has(sub.subscriptionId));
    })();
    sub.publishing = publishing.finally(() => {
      sub.publishing = undefined;
    });
    return sub.publishing;
  }
  private readonly opened = new Map<string, Promise<Message>>();
  async activation(id: string) {
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
    } finally {
      if (this.opened.get(id) === promise) this.opened.delete(id);
    }
  }

  private refreshModels(sub: Subscription, info: Message) {
    const provider = str(rec(info.thread).modelProvider);
    void this.loadModelCatalog?.(provider)
      .then((models) => {
        if (sub.activation !== info || sub.needsActivation) return;
        info.nativeModels = models;
        this.defer(sub);
      })
      .catch(() => {});
  }
  private async refreshReadOnlyHistory(sub: Subscription, info: Message, threadId: string) {
    const generation = sub.generation;
    const isCurrent = () =>
      sub.activation === info &&
      sub.generation === generation &&
      this.subscriptions.has(sub.subscriptionId);
    try {
      const page = await this.gateway.call("thread.timeline.load", {
        hostId: this.hostId,
        threadId,
        cursor: null,
        limit: 100,
      });
      if (!isCurrent()) return;
      if (refreshNativeHistoryPage(info, page, threadId)) {
        // 断开的原生页不能接在旧窗口后。保留订阅，重建新窗口的 ID 与向前翻页边界。
        sub.rowIdStart += sub.rowIds.size + 1;
        sub.oldestRowId = sub.rowIdStart;
        sub.rowIds.clear();
        sub.older = undefined;
        sub.olderCursors.clear();
      }
      sub.recoveryError = undefined;
    } catch (error: unknown) {
      if (isCurrent())
        sub.recoveryError = {
          message: error instanceof Error ? error.message : String(error),
          at: Date.now(),
        };
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
      .then(async (page) => {
        if (
          sub.activation !== info ||
          sub.older !== pending ||
          sub.needsActivation ||
          !this.subscriptions.has(sub.subscriptionId)
        )
          return;
        const next = str(page.nextCursor);
        if (next && (next === cursor || sub.olderCursors.has(next)))
          throw Error("Codex 返回了重复的历史游标");
        sub.oldestRowId = prependNativeHistoryPage(
          info,
          page,
          threadId,
          this.models,
          sub.rowIds,
          sub.oldestRowId,
        );
        sub.olderCursors.add(cursor);
        await this.refreshFileSummaries(sub, info, array(rec(rec(info.history).thread).turns));
      })
      .finally(() => {
        if (sub.older === pending) sub.older = undefined;
      });
    sub.older = pending;
    return pending;
  }
  private async refreshFileSummaries(sub: Subscription, info: Message, turns: Message[]) {
    if (!sub.session) return;
    const requested = this.fileSummaryRequests.get(info) ?? new Set<string>();
    this.fileSummaryRequests.set(info, requested);
    const ids = turns.flatMap((turn) => {
      const id = str(turn.id);
      if (!id || turn.status === "inProgress" || requested.has(id)) return [];
      requested.add(id);
      return [id];
    });
    const scope = { hostId: this.hostId, cwd: this.cwd, threadId: sub.session };
    for (let index = 0; index < ids.length; index += 100) {
      const batch = ids.slice(index, index + 100);
      const updated = await loadTurnFileSummaries(this.gateway, info, scope, batch).catch(() => {
        // HTTP/SSH 暂时失败没有确认文件状态；在下一次订阅事件到达时重读。
        for (const id of batch) requested.delete(id);
        return false;
      });
      if (
        updated &&
        sub.activation === info &&
        !sub.needsActivation &&
        this.subscriptions.has(sub.subscriptionId)
      )
        this.defer(sub);
    }
  }
  async handle(method: string, p: Message) {
    if (method === "listSessionSubagents") {
      const sub = [...this.subscriptions.values()].find(
        (candidate) => candidate.session === p.sessionId && candidate.activation,
      );
      if (!sub?.activation) throw Error("Codex 子智能体目录需要已打开的会话");
      // 目录读取同一份已回放的父 Thread；不会再启动一个原生运行时。
      const { running, childSessionIds, revision, ended = [] } =
        projectNativeSubagents(sub.activation, sub.ordinal);
      const start = p.endedCursor
        ? ended.findIndex((item) => item.childSessionId === p.endedCursor) + 1
        : 0;
      const limit = Math.min(100, Math.max(1, Math.trunc(num(p.endedLimit, 20))));
      const items = ended.slice(start, start + limit);
      const nextCursor = start + limit < ended.length ? items.at(-1)?.childSessionId : undefined;
      return {
        revision, childSessionIds, running,
        ended: { total: ended.length, items, ...(nextCursor ? { nextCursor } : {}) },
      };
    }
    if (method === "conversationRowsRangeV4" || method === "conversationPlansV4") {
      const session = str(p.sessionId),
        sub = [...this.subscriptions.values()].find((s) => s.session === session);
      if (sub && !sub.activation) await this.schedule(sub);
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
        sub?.rowIdStart,
      );
      const versions = { atSeq: seq, atRevision: seq, atLogEpoch: epoch };
      if (method === "conversationRowsRangeV4") {
        let rows = snapshot.rows.window.filter(
          (r) => typeof p.beforeRowId !== "number" || r.rowId < p.beforeRowId,
        );
        const limit = Math.max(1, num(p.limit, 100));
        const rowIdStart = sub?.rowIdStart;
        while (sub && rows.length < limit && info.oldestTimelineCursor) {
          await this.loadOlder(sub, info, session);
          if (
            !this.subscriptions.has(sub.subscriptionId) ||
            sub.activation !== info ||
            sub.rowIdStart !== rowIdStart ||
            sub.needsActivation
          )
            throw Error("Codex 历史快照已更新");
          snapshot = projectThread(info, session, epoch, seq, this.models, sub.rowIds, sub.rowIdStart);
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
      return {
        atSeq: seq,
        atLogEpoch: epoch,
        plans: snapshot.rows.window.filter(
          (r) => r.kind === "toolCall" && r.toolName === "ExitPlanMode",
        ),
      };
    }
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
        dirty: false,
        rowIds: new Map(),
        needsActivation: kind === "conversation",
        generation: 0,
        olderCursors: new Set(),
        oldestRowId: nativeHistoryRowStart,
        rowIdStart: nativeHistoryRowStart,
      };
      this.subscriptions.set(sub.subscriptionId, sub);
      if (kind === "conversation") {
        try {
          await this.schedule(sub);
          if (!sub.activation) throw Error("Codex 历史快照已更新");
        } catch (error: unknown) {
          void this.removeSubscription(sub.subscriptionId);
          throw error;
        }
      } else this.defer(sub, 0);
      return { ack: { subscriptionId: sub.subscriptionId, mode: "snapshot", logEpoch: sub.epoch } };
    }
    if (method.startsWith("unsubscribe")) {
      await this.removeSubscription(str(p.subscriptionId));
      return;
    }
    if (method.startsWith("resync")) {
      const sub = this.subscriptions.get(str(p.subscriptionId));
      if (!sub) throw Error("fault.subscription.notOwned");
      await this.schedule(sub);
      // 补同步接收端通过 result.ack 核对订阅；平铺响应会让正在流式输出的会话进入错误页。
      return {
        ack: { subscriptionId: sub.subscriptionId, mode: "snapshot", logEpoch: sub.epoch },
      } satisfies V4ConversationResyncResult;
    }
    throw Error("Unsupported native subscription operation: " + method);
  }
  private async removeSubscription(id: string) {
    const sub = this.subscriptions.get(id);
    this.subscriptions.delete(id);
    if (!sub) return;
    clearTimeout(sub.timer);
    if (
      sub.session &&
      !Array.from(this.subscriptions.values()).some((s) => s.session === sub.session)
    )
      await this.gateway
        .send({ type: "thread.unsubscribe", hostId: this.hostId, threadId: sub.session })
        .catch(() => {});
  }
}
