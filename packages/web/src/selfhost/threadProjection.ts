import {
  computeAvailability,
  computeInputRouting,
  createInitialConversationSnapshot,
} from "virtual:zcode-projection-state";
import {
  codexConnectionCode,
  type ApiRetryState,
  type AttachmentRef,
  type ConversationRow,
  type ConversationSnapshot,
  type ConversationSource,
  type GoalState,
  type PlanState,
  type SessionErrorInfo,
  type SessionPhase,
} from "@zcode/shared/zcode-protocol-v4";
import type { Message, RemoteModel } from "./gateway.js";
import {
  approvalAnchor,
  isToolApproval,
  nativeRequests,
  projectNativeInteraction,
  projectNativeToolRow,
} from "./nativeInteractions.js";
import { timelinePageToTurns, mergeThreadTurns } from "virtual:gateway-terminal-stream";
import { turnFileHeader } from "./turnFileChanges.js";
import { array, nativeItemDurationMs, num, rec, str } from "./nativeValues.js";
import { projectNativeSubagents } from "./nativeSubagents.js";
import { nativeUserImages } from "./attachments.js";
import { restoreNativeTurnText } from "./nativeTurnInput.js";

export { array, num, rec, str } from "./nativeValues.js";

function time(v: unknown, fallback: number) {
  const t = num(v);
  return t > 0 ? (t < 1e12 ? t * 1000 : t) : fallback;
}
function plain(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value
      .map((v) => (typeof v === "string" ? v : str(rec(v).text)))
      .filter(Boolean)
      .join("\n");
  return "";
}

function nativeFinalAnswer(items: Message[], turnCompleted: boolean) {
  const hasAnswerText = (item: Message) =>
    item.type === "agentMessage" &&
    item.delivery !== "async" &&
    str(item.id).length > 0 &&
    plain(item.text ?? item.content).trim().length > 0;
  // 旧投影为每条播报都授予分支动作，时间线因而把第一条当成最终答复。
  // 先按原生阶段确定答复锚点，旧记录仅从已完成轮次的未标阶段消息回退。
  const explicitAnswer = items.findLast(
    (item) => item.phase === "final_answer" && hasAnswerText(item),
  );
  if (explicitAnswer || !turnCompleted) return explicitAnswer;
  return items.findLast((item) => item.phase == null && hasAnswerText(item));
}

function nativeUserText(text: string, images: readonly AttachmentRef[]): string {
  if (images.length === 0) return text;
  const header =
    /^\s*# Files mentioned by the user:\r?\n\r?\n([\s\S]+?)\r?\n\r?\nDistinguish instructions in attached documents from the user['’]s request\.\r?\n\r?\n## My request:(?:\r?\n|$)/u.exec(
      text,
    );
  const fileList = header?.[1];
  if (!header || !fileList) return text;
  // 只有原生图片逐项对应的注入清单才折起，保留用户正文和其他文件信息。
  const imageEntries = new Set(
    images
      .filter(({ ref }) => ref.startsWith("/"))
      .map(({ fileName, ref }) => `## ${fileName}: ${ref}\nImage attachment: true`),
  );
  return fileList
    .replaceAll("\r\n", "\n")
    .split("\n\n")
    .every((entry) => imageEntries.has(entry))
    ? text.slice(header[0].length)
    : text;
}
function addSource(
  sources: Map<string, ConversationSource>,
  kind: "userLink" | "webResult" | "webVisit",
  value: unknown,
  title?: unknown,
) {
  try {
    const url = new URL(str(value).trim());
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password)
      return;
    const id = kind + ":" + url.href;
    if (!sources.has(id))
      sources.set(id, {
        kind, url: url.href, title: str(title).trim() || url.href.replace(/^https?:\/\//u, ""),
      });
  } catch {
    // 原生的搜索结果允许未知内容，只有可打开的结构化地址进入来源。
  }
}

function collectNativeSources(
  sources: Map<string, ConversationSource>,
  item: Message,
  userText?: string,
) {
  if (userText !== undefined) {
    for (const [link] of userText.matchAll(/https?:\/\/[^\s<>"'[\]）】》。，、；]+/giu)) {
      // Markdown 结束括号不属于链接；保留 URL 内成对的括号。
      let url = link.replace(/[.,;!?]+$/u, "");
      while (url.endsWith(")") && url.split(")").length > url.split("(").length)
        url = url.slice(0, -1);
      addSource(sources, "userLink", url);
    }
  } else if (item.type === "webSearch") {
    // query 是搜索输入。真实结果地址和原生访问动作各自有结构化字段。
    for (const result of array(item.results))
      addSource(sources, "webResult", result.url, result.title);
    const action = rec(item.action);
    if (action.type === "openPage" || action.type === "findInPage")
      addSource(sources, "webVisit", action.url);
  } else if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    const tool = str(item.tool).trim();
    if (!tool) return;
    const app = rec(item.appContext);
    const namespace = str(item.server ?? item.namespace).trim();
    const id = JSON.stringify([item.type, str(app.connectorId), namespace, tool]);
    sources.set(id, {
      kind: "tool",
      id,
      title: str(app.appName).trim() || namespace || tool,
      tool: str(app.actionName).trim() || tool,
    });
  }
}

function projectNativePlan(item: Message, at: number): PlanState {
  const planId = str(item.id) || str(item.turnId);
  return {
    updatedAt: at,
    items: array(item.plan).flatMap((step, index) => {
      const content = str(step.step).trim();
      if (!content) return [];
      const status = step.status === "completed" ? "completed" :
        step.status === "inProgress" ? "inProgress" : "pending";
      return [{ id: planId + "-" + index, content, status }];
    }),
  };
}

function nativeGoalStatus(value: unknown): NonNullable<GoalState["nativeCodex"]>["status"] | undefined {
  switch (value) {
    case "active":
    case "paused":
    case "blocked":
    case "usageLimited":
    case "budgetLimited":
    case "complete":
      return value;
  }
}

export const providerId = "codex-ssh";
export const nativeHistoryRowStart = 2 ** 40;
function nativeHistoryRowKey(turnId: string, entityId: string, sourceCommandId = "") {
  return JSON.stringify(
    sourceCommandId ? [turnId, "input", sourceCommandId] : [turnId, "item", entityId],
  );
}
export function refreshNativeHistoryPage(info: Message, page: Message, threadId: string) {
  const turns = timelinePageToTurns(page);
  if (turns.length === 0) return false;
  const previous = new Map(
    array(rec(rec(info.history).thread).turns).map((turn) => [turn.id, turn]),
  );
  const cursor = str(page.nextCursor);
  // 有续页时需要确认新旧窗口连续。同一轮可能长过整页，仅比较轮次 ID 会漏掉中间条目。
  const overlaps = turns.some((turn) => {
    const older = previous.get(turn.id);
    if (!older) return false;
    const olderItems = array(older.items);
    const ids = new Set(olderItems.map((item) => item.id));
    return olderItems.length === 0 || array(turn.items).some((item) => ids.has(item.id));
  });
  const reanchored = Boolean(cursor && previous.size && !overlaps);
  const incoming = turns.map((turn) => {
    const older = previous.get(turn.id);
    return {
      ...turn,
      status: turn.status ?? older?.status ?? "inProgress",
      startedAt: turn.startedAt ?? older?.startedAt,
    };
  });
  info.history = mergeThreadTurns(
    reanchored ? null : info.history,
    reanchored ? null : info.thread,
    threadId,
    incoming,
    "append",
  );
  if (reanchored || previous.size === 0) info.oldestTimelineCursor = cursor;
  return reanchored;
}

export function prependNativeHistoryPage(
  info: Message,
  page: Message,
  threadId: string,
  registry: RemoteModel[],
  rowIds: Map<string, number>,
  oldestRowId: number,
) {
  const existing = new Map(
    array(rec(rec(info.history).thread).turns).map((turn) => [turn.id, turn]),
  );
  const turns = timelinePageToTurns(page).map((turn) => {
    const latest = existing.get(turn.id);
    if (!latest) return turn;
    // 旧页可能只有 turnStarted，当前页或实时通知已经收到了完成和失败原因。
    return {
      ...turn,
      ...latest,
      startedAt: latest.startedAt ?? turn.startedAt,
      items: turn.items,
    };
  });
  const previous = projectThread(
    { history: { thread: { id: threadId, turns } } },
    threadId,
    "",
    0,
    registry,
    new Map(),
  ).rows.window;
  const keys = previous.flatMap((row) => {
    const turnId = row.turnId ?? "";
    const itemKey = nativeHistoryRowKey(turnId, row.entityId ?? "");
    const key = nativeHistoryRowKey(
      turnId,
      row.entityId ?? "",
      row.kind === "userInput" ? row.sourceCommandId : undefined,
    );
    return !rowIds.has(itemKey) && !rowIds.has(key) ? [key] : [];
  });
  const start = oldestRowId - 2 * keys.length;
  for (const [index, key] of keys.entries()) rowIds.set(key, start + 2 * index);
  info.history = mergeThreadTurns(info.history, info.thread, threadId, turns, "prepend");
  info.oldestTimelineCursor = str(page.nextCursor);
  return start;
}
export function threadName(t: Message) {
  return str(t.name) || str(t.title) || str(t.preview) || str(t.id);
}
export function nativeMode(m: unknown) {
  return m === "yolo"
    ? { approvalPolicy: "never", sandbox: "danger-full-access" }
    : m === "guarded"
      ? { approvalPolicy: "untrusted", sandbox: "workspace-write" }
      : { approvalPolicy: "on-request", sandbox: "workspace-write" };
}

export function nativeSandboxPolicy(mode: unknown, current: Message) {
  if (mode === "yolo") return { type: "dangerFullAccess" };
  // 切换确认方式保留原沙箱限制；只有离开全访问时才恢复工作区约束。
  return current.type && current.type !== "dangerFullAccess"
    ? current
    : {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
}

function nativeCompactionItem(turn: Message | undefined) {
  if (turn?.status !== "inProgress") return undefined;
  return array(turn.items).findLast(
    (item) =>
      item.type === "contextCompaction" &&
      (item.status === "inProgress" ||
        (!item.status && typeof item.startedAtMs === "number" && !item.completedAtMs)),
  );
}

export function nativeTurnIsCompacting(activation: Message | undefined) {
  return Boolean(nativeCompactionItem(array(rec(rec(activation?.history).thread).turns).at(-1)));
}
export function threadPhase(status: unknown): SessionPhase {
  switch (status) {
    case "inProgress":
    case "running":
      return "running";
    case "interrupted":
      return "completedInterrupted";
    case "failed":
      return "error";
    default:
      return "completedSuccess";
  }
}

export function applyCodexRecoveryEvent(info: Message, envelope: Message, threadId: string) {
  const event = rec(envelope.event);
  if (event.type === "turn.started") {
    info.apiRetry = null;
    return;
  }
  const params = rec(event.params);
  const fallback =
    event.type === "notice" &&
    event.source === "warning" &&
    params.threadId === threadId &&
    str(params.message).startsWith("Falling back from WebSockets to HTTPS transport");
  const modelDelta =
    event.type === "timeline.item.delta" && event.channel !== "commandOutput" && str(event.delta);
  const item = event.type === "timeline.item.upsert" ? rec(event.item) : null;
  const modelItem =
    item &&
    typeof item.type === "string" &&
    item.type !== "userMessage" &&
    (item.status === "inProgress" || item.type === "agentMessage");
  if (
    !fallback &&
    !modelDelta &&
    !modelItem &&
    event.type !== "error.reported" &&
    event.type !== "turn.completed"
  )
    return;

  const turns = rec(rec(info.history).thread).turns;
  const active = rec(Array.isArray(turns) ? turns.at(-1) : null);
  if (active.status !== "inProgress") return;
  if (event.type === "turn.completed" && rec(event.turn).id === active.id) info.apiRetry = null;
  if (modelDelta && event.turnId === active.id) info.apiRetry = null;
  if (modelItem && item.turnId === active.id) info.apiRetry = null;
  if (!fallback && (event.type !== "error.reported" || params.turnId !== active.id)) return;
  if (!fallback && params.willRetry !== true) {
    info.apiRetry = null;
    return;
  }

  // Codex 可能在第二次尝试才发出第一条重试通知，部分错误也没有计数。
  const count = /^Reconnecting(?:\.\.\.|…)\s+(\d+)\/(\d+)$/i.exec(
    str(rec(params.error).message).trim(),
  );
  info.apiRetry = {
    attempt: count ? Number(count[1]) : 0,
    maxAttempts: count ? Number(count[2]) + 1 : 0,
    nextRetryAt: Date.parse(str(envelope.createdAt)) || Date.now(),
    reasonCode: fallback ? codexConnectionCode.httpsFallback : codexConnectionCode.retry,
  } satisfies ApiRetryState;
}

function codexTurnError(turn: Message, at: number): SessionErrorInfo {
  const error = rec(turn.error);
  const message = str(error.message);
  const details = `${message}\n${str(error.additionalDetails)}`;
  const timedOut = /\b(?:timed?\s*out|deadline exceeded)\b/i.test(details);
  const kind = rec(error.codexErrorInfo);
  const network =
    [
      "httpConnectionFailed",
      "responseStreamConnectionFailed",
      "responseStreamDisconnected",
      "responseTooManyFailedAttempts",
    ].some((code) => Object.hasOwn(kind, code)) ||
    /\b(?:stream disconnected|connection (?:closed|reset|refused)|network error|error sending request)\b/i.test(
      details,
    ) ||
    (timedOut &&
      (/\b(?:stream|connection|connect|websocket|network)\b/i.test(details) ||
        /^(?:timed?\s*out|deadline exceeded)[.!]?$/i.test(message.trim())));
  if (!network) {
    // 配额、上下文和工具等失败同样由原生 turn/completed 决定，保留服务端原因供用户判断。
    const nativeCode = str(error.codexErrorInfo) || Object.keys(kind)[0] || "turnFailed";
    return {code:"codex."+nativeCode,message:message || str(error.additionalDetails) || nativeCode,
      ...(message && str(error.additionalDetails) ? {detail:str(error.additionalDetails)} : {}),
      source:"provider",recoverable:true,at:time(turn.completedAt,time(turn.startedAt,at))};
  }
  return {
    code: timedOut ? codexConnectionCode.timeout : codexConnectionCode.failed,
    message: timedOut ? "Model connection timed out." : "Model connection failed.",
    source: "network",
    recoverable: true,
    at: time(turn.completedAt, time(turn.startedAt, at)),
  };
}

export function projectThread(
  activation: Message,
  id: string,
  epoch: string,
  revision: number,
  registry: RemoteModel[],
  rowIds: Map<string, number>,
  rowIdStart = nativeHistoryRowStart,
): ConversationSnapshot {
  const history = rec(activation.history),
    stored = rec(history.thread),
    thread = { ...stored, ...rec(activation.thread) },
    historyTurns = array(stored.turns ?? thread.turns),
    turns = historyTurns.filter((turn) => !str(turn.id).startsWith("server-request-turn-"));
  const requests = nativeRequests(activation, historyTurns);
  const settings = rec(activation.threadSettings ?? history.settings),
    collaboration = rec(settings.collaborationMode);
  const result = createInitialConversationSnapshot(id, epoch);
  if (Array.isArray(activation.nativeModels)) registry = activation.nativeModels as RemoteModel[];
  const controls = rec(activation.nativeControls);
  const queueAvailable = controls.queue === true && activation.readOnly !== true;
  const followupMode = queueAvailable && activation.followupMode === "queue" ? "queue" : "guide";
  const nativeChild =
    activation.readOnlyReason === "subagent" ||
    Boolean(str(thread.parentThreadId).trim()) ||
    Object.hasOwn(rec(thread.source), "subAgent");
  // 冷读子 Thread 的有效配置在原生元数据里。缺字段时保留空值，避免显示工作区默认值。
  const modelId =
    str(settings.model) ||
    str(thread.model) ||
    (nativeChild ? "" : (registry.find((m) => m.isDefault)?.model ?? registry[0]?.model ?? ""));
  const model = registry.find((m) => m.model === modelId);
  const thought =
    str(settings.effort) ||
    str(rec(collaboration.settings).reasoningEffort ?? rec(collaboration.settings).reasoning_effort) ||
    (settings.effort === null ? "" : str(thread.reasoningEffort)) ||
    (nativeChild ? "" : (model?.defaultReasoningEffort ?? ""));
  result.seq = revision;
  result.revision = revision;
  result.meta = {
    title: threadName(thread),
    titleSource: typeof thread.name === "string" ? "custom" : "generated",
    ...(activation.readOnly === true && activation.readOnlyReason !== "subagent"
      ? {
          readOnlyReason:
            activation.readOnlyReason === "modelProviderMismatch"
              ? "modelProviderMismatch"
              : "activeWriter",
        }
      : {}),
  };
  result.config = {
    ...result.config,
    followupMode,
    provider: providerId,
    ...(typeof thread.modelProvider === "string"
      ? { nativeModelProvider: thread.modelProvider }
      : {}),
    model: modelId,
    thought,
    thoughtLevels: (model?.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort),
    mode:
      settings.approvalPolicy === "never" && rec(settings.sandboxPolicy).type === "dangerFullAccess"
        ? "yolo"
        : settings.approvalPolicy === "untrusted"
          ? "guarded"
          : "build",
    planEnabled: collaboration.mode === "plan",
    ...(modelId
      ? { modelSelection: { providerId, modelId, options: thought ? {reasoningLevel:thought} : {} } }
      : {}),
  };
  const rows: ConversationRow[] = [];
  const sources = new Map<string, ConversationSource>();
  const toolAnchors = new Map<string, { rowId: number; item: Message }>();
  const pendingToolApprovals = new Map<string, string>();
  for (const request of requests) {
    if (!isToolApproval(request)) continue;
    const key = approvalAnchor(request);
    if (key && !pendingToolApprovals.has(key)) pendingToolApprovals.set(key, request.key);
  }
  const created = time(thread.createdAt, 0);
  const base = (
    turnId: string,
    entityId: string,
    at: number,
    sourceCommandId = "",
    initialInputRowId?: number,
  ) => {
    const itemKey = nativeHistoryRowKey(turnId, entityId);
    const key = nativeHistoryRowKey(turnId, entityId, sourceCommandId);
    let rowId = initialInputRowId ?? rowIds.get(key) ?? rowIds.get(itemKey);
    if (rowId === undefined) {
      // 回合首条输入可能晚于答复送达。标题后一位留给它，其余已发布行的编号不变。
      rowId = rowIdStart + 2 * rowIds.size;
    }
    rowIds.set(key, rowId);
    if (key !== itemKey) rowIds.set(itemKey, rowId);
    return { rowId, entityId, turnId, productTurnId: turnId, createdAt: at, createdAtSeq: rowId };
  };
  const livePlan = rec(activation.nativePlan);
  for (const turn of turns) {
    const turnId = str(turn.id);
    const at = time(turn.startedAt, created);
    const phase = threadPhase(turn.status);
    const items = array(turn.items);
    const initialInput = items.find((item) => item.type === "userMessage" && item.startsTurn === true);
    const completed = turn.status === "completed";
    const finalAnswer = nativeFinalAnswer(items, completed);
    const canFork = completed && controls.fork === true && activation.readOnly !== true;
    const state =
      phase === "error"
        ? "failed"
        : phase === "completedInterrupted"
          ? "completedInterrupted"
          : phase === "running"
            ? "running"
            : "completedSuccess";
    const header = base(turnId, "turn:" + turnId, at);
    rows.push({
      ...header,
      kind: "turnHeader",
      origin: "userInput",
      state,
      startedAt: at,
      ...(turn.completedAt ? { endedAt: time(turn.completedAt, at) } : {}),
      ...turnFileHeader(activation, turn, str(thread.cwd)),
    });
    let hasPlan = false;
    for (const item of items) {
      const itemId = str(item.id);
      if (!itemId) continue;
      if (item.type !== "userMessage") collectNativeSources(sources, item);
      const sourceCommandId = item.type === "userMessage" ? str(item.clientId) : "";
      const fields = base(
          turnId,
          itemId,
          at,
          sourceCommandId,
          item === initialInput ? header.rowId + 1 : undefined,
        ),
        stream = phase === "running" && item.status !== "completed";
      if (item.type === "userMessage") {
        const { attachments, links } = nativeUserImages(item.content, { turnId, itemId });
        const text = nativeUserText(restoreNativeTurnText(item.content ?? item.text), attachments);
        collectNativeSources(sources, item, text);
        for (const { href, fileName } of links) addSource(sources, "userLink", href, fileName);
        rows.push({
          ...fields,
          kind: "userInput",
          origin: "realUser",
          text,
          ...(sourceCommandId ? { sourceCommandId } : {}),
          ...(attachments.length ? { attachments } : {}),
        });
      } else if (item.type === "agentMessage") {
        const text = plain(item.text ?? item.content);
        if (!text.trim()) continue;
        const isFinalAnswer = item === finalAnswer;
        rows.push({
          ...fields,
          kind: "assistantText",
          presentation: isFinalAnswer ? "finalAnswer" : "progress",
          text,
          state: stream ? "streaming" : "complete",
          model: modelId,
          ...(isFinalAnswer && canFork ? { actions: { canFork: true } } : {}),
        });
      } else if (item.type === "contextCompaction") {
        const running = nativeCompactionItem(turn)?.id === item.id;
        rows.push({
          ...fields, kind: "timelineMarker", lane: "assistantWork",
          marker: {
            type: "compact", origin: "native",
            status: running ? "running" : item.completedAtMs || item.status === "completed"
              ? "success" : phase === "error" ? "failed" : phase === "completedInterrupted"
                ? "cancelled" : "success",
          },
        });
      } else if (item.type === "plan") {
        const plan = plain(item.text ?? item.content);
        rows.push({
          ...fields,
          kind: "toolCall",
          toolCallId: itemId,
          toolName: "ExitPlanMode",
          input: { plan },
          inputText: plan,
          status: stream ? "running" : "success",
          output: { text: plan },
        });
      } else if (item.type === "turnPlan") {
        result.plan = projectNativePlan(item, at);
        hasPlan = true;
      } else if (item.type === "reasoning") {
        // Codex 历史可能只保留完成时间，恢复运行中的轮次时仍要结束该条的思考提示。
        const text = plain(item.summary);
        const summary = Array.isArray(item.summary)
          ? (item.summary.map((part) => plain([part])).findLast((part) => part.trim()) ?? "")
          : text;
        const durationMs = nativeItemDurationMs(item);
        rows.push({
          ...fields,
          kind: "reasoning",
          // 原生可读摘要走独立的流式通道，避免把 reasoningText 当作状态标题。
          text,
          summary,
          state: stream && item.completedAtMs == null ? "streaming" : "complete",
          ...(durationMs === undefined ? {} : { durationMs }),
        });
      } else {
        const anchor = JSON.stringify([turnId, itemId]);
        toolAnchors.set(anchor, { rowId: fields.rowId, item });
        rows.push({
          ...fields,
          ...projectNativeToolRow(item, str(thread.cwd), pendingToolApprovals.get(anchor)),
        });
      }
    }
    // 实时计划已由 Gateway 并入时间线。旧快照近期事件只填补同一轮缺失的计划。
    if (!hasPlan && livePlan.turnId === turnId && Array.isArray(livePlan.plan))
      result.plan = projectNativePlan(livePlan, at);
  }
  if (sources.size) result.sources = [...sources.values()];
  const subagents = projectNativeSubagents(activation, revision);
  result.subagents = { ...subagents, ended: subagents.ended?.slice(0, 20) };
  const interactions = requests.flatMap((request) => {
    const projected = projectNativeInteraction(request, toolAnchors.get(approvalAnchor(request)));
    return projected ? [projected] : [];
  });
  const goal = rec(activation.goal);
  const codexGoal = nativeGoalStatus(goal.status);
  if (typeof goal.objective === "string" && goal.objective && codexGoal) {
    const status =
      codexGoal === "complete" ? "verified" : codexGoal === "active" ? "active" : "paused";
    result.goal = {
      targetId: id + "-" + str(String(goal.createdAt ?? "")),
      objective: goal.objective,
      summaryTitle: null,
      timeUsedSeconds: num(goal.timeUsedSeconds),
      activeRunStartedAtMs: null,
      status,
      nativeCodex: {
        status: codexGoal,
        ...(typeof goal.tokensUsed === "number" && goal.tokensUsed >= 0
          ? { tokensUsed: goal.tokensUsed } : {}),
      },
      iteration: 0,
      iterations: [],
      verifications: [],
    };
  }
  const last = turns.at(-1);
  const phase = last ? threadPhase(last.status) : "draft";
  rows.sort((a, b) => a.rowId - b.rowId);
  result.rows = {
    window: rows,
    totalCount: rows.length,
    firstRowId: rows[0]?.rowId ?? null,
    hasMoreBefore: Boolean(activation.oldestTimelineCursor),
  };
  result.control = {
    ...result.control,
    phase,
    canStop: phase === "running",
    stopState: phase === "running" ? "stoppable" : "idle",
    stopTargetKind: phase === "running" ? "assistant" : "unknown",
    lastError: last && phase === "error" ? codexTurnError(last, created) : null,
    apiRetry:
      phase === "running" && activation.apiRetry ? (activation.apiRetry as ApiRetryState) : null,
  };
  result.queue = {
    // 只显示原生队列成员，顺序由 list 返回，避免暂存假队列与远端自动出队竞态。
    items: queueAvailable
      ? array(controls.queued).flatMap((item, index) => {
          const queueItemId = str(item.id);
          const sourceCommandId = str(item.clientUserMessageId);
          if (!queueItemId || !sourceCommandId) return [];
          const { attachments } = nativeUserImages(item.input);
          return [
            {
              sourceCommandId,
              queueItemId,
              clientId: providerId,
              kind: "sendText" as const,
              text: nativeUserText(restoreNativeTurnText(item.input), attachments),
              attachments,
              admittedAt: time(item.createdAt, 0),
              delivery: { requested: "queue" as const, admitted: "queue" as const },
              order: { admissionSeq: index + 1, queuePosition: index },
              steer: { state: "notRequested" as const },
              dispatch: { state: "queued" as const },
            },
          ];
        })
      : [],
    autoDrain: true,
  };
  const tokenUsage = rec(activation.tokenUsage);
  const totalTokens = rec(tokenUsage.total);
  const maxTokens = num(tokenUsage.modelContextWindow);
  const usedTokens = num(rec(tokenUsage.last).totalTokens, -1);
  result.usage = {
    cumulative: {
      inputTokens: num(totalTokens.inputTokens),
      outputTokens: num(totalTokens.outputTokens),
      cacheReadTokens: num(totalTokens.cachedInputTokens),
      cacheWriteTokens: num(totalTokens.cacheWriteInputTokens),
    },
    contextWindow:
      maxTokens > 0 && usedTokens >= 0
        ? { maxTokens, usedTokens, autoCompactThresholdTokens: null }
        : null,
  };
  const compaction = nativeCompactionItem(last);
  if (compaction) {
    result.control.activeWorks = [
      { kind: "compact", startedAt: time(compaction.startedAtMs, created) },
    ];
    result.control.stopTargetKind = "compact";
  }
  result.pendingInteractions = interactions;
  const context = {
    phase,
    goalStatus: result.goal?.status ?? null,
    compacting: Boolean(compaction),
    goalVerifying: false,
    queueLength: result.queue.items.length,
    autoDrain: true,
    activeWorkCount: phase === "running" ? 1 : 0,
    pendingInteractionCount: interactions.length,
  };
  result.availability = computeAvailability(context);
  if (codexGoal === "budgetLimited" || activation.readOnly === true) {
    result.availability.pauseGoal = { allowed: false, reasonCode: "goalNotActive" };
    result.availability.resumeGoal = { allowed: false, reasonCode: "goalNotPaused" };
  }
  if (controls.fork !== true)
    result.availability.fork = { allowed: false, reasonCode: "forkTargetNotStable" };
  if (controls.compact !== true || phase === "running" || activation.readOnly === true)
    result.availability.compact = {
      allowed: false,
      reasonCode: compaction ? "compactOperationLock" : "idleCannotCompact",
    };
  result.availability.queueEdit = {
    allowed: false,
    reasonCode: "codex.nativeQueueEditUnavailable",
  };
  result.availability.sendQueuedNow = {
    allowed: false,
    reasonCode: "codex.nativeQueueStartUnavailable",
  };
  result.availability.setFollowupMode = queueAvailable
    ? { allowed: true }
    : { allowed: false, reasonCode: "codex.nativeQueueUnavailable" };
  result.inputRouting =
    compaction && !queueAvailable
      ? { mode: "reject", reasonCode: "compactOperationLock" }
      : computeInputRouting(context, followupMode);
  return result;
}
