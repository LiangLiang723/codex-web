import type { RealtimeClientMessage } from "~~/shared/types";
import { parseEmptyAppServerResponse } from "~~/shared/runtime/app-server";
import { CodexRpcError } from "../../http/errors";
import { requireRecord } from "../../http/validation/common";
import { buildUserInput } from "../../protocol/thread-payload";
import { threadBroker } from "../../runtime/broker";
import { sendWithUploadedFiles } from "../../runtime/thread-attachments";
import { hostStore } from "../../state/hosts";
import {
  nativeQueueAddResult,
  nativeQueueDeleteResult,
  queryNativeDelivery,
  readNativeQueue,
  receiptResult,
  recordNativeDelivery,
} from "../../../selfhost-delivery";
import { sendRealtimePeerMessage, type RealtimePeer } from "../peer-state";

type Request<K extends string> = Extract<RealtimeClientMessage, { type: K }>;

export async function queryDelivery(peer: RealtimePeer, message: Request<"thread.delivery.query">) {
  const host = requireRecord(hostStore.getWithSecret(message.hostId), "Host not found");
  const results = await queryNativeDelivery(host, message.cwd, message.commands);
  sendRealtimePeerMessage(peer, {
    type: "thread.delivery.results",
    requestId: message.requestId,
    hostId: host.id,
    results,
  });
}

export async function readControls(peer: RealtimePeer, message: Request<"thread.native.controls">) {
  const host = requireRecord(hostStore.getWithSecret(message.hostId), "Host not found");
  const client = await threadBroker.getHostClient(host);
  let queue = true;
  const queued = await readNativeQueue(client, message.threadId).catch((error: unknown) => {
    if (!(error instanceof CodexRpcError) || error.rpcCode !== -32601) throw error;
    queue = false;
    return [];
  });
  sendRealtimePeerMessage(peer, {
    type: "thread.native.controls.result",
    requestId: message.requestId,
    hostId: host.id,
    threadId: message.threadId,
    queue,
    fork: true,
    compact: true,
    queued,
  });
}

export async function addQueuedInput(peer: RealtimePeer, message: Request<"thread.queue.add">) {
  const host = requireRecord(hostStore.getWithSecret(message.hostId), "Host not found");
  const { threadId, deliveryId, files } = message;
  const input = buildUserInput(message);
  if (!input.length) throw new Error("请输入内容或添加附件");
  const receipt = await recordNativeDelivery(host, threadId, deliveryId, "queue", () =>
    threadBroker.withNativeThreadWriter(host, threadId, (client) =>
      sendWithUploadedFiles(client, host.id, threadId, files, async () => {
        await client.request(
          "thread/queue/add",
          { threadId, input, clientUserMessageId: deliveryId },
          120_000,
          nativeQueueAddResult.parse,
        );
        return null;
      }),
    ),
  );
  sendRealtimePeerMessage(peer, {
    type: "thread.delivery.state",
    requestId: message.requestId,
    hostId: host.id,
    ...receiptResult(receipt),
  });
}

export async function deleteQueuedInput(
  peer: RealtimePeer,
  message: Request<"thread.queue.delete">,
) {
  const host = requireRecord(hostStore.getWithSecret(message.hostId), "Host not found");
  const { threadId, queuedSubmissionId } = message;
  const { deleted } = await threadBroker.withNativeThreadWriter(host, threadId, (client) =>
    client.request(
      "thread/queue/delete",
      { threadId, queuedSubmissionId },
      120_000,
      nativeQueueDeleteResult.parse,
    ),
  );
  sendRealtimePeerMessage(peer, {
    type: "thread.queue.deleted",
    requestId: message.requestId,
    hostId: host.id,
    threadId,
    deleted,
  });
}

export async function startNativeCompaction(
  peer: RealtimePeer,
  message: Request<"thread.native.compact">,
) {
  const host = requireRecord(hostStore.getWithSecret(message.hostId), "Host not found");
  await threadBroker.withNativeThreadWriter(host, message.threadId, (client) =>
    client.request(
      "thread/compact/start",
      { threadId: message.threadId },
      120_000,
      parseEmptyAppServerResponse,
    ),
  );
  sendRealtimePeerMessage(peer, {
    type: "thread.native.compact.accepted",
    requestId: message.requestId,
    hostId: host.id,
    threadId: message.threadId,
  });
}
