import { readValidatedBody } from "h3";
import { posix } from "node:path";
import { z } from "zod";
import { parseThreadReadResult } from "~~/shared/runtime/app-server";
import { defineGatewayEventHandler } from "../../utils/gateway/http/errors";
import { requireRecord } from "../../utils/gateway/http/validation/common";
import { threadBroker } from "../../utils/gateway/runtime/broker";
import { threadRuntimeEvents } from "../../utils/gateway/runtime/thread-runtime-events";
import { hostStore } from "../../utils/gateway/state/hosts";
import { remoteHosts } from "../../utils/gateway/state/remote-hosts";
import {
  readTurnFileEvidence,
  readTurnFileSummary,
  verifiedTurnDirectories,
} from "../../utils/selfhost-turn-files";
import { callWorkspace } from "../../utils/selfhost-workspace";

const id = z.string().min(1).max(256);
const scope = {
  hostId: z.number().int().positive(),
  threadId: id,
  cwd: z.string().max(4096).startsWith("/"),
};
const request = z.discriminatedUnion("operation", [
  z.object({ ...scope, operation: z.literal("summaries"), turnIds: z.array(id).max(100) }).strict(),
  z.object({ ...scope, operation: z.literal("details"), turnId: id }).strict(),
  z.object({ ...scope, operation: z.literal("preview"), turnId: id }).strict(),
  z.object({ ...scope, operation: z.literal("apply"), turnId: id, commandId: id }).strict(),
]);
const normalize = (path: string) => posix.normalize(path).replace(/\/$/u, "") || "/";

export default defineGatewayEventHandler(async (event) => {
  const body = await readValidatedBody(event, (value) => request.parse(value));
  const { hostId, threadId, operation } = body;
  const host = requireRecord(hostStore.getWithSecret(hostId), "Host not found");
  const client = await threadBroker.getHostClient(host);
  const loadThread = (connection: typeof client) =>
    connection.request(
      "thread/read",
      { threadId, includeTurns: false },
      120_000,
      parseThreadReadResult,
    );
  const { thread } = await loadThread(client);
  const cwd = normalize(thread.cwd);
  const connectionKey = remoteHosts.key(hostId);
  const remoteKey = remoteHosts.verifiedIdentityKey(hostId);
  if (!connectionKey || !remoteKey || thread.id !== threadId)
    throw Error("文件操作者的主机或工作区与原生会话不匹配");
  // Codex 返回原生 cwd，网页可能通过同一目录的别名进入。由该 SSH 主机核实路径。
  const resolveDirectory = (path: string) =>
    callWorkspace(host, {
      channel: "system",
      method: "resolveDirectory",
      args: [{ path }],
    }).then((value) => z.string().startsWith("/").parse(value));
  const matchesDirectory = async (path: string) => {
    if (cwd === normalize(path)) return true;
    const [native, selected] = await Promise.all([resolveDirectory(cwd), resolveDirectory(path)]);
    return native === selected;
  };
  if (!(await matchesDirectory(body.cwd))) throw Error("文件操作者的目录与原生会话不匹配");
  const persisted = await verifiedTurnDirectories(
    remoteKey,
    threadId,
    operation === "summaries" ? body.turnIds : [body.turnId],
    (directory) => matchesDirectory(directory).catch(() => false),
  );
  const worker = (operation: string, params: Record<string, unknown>) =>
    callWorkspace(host, {
      channel: "turn-file-rewind",
      method: "run",
      args: [{ cwd, threadId, operation, ...params }],
    });

  if (operation === "summaries") {
    const saved = new Map(
      body.turnIds.flatMap((turnId) => {
        const directory = persisted.get(turnId);
        const summary = directory && readTurnFileSummary(remoteKey, threadId, turnId, directory);
        return summary ? [[turnId, summary] as const] : [];
      }),
    );
    if (!saved.size) return { summaries: {} };
    // 目录环境不支持事务 helper 时，已取得的原生 diff 仍然可浏览。
    const states = await worker("states", { turnIds: [...saved.keys()] })
      .then((result) => z.object({ reverted: z.array(z.string()) }).parse(result))
      .catch(() => null);
    return {
      summaries: Object.fromEntries(
        [...saved].map(([turnId, summary]) => [
          turnId,
          {
            ...summary,
            eligible: states !== null,
            ...(states?.reverted.includes(turnId) ? { state: "reverted" } : {}),
          },
        ]),
      ),
    };
  }

  const turnId = body.turnId;
  const storedDirectory = persisted.get(turnId);
  const evidence =
    storedDirectory && readTurnFileEvidence(remoteKey, threadId, turnId, storedDirectory);
  if (operation === "details") return { details: evidence?.details ?? null };
  if (operation === "apply") {
    const receipt = await worker("receipt", { turnId });
    if (receipt !== null) return receipt;
  }
  if (!storedDirectory || !evidence) throw Error("缺少该轮的原生文件凭据，无法验证安全撤销");
  return threadBroker.withNativeThreadWriter(host, threadId, async (writer) => {
    // 复用同一原生 writer 的队列。回复结束、原生空闲以及作用域一致以后才调用工作树事务。
    const { thread: current } = await loadThread(writer);
    if (
      remoteHosts.key(hostId) !== connectionKey ||
      remoteHosts.verifiedIdentityKey(hostId) !== remoteKey ||
      normalize(current.cwd) !== cwd ||
      !(await matchesDirectory(body.cwd)) ||
      !(await matchesDirectory(storedDirectory)) ||
      current.status.type !== "idle"
    )
      throw Error("会话正在运行或有待处理的请求，完成后可撤销");
    const result = await worker(operation, {
      turnId,
      files: evidence.files,
      ...(operation === "apply" ? { commandId: body.commandId } : {}),
    });
    if (operation === "preview") return { preview: result };
    if (
      typeof result === "object" &&
      result !== null &&
      "applied" in result &&
      result.applied === true
    ) {
      threadRuntimeEvents.record(hostId, threadId, {
        type: "notice",
        source: "selfhost/turn-files/reverted",
        params: { turnId },
      });
    }
    return result;
  });
});
