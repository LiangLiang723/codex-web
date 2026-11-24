import {
  commandAckSchema,
  commandsQueryResultSchema,
  type CommandKey,
  type CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { z } from "zod";
import type { Gateway, Message } from "./gateway.js";
import { buildNativeTurnInput } from "./nativeTurnInput.js";
import { nativeTurnIsCompacting, nativeMode, rec, str } from "./threadProjection.js";

const nativeDeliveryValue = z.enum(["startNow", "guide", "queue"]);
const receipt = z.object({
  state: z.enum(["missing", "creating", "created", "pending", "accepted", "rejected"]),
  threadId: z.string().nullable().optional(),
  delivery: nativeDeliveryValue.nullable().optional(),
  turnId: z.string().nullable().optional(),
});

export class NativeDeliveryPending extends Error {
  constructor(cause?: unknown) {
    super("Codex 发送结果待确认。恢复连接后可检查原会话。", { cause });
    this.name = "NativeDeliveryPending";
  }
}

export function nativeInputAccepted(commandId: string, delivery: unknown) {
  return {
    type: "inputAccepted" as const,
    delivery: nativeDeliveryValue.parse(delivery),
    inputId: commandId,
  };
}

export function nativeCreationAccepted(
  received: Message,
  commandId: string,
): CommandResult | undefined {
  const value = receipt.safeParse(received);
  if (!value.success || value.data.state !== "accepted" || !value.data.threadId) return undefined;
  const { threadId, delivery } = value.data;
  return {
    type: "createSession",
    sessionId: threadId,
    ...(delivery ? { input: nativeInputAccepted(commandId, delivery) } : {}),
  };
}

export async function readNativeDelivery(
  gateway: Gateway,
  hostId: number,
  cwd: string,
  commands: CommandKey[],
) {
  const response = await gateway.call("thread.delivery.query", { hostId, cwd, commands });
  const rows = z
    .object({
      results: z.array(
        receipt.extend({
          key: z.object({ commandId: z.string(), sessionId: z.string().nullable() }),
        }),
      ),
    })
    .parse(response).results;
  return commands.map(
    (key) =>
      rows.find(
        (item) => item.key.commandId === key.commandId && item.key.sessionId === key.sessionId,
      ) ?? { key, state: "missing" as const },
  );
}

export async function reconcileNativeDelivery(
  gateway: Gateway,
  hostId: number,
  cwd: string,
  commands: CommandKey[],
) {
  const rows = await readNativeDelivery(gateway, hostId, cwd, commands);
  return commandsQueryResultSchema.parse({
    results: rows.map(({ key, ...value }) => {
      if (value.state === "rejected")
        return {
          key,
          result: {
            commandId: key.commandId,
            status: "failed",
            revisionAtDecision: 0,
            reasonCode: "codex.nativeInputRejected",
            message: "Codex 拒绝了本次输入。请检查当前轮次后继续。",
          },
        };
      if (value.state !== "accepted") return { key, result: "unknown" };
      const result =
        key.sessionId === null
          ? nativeCreationAccepted(value, key.commandId)
          : value.threadId === key.sessionId && value.delivery
            ? nativeInputAccepted(key.commandId, value.delivery)
            : undefined;
      return {
        key,
        result: result
          ? commandAckSchema.parse({
              commandId: key.commandId,
              status: "accepted",
              revisionAtDecision: 0,
              result,
            })
          : "unknown",
      };
    }),
  });
}

type DeliveryScope = { gateway: Gateway; hostId: number; cwd: string };

export async function createNativeThreadForInput(
  scope: DeliveryScope,
  commandId: string,
  firstInputExpected: boolean,
  options: Message,
) {
  const { gateway, hostId, cwd } = scope;
  const created = await gateway
    .call("thread.start", {
      hostId,
      cwd,
      deliveryId: commandId,
      firstInputExpected,
      ...options,
    })
    .catch(async (cause: unknown) => {
      const [result] = await readNativeDelivery(gateway, hostId, cwd, [
        { sessionId: null, commandId },
      ]).catch(() => []);
      if (result?.state === "created" || result?.state === "accepted") return result;
      throw new NativeDeliveryPending(cause);
    });
  const threadId = str(created.threadId);
  const previous = nativeCreationAccepted(created, commandId);
  if (!threadId || (!previous && created.state && created.state !== "created"))
    throw new NativeDeliveryPending();
  return { threadId, previous };
}

export async function submitNativeInput(
  { gateway, hostId, cwd }: DeliveryScope,
  threadId: string,
  p: Message,
  commandId: string,
  context: { active?: Message; running?: string; followupMode: "queue" | "guide"; first: boolean },
) {
  const { active, first, running, followupMode } = context;
  const queue = rec(active?.nativeControls).queue === true;
  const requested = p.requestedDelivery;
  const compacting = nativeTurnIsCompacting(active);
  if (!first && requested === "queue" && !queue) throw Error("当前 Codex 主机不支持队列");
  if (!first && requested === "guide" && (!running || compacting))
    throw Error("当前轮次无法引导，请重新选择发送方式");
  if (!first && requested === "startNow" && running)
    throw Error("当前轮次正在运行，请选择引导或排队");
  if (compacting && !queue) throw Error("请等待当前上下文压缩完成");
  const delivery = first
    ? "startNow"
    : requested === "queue" ||
        compacting ||
        (running && !requested && queue && followupMode === "queue")
      ? "queue"
      : running
        ? "guide"
        : "startNow";
  const material = buildNativeTurnInput(p);
  const args = { hostId, threadId, deliveryId: commandId, ...material };
  const model = str(rec(p.modelSelection).modelId) || undefined;
  const effort = str(rec(rec(p.modelSelection).options).reasoningLevel) || undefined;
  const modeModel = model || str(rec(active?.threadSettings).model);
  const submit = () => {
    if (delivery === "queue") return gateway.call("thread.queue.add", args);
    if (delivery === "guide")
      return gateway.call("turn.steer", {
        ...args,
        clientUserMessageId: commandId,
        expectedTurnId: running,
      });
    return gateway.call("turn.start", {
      ...args,
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
  };
  const result: Message = await submit().catch(async (cause: unknown) => {
    const [recovered] = await readNativeDelivery(gateway, hostId, cwd, [
      { sessionId: first ? null : threadId, commandId },
    ]).catch(() => []);
    if (
      (recovered?.state === "accepted" || recovered?.state === "rejected") &&
      recovered.threadId === threadId
    )
      return recovered;
    throw new NativeDeliveryPending(cause);
  });
  if (!first && result.state === "rejected")
    throw Error("Codex 拒绝了本次输入。请检查当前轮次后继续。");
  if (result.state && result.state !== "accepted") throw new NativeDeliveryPending();
  return {
    input: nativeInputAccepted(commandId, result.delivery ?? delivery),
    turnId: str(result.turnId) || str(rec(result.turn).id),
  };
}
