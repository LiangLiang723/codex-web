import { NativeThreadCatalog } from "./taskCatalog.js";
import { SessionSubscriptions } from "./sessionSubscriptions.js";
import {
  V4_WIRE_PROTOCOL_VERSION,
  commandEnvelopeSchema,
  commandsQueryParamsSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { type Gateway, type Message, type RemoteModel } from "./gateway.js";
import {
  array,
  nativeMode,
  num,
  projectThread,
  rec,
  str,
} from "./threadProjection.js";
import { z } from "zod";
import { readNativeImageChunk } from "./attachments.js";
import {
  NativeDeliveryPending,
  createNativeThreadForInput,
  reconcileNativeDelivery,
  submitNativeInput,
} from "./nativeDelivery.js";
import { buildNativeTurnInput } from "./nativeTurnInput.js";
import { nativeInteractionResult, nativeRequests } from "./nativeInteractions.js";
import { TurnFileBridge } from "./turnFileChanges.js";
import { flushBrowserState } from "./browserState.js";
type Emit = (channel: string, event: string, value: unknown) => void;

/** Translate the original ZCode service/channel contracts. Codex alone creates and persists Thread IDs. */
export class SessionBridge {
  private readonly streams: SessionSubscriptions;
  private readonly turnFiles;
  private readonly acknowledgements = new Map<string, Promise<unknown>>();
  constructor(
    readonly gateway: Gateway,
    readonly hostId: number,
    readonly cwd: string,
    readonly models: RemoteModel[],
    private readonly emit: Emit,
    private readonly nativeProjectId: (id: string) => Promise<string | undefined>,
    loadModelCatalog?: (provider?: string) => Promise<RemoteModel[]>,
  ) {
    this.tasks = new NativeThreadCatalog(gateway, hostId, cwd);
    this.streams = new SessionSubscriptions(
      gateway,
      hostId,
      cwd,
      models,
      emit,
      (path) => this.tasks.threads(path),
      loadModelCatalog,
    );
    this.turnFiles = new TurnFileBridge(
      gateway,
      hostId,
      cwd,
      this.streams.epoch,
      () => this.streams.subscriptions.values(),
      (sub, info, session) =>
        projectThread(info, session, sub.epoch, sub.ordinal, this.models, sub.rowIds),
      (sub) => this.streams.defer(sub),
    );
  }
  get epoch() {
    return this.streams.epoch;
  }
  dispose() {
    this.streams.dispose();
  }
  readonly tasks: NativeThreadCatalog;
  threads(cwd?: string, search?: string) {
    return this.tasks.threads(cwd, search);
  }

  async lifecycle(session: string) {
    // 准备查询不打开原生线程。安装事件接收者后才在 subscribeConversationV4 中激活。
    return { sessionId: session, state: "ready", generation: 1, revision: 0, lastError: null };
  }
  async handle(method: string, p: Message): Promise<unknown> {
    if (method === "attachmentReadV4") {
      const session = str(p.sessionId);
      const sub = [...this.streams.subscriptions.values()].find(
        (candidate) => candidate.session === session,
      );
      const info = sub?.activation ?? (await this.streams.activation(session));
      const history = rec(rec(info.history).thread);
      const turns = array(history.turns ?? rec(info.thread).turns);
      return readNativeImageChunk(this.gateway, this.hostId, turns, p);
    }
    if (method === "conversationFileChangesV4" || method === "conversationFileRewindPreviewV4")
      return this.turnFiles.read(p, method === "conversationFileRewindPreviewV4");
    if (method === "conversationRowsRangeV4" || method === "conversationPlansV4" || method === "listSessionSubagents")
      return this.streams.handle(method, p);
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
      /^(subscribe|unsubscribe|resync)(Conversation|SessionsIndex|WorkspaceConfig)V4$/.test(method)
    )
      return this.streams.handle(method, p);
    if (method === "queryConversationCommandsV4") {
      const { commands } = commandsQueryParamsSchema.parse({ commands: p.commands });
      return reconcileNativeDelivery(this.gateway, this.hostId, this.cwd, commands);
    }
    if (method === "sendConversationCommandV4") {
      const command = commandEnvelopeSchema.parse(p.envelope);
      const previous = this.acknowledgements.get(command.commandId);
      if (previous) return previous;
      if (command.type === "applyFileRewind") {
        const operation = this.turnFiles.apply(command);
        this.acknowledgements.set(command.commandId, operation);
        const ack = await operation;
        if (ack.status !== "accepted") this.acknowledgements.delete(command.commandId);
        return ack;
      }
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
        (err) => {
          if (err instanceof NativeDeliveryPending) {
            // failed 会释放首发草稿身份；本次仅缺少可确认的远端接纳证据。
            this.acknowledgements.delete(command.commandId);
            throw err;
          }
          return {
            commandId: command.commandId,
            status: "failed",
            revisionAtDecision: 0,
            reasonCode: "codex.commandFailed",
            message: err instanceof Error ? err.message : String(err),
          };
        },
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
    // 网页存储改由网关异步提交，首发和发送前仍要确认恢复线索已经落库。
    if (type === "createSession" || type === "sendText") await flushBrowserState(this.gateway);
    const config = rec(p.config),
      first = rec(p.firstInput),
      selection = rec(p.modelSelection ?? first.modelSelection ?? config.modelSelection),
      model = str(selection.modelId) || str(p.model) || undefined;
    const effort = str(rec(selection.options).reasoningLevel) || str(p.thought) || undefined;
    if (type === "createSession") {
      const material = buildNativeTurnInput(first);
      const firstInputExpected = Boolean(material.text.trim() || material.files.length);
      const nativeProjectId = projectId ? await this.nativeProjectId(projectId) : undefined;
      const { threadId: id, previous } = await createNativeThreadForInput(
        this,
        commandId,
        firstInputExpected,
        {
          model,
          effort,
          ...(nativeProjectId ? { projectId: nativeProjectId } : {}),
          ...(config.mode ? nativeMode(config.mode) : {}),
        },
      );
      // 网关已在首轮提交前绑定真实 Thread；任何晚回执都查询同一个创建命令。
      const input =
        !previous && firstInputExpected
          ? await this.sendText(id, { ...first, modelSelection: selection }, commandId, true)
          : undefined;
      for (const s of this.streams.subscriptions.values())
        if (s.kind === "index") this.streams.defer(s, 0);
      this.emit("zcode-task", "onDynamicWorkspaceEvent", {
        type: "workspace_task_list_changed",
        workspacePath: this.cwd,
      });
      this.emit("broadcast", "onMessage", { channel: "state:projects", payload: {} });
      return previous ?? { type: "createSession", sessionId: id, ...(input ? { input } : {}) };
    }
    if (!sessionId) throw Error("No native thread selected");
    const opened = [...this.streams.subscriptions.values()].find(
      (sub) => sub.session === sessionId,
    )?.activation;
    if (opened?.readOnly === true && type !== "forkAssistant")
      throw Error("此会话由另一端持有，释放后请重新连接");
    if (type === "sendText") return this.sendText(sessionId, p, commandId);
    if (type === "setFollowupMode") {
      this.streams.followupMode = p.mode === "queue" ? "queue" : "guide";
      for (const sub of this.streams.subscriptions.values()) this.streams.defer(sub, 0);
      return;
    }
    if (type === "deleteQueueItem") {
      if (rec(opened?.nativeControls).queue !== true) throw Error("当前 Codex 主机不支持队列操作");
      await this.gateway.call("thread.queue.delete", {
        hostId: this.hostId,
        threadId: sessionId,
        queuedSubmissionId: str(p.queueItemId),
      });
      this.streams.refreshThreadControls(sessionId);
      return;
    }
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
      for (const sub of this.streams.subscriptions.values())
        if (sub.session === sessionId && sub.activation) {
          sub.activation.goal = response.goal;
          this.streams.defer(sub);
        }
      if (type === "sendGoalCommand" && !this.streams.lastTurn.has(sessionId))
        return this.sendText(sessionId, { ...p, text }, commandId);
      return;
    }
    if (type === "forkAssistant") {
      if (rec(opened?.nativeControls).fork !== true || p.targetCwd)
        throw Error("当前 Codex 会话不支持此分支方式");
      const sub = [...this.streams.subscriptions.values()].find((s) => s.session === sessionId),
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
      if (
        row?.kind !== "assistantText" ||
        row.entityId !== rec(p.target).entityId ||
        row.actions?.canFork !== true ||
        (turnId && turnId !== row.turnId)
      )
        throw Error("请选择已完成轮次的回复创建分支");
      const fork = await this.gateway.call("thread.fork", {
        hostId: this.hostId,
        threadId: sessionId,
        turnId: row.turnId,
        boundary: "after",
      });
      return { type: "forkAssistant", sessionId: str(fork.threadId) || str(rec(fork.thread).id) };
    }
    if (type === "compact") {
      if (rec(opened?.nativeControls).compact !== true || this.streams.lastTurn.has(sessionId))
        throw Error("当前 Codex 会话尚不能压缩上下文");
      await this.gateway.call("thread.native.compact", {
        hostId: this.hostId,
        threadId: sessionId,
      });
      return;
    }
    if (type === "stop") {
      const id = this.streams.lastTurn.get(sessionId);
      if (id)
        await this.gateway.call("turn.interrupt", {
          hostId: this.hostId,
          threadId: sessionId,
          turnId: id,
        });
      return;
    }
    if (type === "resolveInteraction") {
      const live = [...this.streams.subscriptions.values()].find(
        (sub) => sub.kind === "conversation" && sub.session === sessionId && !sub.needsActivation,
      )?.activation;
      const epoch = str(live?.eventEpoch);
      const turns = array(rec(rec(live?.history).thread).turns);
      const request = live && epoch
        ? nativeRequests(live, turns).find(({ key }) => key === p.interactionId)
        : undefined;
      if (!request) throw Error("此审批已处理或已失效，请刷新会话");
      const answer = rec(p.answer);
      await this.gateway.call("serverRequest.respond", {
        hostId: this.hostId,
        threadId: sessionId,
        serverRequestId: request.id,
        eventEpoch: epoch,
        result: nativeInteractionResult(request, answer),
      });
      return {
        type: "resolveInteraction",
        resolvedBy: { clientId: this.epoch, optionId: str(answer.optionId) || str(answer.action) || undefined },
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
      for (const s of this.streams.subscriptions.values())
        if (s.session === sessionId) {
          this.streams.invalidate(s);
          this.streams.defer(s);
        }
      return;
    }
    throw Error("This operation is unavailable for the selected Codex CLI: " + type);
  }
  private async sendText(id: string, p: Message, commandId: string, first = false) {
    const active = [...this.streams.subscriptions.values()].find(
      (sub) => sub.session === id,
    )?.activation;
    const { input, turnId } = await submitNativeInput(this, id, p, commandId, {
      active,
      first,
      running: this.streams.lastTurn.get(id),
      followupMode: this.streams.followupMode,
    });
    if (input.delivery === "queue") this.streams.refreshThreadControls(id);
    else if (turnId) this.streams.lastTurn.set(id, turnId);
    return input;
  }
}
