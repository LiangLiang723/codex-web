import { remoteHostIdentity } from "~~/shared/utils/workspace";
import { catalogEvents } from "./gateway/config/pinned-thread-events";
import { hostStore } from "./gateway/state/hosts";
import { currentGatewayUserId, type StoredHostRecord } from "./gateway/state/memory";
import { gatewayDatabase } from "./gateway/storage/database";

function hostKey(host: StoredHostRecord) {
  return JSON.stringify([host.id, host.createdAt, remoteHostIdentity(host)]);
}

export function unreadThreadMarkers(host: StoredHostRecord, ids: readonly string[]) {
  const userId = currentGatewayUserId();
  if (userId === null || !ids.length) return new Map<string, number>();
  const rows = gatewayDatabase().prepare(
    `SELECT thread_id,unread_at FROM zcode_thread_unread WHERE user_id=? AND host_key=? AND thread_id IN (${ids.map(() => "?").join(",")})`,
  ).all(userId, hostKey(host), ...ids);
  return new Map(rows.map(({ thread_id, unread_at }) => [String(thread_id), Number(unread_at)]));
}

export function setThreadUnread(
  userId: number,
  host: StoredHostRecord,
  threadId: string,
  unread: boolean,
  expectedUnreadAt?: number,
) {
  const db = gatewayDatabase();
  const target = [userId, hostKey(host), threadId] as const;
  const predicate =
    "DELETE FROM zcode_thread_unread WHERE user_id=? AND host_key=? AND thread_id=?";
  const change = unread
    ? db
        .prepare(`INSERT INTO zcode_thread_unread(user_id,host_key,thread_id,unread_at) VALUES(?,?,?,?)
        ON CONFLICT(user_id,host_key,thread_id) DO UPDATE SET unread_at=max(excluded.unread_at,unread_at+1)`)
        .run(...target, Date.now())
    : expectedUnreadAt === undefined
      ? db.prepare(predicate).run(...target)
      : db.prepare(predicate + " AND unread_at=?").run(...target, expectedUnreadAt);
  if (Number(change.changes)) catalogEvents.publish(userId);
}

export function clearDeletedThreadUnread(userId: number, hostId: number, threadId: string) {
  const host = hostStore.get(hostId);
  if (!host) return;
  gatewayDatabase()
    .prepare("DELETE FROM zcode_thread_unread WHERE user_id=? AND host_key=? AND thread_id=?")
    .run(userId, hostKey(host), threadId);
}
