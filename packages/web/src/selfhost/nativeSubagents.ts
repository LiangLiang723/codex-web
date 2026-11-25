import type { SubagentProjectionState } from "@zcode/shared/zcode-protocol-v4";
import type { Message } from "./gateway.js";
import { array, num, rec, str } from "./nativeValues.js";

type NativeEndedAgent = NonNullable<SubagentProjectionState["ended"]>[number];
type NativeChildStatus =
  | SubagentProjectionState["running"][number]["status"]
  | NativeEndedAgent["status"];
type NativeChild = Omit<NativeEndedAgent, "status"> & {
  status: NativeChildStatus;
  changedAt: number;
};

function collabChildStatus(value: unknown): NativeChildStatus | undefined {
  switch (value) {
    case "running":
    case "inProgress":
      return "running";
    case "pendingInit":
    case "waiting":
    case "paused":
      return "waiting";
    case "blocked":
      return "blocked";
    case "completed":
      return "success";
    case "errored":
    case "failed":
      return "failed";
    case "interrupted":
    case "shutdown":
      return "cancelled";
  }
}

function isActiveChildStatus(status: NativeChildStatus) {
  return status === "running" || status === "waiting" || status === "blocked";
}

function nativeAgentName(value: unknown, childSessionId: string) {
  const name = str(value).trim();
  if (
    !name ||
    name === childSessionId ||
    /^(?:[0-9a-f]{8}-[0-9a-f-]{27}|agent-[0-9a-f]{8}(?:-[0-9a-f-]+)?)$/i.test(name)
  )
    return "";
  return name.replace(/_+/g, " ").trim();
}

export function projectNativeSubagents(
  activation: Message,
  revision: number,
): SubagentProjectionState {
  const turns = array(rec(rec(activation.history).thread).turns ?? rec(activation.thread).turns);
  const children = new Map<string, NativeChild>();
  const update = (
    childSessionId: string,
    item: Message,
    status: NativeChildStatus,
    at: number,
    canRestart: boolean,
  ) => {
    const previous = children.get(childSessionId);
    // agentPath 是 Codex 的父子关系路径。显示其末段，避免把整条身份路径用作标题。
    const leaf = str(item.agentPath).split("/").filter(Boolean).at(-1);
    const nickname = nativeAgentName(item.agentNickname, childSessionId);
    const leafName = leaf === "root" ? "" : nativeAgentName(leaf, childSessionId);
    const prompt = str(item.prompt).trim().split(/\r?\n/, 1)[0] ?? "";
    const preview = Array.from(prompt).slice(0, 64).join("");
    const title =
      nickname || leafName || previous?.title || (preview === prompt ? preview : preview + "…");
    const type = str(item.agentRole).trim() || previous?.subagentType || "general-purpose";
    // 回执可更新时间线的原行；旧状态不能覆盖更晚的活动。没有时间戳的旧记录，
    // 也只有原生启动、恢复或向子智能体发送新输入才可以重新打开终态。
    const preserve =
      previous &&
      ((at && previous.changedAt > at) ||
        (!isActiveChildStatus(previous.status) && isActiveChildStatus(status) && !canRestart));
    const nextStatus = preserve ? previous.status : status;
    const changedAt = preserve ? previous.changedAt : at || previous?.changedAt || 0;
    const startedAt =
      previous?.startedAt ?? (isActiveChildStatus(nextStatus) && at ? at : undefined);
    children.set(childSessionId, {
      childSessionId,
      subagentType: type,
      title,
      status: nextStatus,
      changedAt,
      ...(startedAt ? { startedAt } : {}),
      ...(!isActiveChildStatus(nextStatus) && changedAt ? { endedAt: changedAt } : {}),
    });
  };
  for (const turn of turns) {
    for (const item of array(turn.items)) {
      const at = num(item.completedAtMs) || num(item.startedAtMs);
      if (item.type === "subAgentActivity") {
        const childId = str(item.agentThreadId).trim();
        if (!childId) continue;
        const known = children.get(childId)?.status;
        if (item.kind === "started") update(childId, item, "running", at, true);
        else if (item.kind === "interrupted") update(childId, item, "cancelled", at, false);
        else if (item.kind === "completed") {
          // 活动结束未提供结果时，保留 App Server 已显式报告的失败或中断。
          update(
            childId,
            item,
            known === "failed" || known === "cancelled" ? known : "success",
            at,
            false,
          );
        } else if (item.kind === "interacted") update(childId, item, known ?? "running", 0, false);
      } else if (item.type === "collabAgentToolCall") {
        const states = rec(item.agentsStates);
        const receiverIds = Array.isArray(item.receiverThreadIds)
          ? item.receiverThreadIds.map((id) => str(id).trim()).filter(Boolean)
          : [];
        for (const childId of new Set([...receiverIds, ...Object.keys(states)])) {
          if (!childId) continue;
          const state = rec(states[childId]);
          const previous = children.get(childId);
          if (
            state.status === "notFound" &&
            previous &&
            isActiveChildStatus(previous.status) &&
            (!at || at >= previous.changedAt)
          ) {
            children.delete(childId);
            continue;
          }
          const status = collabChildStatus(state.status);
          if (status) {
            update(
              childId,
              item,
              status,
              at,
              item.tool === "sendInput" || item.tool === "resumeAgent",
            );
          } else if (
            !state.status &&
            !children.has(childId) &&
            item.tool === "spawnAgent" &&
            item.status !== "failed"
          ) {
            update(childId, item, "waiting", at, false);
          }
        }
      }
    }
  }
  const running: SubagentProjectionState["running"] = [];
  const ended: NativeEndedAgent[] = [];
  for (const { changedAt: _changedAt, status, ...child } of children.values()) {
    if (status === "running" || status === "waiting" || status === "blocked")
      running.push({ ...child, status });
    else ended.push({ ...child, status });
  }
  ended.reverse().sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  return {
    revision,
    childSessionIds: [...children.keys()],
    running,
    ended,
    endedTotal: ended.length,
  };
}
