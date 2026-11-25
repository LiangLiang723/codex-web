import { readValidatedBody } from "h3";
import { z } from "zod";
import { remoteHostIdentity } from "~~/shared/utils/workspace";
import { defineGatewayEventHandler } from "../../utils/gateway/http/errors";
import { requireRecord } from "../../utils/gateway/http/validation/common";
import { hostStore } from "../../utils/gateway/state/hosts";
import { threadBroker } from "../../utils/gateway/runtime/broker";
import { discardSelfhostThread } from "../../utils/selfhost-thread-deletion";
import { setThreadUnread } from "../../utils/selfhost-thread-organization";
import { readSelfhostThreadSummary } from "../../utils/selfhost-thread-summary";

const target = {
  hostId: z.number().int().positive(),
  threadId: z.string().uuid(),
};
const body = z.discriminatedUnion("operation", [
  z.object({ ...target, operation: z.literal("delete") }).strict(),
  z
    .object({
      ...target,
      operation: z.literal("unread"),
      unread: z.boolean(),
      expectedUnreadAt: z.number().int().positive().optional(),
    })
    .strict(),
]);

export default defineGatewayEventHandler(async (event) => {
  const input = await readValidatedBody(event, (value) => body.parse(value));
  const { hostId, threadId } = input;
  const host = requireRecord(hostStore.getWithSecret(hostId), "Host not found");
  const thread = await readSelfhostThreadSummary(host, threadId);
  const current = hostStore.get(hostId);
  // 原生读取和确认可能晚于 SSH 主机替换，不能把旧操作送到同号的新主机。
  if (
    !current ||
    current.createdAt !== host.createdAt ||
    remoteHostIdentity(current) !== remoteHostIdentity(host)
  )
    throw Error("SSH 主机已变更，请重新打开工作区");
  if (input.operation === "unread") {
    requireRecord(thread, "Thread not found");
    setThreadUnread(
      event.context.auth!.user.id,
      host,
      threadId,
      input.unread,
      input.expectedUnreadAt,
    );
    return {};
  }
  if (thread?.ephemeral) throw Error("临时会话没有可永久删除的记录");
  if (thread?.status.type === "active") throw Error("会话正在运行，请结束当前轮次后重试");
  if (thread) await threadBroker.selfhostCapability(host, "thread/delete", { threadId });
  // 原生通知可能先于或晚于请求回包。清理可重复，删除失败不会执行。
  discardSelfhostThread(hostId, threadId);
  return { deleted: true };
});
