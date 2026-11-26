import {
  nativeCodexQuestionsSchema,
  type ConversationRow,
  type NativeCommandAction,
  type PendingInteraction,
  type PermissionRequestPayload,
} from "@zcode/shared/zcode-protocol-v4";
import { COMMAND_APPROVAL_METHOD, commandApprovalChoices } from "./commandApproval.js";
import type { Message } from "./gateway.js";
import { nativeItemDurationMs, num } from "./nativeValues.js";

const FILE_APPROVAL_METHOD = "item/fileChange/requestApproval";
const PERMISSIONS_METHOD = "item/permissions/requestApproval";
const QUESTIONS_METHOD = "item/tool/requestUserInput";
const ELICITATION_METHOD = "mcpServer/elicitation/request";

type NativeRequest = {
  id: string | number;
  key: string;
  method: string;
  params: Message;
  turnId: string;
  itemId: string;
  createdAt: number;
};
type NativeAnchor = { rowId: number; item: Message };
type Details = NonNullable<PermissionRequestPayload["nativeDetails"]>;

function record(value: unknown): Message {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Message)
    : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function records(value: unknown): Message[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function requestKey(epoch: unknown, id: string | number) {
  return JSON.stringify([string(epoch), id]);
}

export function applyNativeInteractionEvent(activation: Message, envelope: Message): boolean {
  const event = record(envelope.event);
  if (event.type !== "serverRequest.requested" && event.type !== "serverRequest.resolved")
    return false;
  const current = records(activation.pendingRequests);
  const remaining = current.filter(
    ({ event: packet }) => record(packet).requestId !== event.requestId,
  );
  // 同一请求的重放不改变交互顺序。resolved 只清理原类型的 RPC ID。
  if (event.type === "serverRequest.requested") {
    if (remaining.length === current.length) activation.pendingRequests = [...current, envelope];
    return true;
  }
  activation.pendingRequests = remaining;
  return false;
}

export function nativeRequests(activation: Message, turns: Message[]): NativeRequest[] {
  const found = new Map<string, NativeRequest>();
  const collect = (item: Message, parentTurn = "", emitted = 0, isEnvelope = false) => {
    const approval = record(item.pendingApproval);
    const id = item.requestId ?? approval.requestId;
    if (typeof id !== "string" && typeof id !== "number") return;
    const method = string(item.method ?? approval.method);
    const params = record(item.params ?? approval.params);
    const key = requestKey(activation.eventEpoch, id);
    if (found.has(key)) return;
    const at = typeof params.startedAtMs === "number" ? params.startedAtMs : emitted;
    found.set(key, {
      id,
      key,
      method,
      params,
      turnId: string(params.turnId) || string(item.turnId) || parentTurn,
      itemId: string(params.itemId) || (isEnvelope ? "" : string(item.id)),
      createdAt: Number.isFinite(at) && at > 0 ? at : 0,
    });
  };
  if (activation.readOnly === true) return [];
  for (const envelope of records(activation.pendingRequests)) {
    const event = record(envelope.event);
    if (event.type === "serverRequest.requested") {
      collect(
        { ...record(event.item), requestId: event.requestId },
        "",
        Date.parse(string(envelope.createdAt)),
        true,
      );
    }
  }
  // 兼容已有的 Gateway 快照与旧实时条目。新协议的待答请求与时间线分别投递。
  for (const turn of turns) for (const item of records(turn.items)) collect(item, string(turn.id));
  return [...found.values()];
}

export function approvalAnchor(request: NativeRequest) {
  return request.turnId && request.itemId ? JSON.stringify([request.turnId, request.itemId]) : "";
}

export function isToolApproval(request: NativeRequest) {
  return request.method === COMMAND_APPROVAL_METHOD || request.method === FILE_APPROVAL_METHOD;
}

function projectNativeCommandAction(action: Message): NativeCommandAction[] {
  const path = string(action.path).trim() || undefined;
  switch (action.type) {
    case "read": {
      const name = string(action.name).trim() || path?.split(/[/\\]/u).at(-1);
      return name ? [{ kind: "read", name, path }] : [];
    }
    case "search":
      return [{ kind: "search", path, query: string(action.query).trim() || undefined }];
    case "listFiles":
      return [{ kind: "listFiles", path }];
    default:
      return [];
  }
}

export function projectNativeToolRow(item: Message, cwd: string, approvalInteractionId?: string) {
  const command = string(item.command);
  const input = command
    ? { command, cwd: string(item.cwd) || cwd }
    : (item.arguments ?? item.changes ?? item.input ?? {});
  const output = item.aggregatedOutput ?? item.result ?? item.output;
  const durationMs = nativeItemDurationMs(item);
  // 一个 shell 条目可以有多条原生解析动作。作为同一工具行的明细保留顺序与重复项。
  const actions = records(item.commandActions).flatMap(projectNativeCommandAction);
  const startedAt = num(item.startedAtMs, -1);
  const endedAt = num(item.completedAtMs, -1);
  // 审批回执只表示请求已处理，工具状态由原生条目终态决定。
  const status: Extract<ConversationRow, { kind: "toolCall" }>["status"] =
    item.status === "declined" || item.status === "cancelled" || item.status === "interrupted"
      ? "cancelled"
      : item.status === "failed" || (typeof item.exitCode === "number" && item.exitCode !== 0)
        ? "error"
        : approvalInteractionId
          ? "pendingApproval"
          : item.status === "waitingForApproval" || item.status === "inProgress"
            ? "running"
            : "success";
  return {
    kind: "toolCall" as const,
    toolCallId: string(item.id),
    toolName: command ? "Bash" : string(item.tool) || string(item.type),
    inputText: typeof input === "string" ? input : JSON.stringify(input),
    input,
    status,
    ...(command && (actions.length || durationMs !== undefined)
      ? { nativeCommandActivity: { actions, durationMs } }
      : {}),
    ...(startedAt >= 0 ? { startedAt } : {}),
    ...(endedAt >= 0 ? { endedAt } : {}),
    ...(output != null
      ? { output: { text: typeof output === "string" ? output : JSON.stringify(output) } }
      : {}),
    ...(approvalInteractionId ? { approvalInteractionId } : {}),
  };
}

function permissionChoices(request: NativeRequest) {
  const { method, params } = request;
  if (method === COMMAND_APPROVAL_METHOD) {
    return commandApprovalChoices(params).map(({ option, decision }) => ({
      option,
      result: { decision },
    }));
  }
  const once = { optionId: "accept", kind: "allowOnce", label: "允许本轮" } as const;
  const session = {
    optionId: "acceptForSession",
    kind: "allowAlways",
    label: "Allow for this session",
    response: { decision: "allow" },
  } as const;
  const decline = { optionId: "decline", kind: "deny", label: "拒绝" } as const;
  if (method === PERMISSIONS_METHOD) {
    return [
      { option: once, result: { permissions: params.permissions, scope: "turn" } },
      { option: session, result: { permissions: params.permissions, scope: "session" } },
      { option: decline, result: { permissions: {}, scope: "turn" } },
    ];
  }
  if (method === FILE_APPROVAL_METHOD) {
    return [
      once,
      session,
      decline,
      { optionId: "cancel", kind: "deny", label: "Cancel turn" } as const,
    ].map((option) => ({
      option,
      result: { decision: option.optionId },
    }));
  }
  return [];
}

function permissionDetails(request: NativeRequest, item?: Message): Details {
  const { params } = request;
  const target = record(params.networkApprovalContext);
  const details: Details = [];
  if (typeof target.host === "string") {
    details.push({
      kind: "networkTarget",
      values: [target.host, string(target.protocol)].filter(Boolean),
    });
  }
  const profile = record(
    request.method === PERMISSIONS_METHOD ? params.permissions : params.additionalPermissions,
  );
  if (record(profile.network).enabled === true) details.push({ kind: "networkAccess", values: [] });
  const fs = record(profile.fileSystem);
  for (const kind of ["read", "write"] as const) {
    const paths = fs[kind];
    if (Array.isArray(paths)) {
      const values = paths.filter((path): path is string => typeof path === "string");
      if (values.length) details.push({ kind, values });
    }
  }
  if (Array.isArray(fs.entries) && fs.entries.length > 0) {
    details.push({
      kind: "filesystemRules",
      values: fs.entries.map((entry: unknown) => JSON.stringify(entry)),
    });
  }
  if (typeof params.grantRoot === "string" && params.grantRoot) {
    details.push({ kind: "grantRoot", values: [params.grantRoot] });
  }
  const changed = records(item?.changes)
    .map((change) => string(change.path))
    .filter(Boolean);
  if (request.method === FILE_APPROVAL_METHOD && changed.length) {
    details.push({ kind: "changedFiles", values: changed });
  }
  return details;
}

export function projectNativeInteraction(
  request: NativeRequest,
  anchor?: NativeAnchor,
): PendingInteraction | undefined {
  const { method, params } = request;
  const common = {
    interactionId: request.key,
    anchorRowId: anchor?.rowId ?? null,
    createdAt: request.createdAt,
  };
  if (method === ELICITATION_METHOD) {
    return {
      ...common,
      kind: "userInput",
      payload: {
        kind: "userInput",
        prompt: string(params.message),
        freeText: false,
        toolName: "McpElicitation",
        schema: {
          interaction: "mcp.structured",
          mode: params.mode ?? "form",
          serverName: string(params.serverName),
          requestedSchema: params.requestedSchema,
          url: params.url,
        },
      },
    };
  }
  if (method === QUESTIONS_METHOD) {
    const projected = nativeCodexQuestionsSchema.safeParse({
      interaction: "codex.questions",
      questions: params.questions,
    });
    if (!projected.success) return undefined;
    return {
      ...common,
      kind: "userInput",
      payload: { kind: "userInput", prompt: "", freeText: false, schema: projected.data },
    };
  }
  const choices = permissionChoices(request);
  if (!choices.length) return undefined;
  const item = anchor?.item;
  const network = params.networkApprovalContext != null;
  // 子命令的原生审批参数比父进程条目的命令更准确。
  const command =
    method === COMMAND_APPROVAL_METHOD && !network
      ? string(params.command) || string(item?.command)
      : "";
  const reason = string(params.reason).trim();
  const toolName = command
    ? "Bash"
    : network
      ? "NetworkAccess"
      : method === FILE_APPROVAL_METHOD
        ? "fileChange"
        : "permissionsRequest";
  return {
    ...common,
    kind: "permission",
    payload: {
      kind: "permission",
      toolCallId: request.itemId || request.key,
      toolName,
      summary: reason === command.trim() ? "" : reason,
      detail: command
        ? { command, cwd: string(params.cwd) || string(item?.cwd) }
        : (item?.changes ?? {}),
      nativeDetails: permissionDetails(request, item),
      options: choices.map(({ option }) => option),
    },
  };
}

export function nativeInteractionResult(request: NativeRequest, answer: Message) {
  const { method, params } = request;
  if (method === ELICITATION_METHOD) {
    const action = answer.action;
    if (action !== "accept" && action !== "decline" && action !== "cancel")
      throw Error("无效的 MCP 决定");
    const value = record(answer.content).value;
    if (action === "accept" && params.mode !== "url" && value === undefined)
      throw Error("MCP 表单未填写");
    return {
      action,
      content: action === "accept" && params.mode !== "url" ? value : null,
      _meta: null,
    };
  }
  if (method === QUESTIONS_METHOD) {
    const received = record(record(answer.content).answers);
    // 题面可能重复。空答案是明确跳过，部分答案只传用户填过的问题 ID。
    const answers = Object.fromEntries(
      records(params.questions).flatMap(({ id }) => {
        if (typeof id !== "string" || !Object.hasOwn(received, id)) return [];
        const value = received[id];
        return typeof value === "string" && value.trim() ? [[id, { answers: [value] }]] : [];
      }),
    );
    return { answers };
  }
  const chosen = permissionChoices(request).find(
    ({ option }) => option.optionId === answer.optionId,
  );
  if (!chosen) throw Error("当前 Codex 请求不支持此审批决定");
  return chosen.result;
}
