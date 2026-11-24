import {
  computeAvailability,
  computeInputRouting,
  createInitialConversationSnapshot,
} from "virtual:zcode-projection-state";
import type {
  ConversationRow,
  ConversationSnapshot,
  PendingInteraction,
  SessionPhase,
} from "@zcode/shared/zcode-protocol-v4";
import type { Message, RemoteModel } from "./gateway.js";

export function rec(v: unknown): Message {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v))
    : {};
}
export function array(v: unknown): Message[] {
  return Array.isArray(v) ? v.map(rec) : [];
}
export function str(v: unknown, fallback = "") {
  return typeof v === "string" ? v : fallback;
}
export function num(v: unknown, fallback = 0) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
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
export const providerId = "codex-ssh";
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
export function projectThread(
  activation: Message,
  id: string,
  epoch: string,
  revision: number,
  registry: RemoteModel[],
  rowIds: Map<string, number>,
): ConversationSnapshot {
  const history = rec(activation.history),
    thread = { ...rec(activation.thread), ...rec(history.thread) },
    turns = array(thread.turns);
  const settings = rec(activation.threadSettings ?? history.settings),
    collaboration = rec(settings.collaborationMode);
  const result = createInitialConversationSnapshot(id, epoch);
  const modelId =
    str(settings.model) ||
    str(thread.model) ||
    registry.find((m) => m.isDefault)?.model ||
    registry[0]?.model ||
    "";
  const model = registry.find((m) => m.model === modelId);
  const thought =
    str(settings.effort) ||
    str(rec(collaboration.settings).reasoningEffort) ||
    model?.defaultReasoningEffort ||
    "";
  result.seq = revision;
  result.revision = revision;
  result.meta = {
    title: threadName(thread),
    titleSource: typeof thread.name === "string" ? "custom" : "generated",
  };
  result.config = {
    ...result.config,
    provider: providerId,
    model: modelId,
    thought,
    thoughtLevels: (model?.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort),
    mode:
      settings.approvalPolicy === "never" && rec(settings.sandboxPolicy).type === "dangerFullAccess"
        ? "yolo"
        : "build",
    planEnabled: collaboration.mode === "plan",
    ...(modelId
      ? { modelSelection: { providerId, modelId, options: { reasoningLevel: thought } } }
      : {}),
  };
  const rows: ConversationRow[] = [];
  const interactions: PendingInteraction[] = [];
  const created = time(thread.createdAt, 0);
  const base = (turnId: string, entityId: string, at: number) => {
    const key = JSON.stringify([turnId, entityId]);
    let rowId = rowIds.get(key);
    if (rowId === undefined) {
      rowId = rowIds.size + 1;
      rowIds.set(key, rowId);
    }
    return { rowId, entityId, turnId, productTurnId: turnId, createdAt: at, createdAtSeq: rowId };
  };
  for (const turn of turns) {
    const turnId = str(turn.id);
    const at = time(turn.startedAt, created);
    const phase = threadPhase(turn.status);
    const state =
      phase === "error"
        ? "failed"
        : phase === "completedInterrupted"
          ? "completedInterrupted"
          : phase === "running"
            ? "running"
            : "completedSuccess";
    rows.push({
      ...base(turnId, "turn:" + turnId, at),
      kind: "turnHeader",
      origin: "userInput",
      state,
      startedAt: at,
      ...(turn.completedAt ? { endedAt: time(turn.completedAt, at) } : {}),
    });
    for (const item of array(turn.items)) {
      const itemId = str(item.id);
      if (!itemId) continue;
      const fields = base(turnId, itemId, at),
        stream = phase === "running" && item.status !== "completed";
      if (item.type === "userMessage") {
        rows.push({
          ...fields,
          kind: "userInput",
          origin: "realUser",
          text: plain(item.content ?? item.text),
        });
      } else if (item.type === "agentMessage") {
        rows.push({
          ...fields,
          kind: "assistantText",
          text: plain(item.text ?? item.content),
          state: stream ? "streaming" : "complete",
          model: modelId,
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
        result.plan = {
          updatedAt: at,
          items: array(item.plan).map((step, i) => ({
            id: itemId + "-" + i,
            content: str(step.step),
            status:
              step.status === "completed"
                ? "completed"
                : step.status === "inProgress"
                  ? "inProgress"
                  : "pending",
          })),
        };
      } else if (item.type === "reasoning") {
        rows.push({
          ...fields,
          kind: "reasoning",
          text: plain(item.summary) || plain(item.content),
          state: stream ? "streaming" : "complete",
        });
      } else {
        const command = str(item.command),
          toolName = command ? "Bash" : str(item.tool) || str(item.type);
        const input = command
          ? { command, cwd: str(item.cwd, str(thread.cwd)) }
          : (item.arguments ?? item.changes ?? item.input ?? {});
        const output = item.aggregatedOutput ?? item.result ?? item.output;
        const request = item.requestId ?? rec(item.pendingApproval).requestId;
        const pending = request !== null && request !== undefined;
        const requestKey = String(request);
        rows.push({
          ...fields,
          kind: "toolCall",
          toolCallId: itemId,
          toolName,
          inputText: typeof input === "string" ? input : JSON.stringify(input),
          input,
          status: pending
            ? "pendingApproval"
            : item.status === "failed" || num(item.exitCode) !== 0
              ? "error"
              : item.status === "inProgress"
                ? "running"
                : "success",
          ...(output != null
            ? { output: { text: typeof output === "string" ? output : JSON.stringify(output) } }
            : {}),
          ...(pending ? { approvalInteractionId: requestKey } : {}),
        });
        const params = rec(item.params ?? rec(item.pendingApproval).params);
        const method = str(item.method ?? rec(item.pendingApproval).method);
        if (pending && method === "mcpServer/elicitation/request") {
          // MCP 的表单、链接与命令审批使用不同的响应结构。保留原始请求信息。
          interactions.push({
            interactionId: requestKey,
            kind: "userInput",
            anchorRowId: fields.rowId,
            createdAt: at,
            payload: {
              kind: "userInput",
              prompt: str(params.message),
              freeText: false,
              toolName: "McpElicitation",
              schema: {
                interaction: "mcp.structured",
                mode: params.mode ?? "form",
                serverName: str(params.serverName),
                requestedSchema: params.requestedSchema,
                url: params.url,
              },
            },
          });
        } else if (pending && method === "item/tool/requestUserInput") {
          const questions = array(params.questions).map((q) => ({
            question: str(q.question),
            header: str(q.header),
            options: array(q.options).map((o) => ({
              value: str(o.label),
              label: str(o.label),
              description: str(o.description),
            })),
          }));
          interactions.push({
            interactionId: requestKey,
            kind: "userInput",
            anchorRowId: fields.rowId,
            createdAt: at,
            payload: {
              kind: "userInput",
              prompt: questions[0]?.question || "Codex 需要你的输入",
              freeText: true,
              questions,
            },
          });
        } else if (
          pending &&
          [
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
            "item/permissions/requestApproval",
          ].includes(method)
        ) {
          interactions.push({
            interactionId: requestKey,
            kind: "permission",
            anchorRowId: fields.rowId,
            createdAt: at,
            payload: {
              kind: "permission",
              toolCallId: itemId,
              toolName,
              summary: str(rec(item.pendingApproval).reason) || command || toolName,
              detail: input,
              options: [
                { optionId: "accept", kind: "allowOnce", label: "允许本轮" },
                { optionId: "decline", kind: "deny", label: "拒绝" },
              ],
            },
          });
        }
      }
    }
  }
  const goal = rec(activation.goal);
  if (typeof goal.objective === "string" && goal.objective) {
    const status =
      goal.status === "complete" ? "verified" : goal.status === "active" ? "active" : "paused";
    result.goal = {
      targetId: id + "-" + str(String(goal.createdAt ?? "")),
      objective: goal.objective,
      summaryTitle: null,
      timeUsedSeconds: num(goal.timeUsedSeconds),
      activeRunStartedAtMs: null,
      status,
      iteration: 0,
      iterations: [],
      verifications: [],
    };
  }
  const livePlan = rec(activation.nativePlan);
  if (Array.isArray(livePlan.plan)) {
    result.plan = {
      updatedAt: time(thread.updatedAt, created),
      items: array(livePlan.plan).map((step, i) => ({
        id: str(livePlan.turnId) + "-" + i,
        content: str(step.step),
        status:
          step.status === "completed"
            ? "completed"
            : step.status === "inProgress"
              ? "inProgress"
              : "pending",
      })),
    };
  }
  const last = turns.at(-1);
  const phase = last ? threadPhase(last.status) : "draft";
  result.rows = { window: rows, totalCount: rows.length, firstRowId: rows[0]?.rowId ?? null };
  result.control = {
    ...result.control,
    phase,
    canStop: phase === "running",
    stopState: phase === "running" ? "stoppable" : "idle",
    stopTargetKind: phase === "running" ? "assistant" : "unknown",
  };
  result.pendingInteractions = interactions;
  const context = {
    phase,
    goalStatus: result.goal?.status ?? null,
    compacting: false,
    goalVerifying: false,
    queueLength: 0,
    autoDrain: true,
    activeWorkCount: phase === "running" ? 1 : 0,
    pendingInteractionCount: interactions.length,
  };
  result.availability = computeAvailability(context);
  result.inputRouting = computeInputRouting(context, "guide");
  return result;
}
