import type { HostRecord } from "~~/shared/types";
import { parseThreadTimelinePage, parseThreadTurnsPage } from "~~/shared/runtime/app-server";
import { z } from "zod";
import type { AgentRpcClient } from "./gateway/agent/provider-adapter";
import { CodexRpcError } from "./gateway/http/errors";
import { threadBroker } from "./gateway/runtime/broker";
import { remoteHosts, requiredGatewayUserId } from "./gateway/state/remote-hosts";
import { gatewayDatabase } from "./gateway/storage/database";

type Delivery = "startNow" | "guide" | "queue";
type DeliveryKey = { sessionId: string | null; commandId: string };
type DeliveryRow = {
  cwd: string | null;
  threadId: string | null;
  state: "creating" | "created" | "pending" | "accepted" | "rejected";
  delivery: Delivery | null;
  turnId: string | null;
};
type Scope = [userId: number, hostId: number, remoteKey: string];

function database() {
  const db = gatewayDatabase();
  db.exec(`CREATE TABLE IF NOT EXISTS selfhost_delivery (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    host_id INTEGER NOT NULL,
    remote_key TEXT NOT NULL,
    command_id TEXT NOT NULL,
    cwd TEXT,
    thread_id TEXT,
    state TEXT NOT NULL,
    delivery TEXT,
    turn_id TEXT,
    PRIMARY KEY (user_id, host_id, command_id)
  )`);
  return db;
}

const keyWhere = "user_id = ? AND host_id = ? AND remote_key = ? AND command_id = ?";

function receipt(scope: Scope, commandId: string): DeliveryRow | undefined {
  return database()
    .prepare(
      `SELECT cwd, thread_id AS threadId, state, delivery, turn_id AS turnId
      FROM selfhost_delivery WHERE ${keyWhere}`,
    )
    .get(...scope, commandId) as DeliveryRow | undefined;
}

async function target(host: HostRecord) {
  const client = await threadBroker.getHostClient(host);
  const key = remoteHosts.verifiedIdentityKey(host.id);
  if (!key) throw new Error("当前 SSH 连接的身份尚未验证");
  const scope: Scope = [requiredGatewayUserId(), host.id, key];
  return { client, scope };
}

export async function createNativeDeliveryThread(
  host: HostRecord,
  cwd: string,
  commandId: string,
  firstInputExpected: boolean,
  start: (bind: (threadId: string) => void) => Promise<unknown>,
) {
  const { scope } = await target(host);
  const db = database();
  // 创建回执可能在远端生效后丢失。先留下唯一占位，未知时重复请求只读这条记录。
  const inserted = db
    .prepare(`INSERT INTO selfhost_delivery
    (user_id, host_id, remote_key, command_id, cwd, state)
    VALUES (?, ?, ?, ?, ?, 'creating') ON CONFLICT DO NOTHING`)
    .run(...scope, commandId, cwd);
  if (inserted.changes) {
    try {
      await start((threadId) => {
        db.prepare(`UPDATE selfhost_delivery SET thread_id = ?, state = ? WHERE ${keyWhere}`).run(
          threadId,
          firstInputExpected ? "created" : "accepted",
          ...scope,
          commandId,
        );
      });
    } catch (error) {
      // 原生创建已返回、但后续保活失败时仍返回已关联的同一 Thread。
      if (!receipt(scope, commandId)?.threadId) throw error;
    }
  }
  const stored = receipt(scope, commandId);
  if (!stored || stored.cwd !== cwd) throw new Error("发送命令与当前工作区不匹配");
  return stored;
}

export async function recordNativeDelivery(
  host: HostRecord,
  threadId: string,
  commandId: string,
  delivery: Delivery,
  send: () => Promise<string | null>,
) {
  const { scope } = await target(host);
  const db = database();
  // 先用一条原子写入占住发送权。RPC 成功与记录接受结果之间崩溃时，后续只查原生证据。
  const claimed = db
    .prepare(`INSERT INTO selfhost_delivery
    (user_id, host_id, remote_key, command_id, thread_id, state, delivery)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
    ON CONFLICT DO UPDATE SET state = 'pending', delivery = excluded.delivery
    WHERE selfhost_delivery.state = 'created' AND selfhost_delivery.thread_id = excluded.thread_id
      AND selfhost_delivery.remote_key = excluded.remote_key`)
    .run(...scope, commandId, threadId, delivery);
  const stored = receipt(scope, commandId);
  if (!stored || stored.threadId !== threadId || stored.delivery !== delivery)
    throw new Error("发送命令与原生会话或投递方式不匹配");
  if (!claimed.changes) return stored;
  try {
    const turnId = await send();
    return acceptDelivery(scope, commandId, stored, turnId);
  } catch (error) {
    // 原生参数或目标轮次明确被拒绝时回到可继续状态。其余错误可能发生在接纳之后。
    if (rejectedBeforeAdmission(error)) {
      if (stored.cwd === null) {
        db.prepare(`UPDATE selfhost_delivery SET state = 'rejected' WHERE ${keyWhere}`).run(
          ...scope,
          commandId,
        );
      } else {
        db.prepare(
          `UPDATE selfhost_delivery SET state = 'created', delivery = NULL WHERE ${keyWhere}`,
        ).run(...scope, commandId);
      }
      return { ...stored, state: "rejected" as const };
    }
    return stored;
  }
}

function rejectedBeforeAdmission(error: unknown) {
  if (!(error instanceof CodexRpcError)) return false;
  if (error.rpcCode === -32601 || error.rpcCode === -32602) return true;
  // 两版原生 steer 仅以消息区分这两个在 admission 前拒绝的 RPC 条件。
  return (
    error.rpcMethod === "turn/steer" &&
    error.rpcCode === -32600 &&
    (error.message === "no active turn to steer" ||
      error.message.startsWith("expected active turn id "))
  );
}

function acceptDelivery(
  scope: Scope,
  commandId: string,
  stored: DeliveryRow,
  turnId: string | null,
) {
  database()
    .prepare(`UPDATE selfhost_delivery SET state = 'accepted', turn_id = ? WHERE ${keyWhere}`)
    .run(turnId, ...scope, commandId);
  return { ...stored, state: "accepted" as const, turnId };
}

const queuedSubmission = z.object({
  id: z.string().min(1),
  clientUserMessageId: z.string().min(1),
  input: z.array(z.record(z.string(), z.unknown())),
});
const queuePage = z.object({ data: z.array(queuedSubmission), nextCursor: z.string().nullish() });
export const nativeQueueAddResult = z.object({ queuedSubmission });
export const nativeQueueDeleteResult = z.object({ deleted: z.boolean() });

export async function readNativeQueue(client: AgentRpcClient, threadId: string) {
  const queued: z.infer<typeof queuedSubmission>[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await client.request(
      "thread/queue/list",
      { threadId, cursor, limit: 100 },
      120_000,
      queuePage.parse,
    );
    queued.push(...page.data);
    cursor = page.nextCursor ?? null;
    if (cursor && seen.has(cursor)) throw new Error("Codex 返回了重复的队列游标");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return queued;
}

export async function queryNativeDelivery(host: HostRecord, cwd: string, commands: DeliveryKey[]) {
  const { client, scope } = await target(host);
  const results = [];
  for (const key of commands) {
    const stored = receipt(scope, key.commandId);
    if (
      !stored ||
      (key.sessionId === null ? cwd !== stored.cwd : key.sessionId !== stored.threadId)
    ) {
      results.push({ key, state: "missing" as const });
      continue;
    }
    let resolved = stored;
    if (stored.state === "pending" && stored.threadId) {
      try {
        const evidence = await findNativeDelivery(
          client,
          stored.threadId,
          key.commandId,
          stored.delivery,
        );
        if (evidence) resolved = acceptDelivery(scope, key.commandId, stored, evidence.turnId);
      } catch {
        // 旧历史、写入未落盘、RPC 断开或游标过期均不能证明输入未送达。
      }
    }
    results.push({ key, ...receiptResult(resolved) });
  }
  return results;
}

export function receiptResult(row: DeliveryRow) {
  return { state: row.state, threadId: row.threadId, delivery: row.delivery, turnId: row.turnId };
}

async function findNativeDelivery(
  client: AgentRpcClient,
  threadId: string,
  commandId: string,
  delivery: Delivery | null,
) {
  if (delivery === "queue") {
    const queued = await readNativeQueue(client, threadId);
    if (queued.some((item) => item.clientUserMessageId === commandId)) return { turnId: null };
  }
  // 旧式 Thread 没有 timeline 页，回执要从相同原生 Thread 的完整轮次中寻找。
  const metadata = await client.request(
    "thread/read",
    { threadId, includeTurns: false },
    120_000,
    (value) =>
      z
        .object({ thread: z.object({ id: z.string(), historyMode: z.string().nullish() }) })
        .parse(value),
  );
  if (metadata.thread.id !== threadId) return null;
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
    let next: string | null;
    if (metadata.thread.historyMode === "legacy") {
      const page = await client.request(
        "thread/turns/list",
        {
          threadId,
          cursor,
          limit: 8,
          sortDirection: "desc",
          itemsView: "full",
        },
        120_000,
        parseThreadTurnsPage,
      );
      const match = page.data.find((turn) =>
        turn.items.some((item) => item.type === "userMessage" && item.clientId === commandId),
      );
      if (match) return { turnId: match.id };
      next = page.nextCursor;
    } else {
      const page = await client.request(
        "thread/timeline/list",
        { threadId, cursor, limit: 100 },
        120_000,
        parseThreadTimelinePage,
      );
      const match = page.data.find(
        (entry) =>
          entry.type === "item" &&
          entry.item.type === "userMessage" &&
          entry.item.clientId === commandId,
      );
      if (match) return { turnId: match.turnId };
      next = page.nextCursor;
    }
    if (!next || next === cursor) break;
    cursor = next;
  }
  return null;
}
