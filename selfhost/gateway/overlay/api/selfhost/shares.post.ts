import { randomUUID } from "node:crypto";
import { readValidatedBody, createError } from "h3";
import { z } from "zod";
import { gatewayDatabase } from "../../utils/gateway/storage/database";
import { encryptJson, decryptJson } from "../../utils/gateway/storage/crypto";
import { defineGatewayEventHandler } from "../../utils/gateway/http/errors";
import { requireRecord } from "../../utils/gateway/http/validation/common";
import { hostStore } from "../../utils/gateway/state/hosts";
import { threadBroker } from "../../utils/gateway/runtime/broker";
import { readShareTurns } from "../../utils/selfhost-share-turns";
import { gatewayEventStore } from "../../utils/gateway/state/gateway-events";
const day = 86400000;
const input = z.object({
  operation: z.enum(["preflight", "publish", "read", "list", "restore", "revoke", "delete"]),
  id: z.string().max(100).optional(),
  hostId: z.number().int().positive().optional(),
  threadId: z.string().max(120).optional(),
  turns: z.array(z.string().min(1)).min(1).max(300).optional(),
  title: z.string().max(512).optional(),
  requestId: z.string().max(128).optional(),
  ttlMs: z
    .number()
    .int()
    .min(day)
    .max(30 * day)
    .optional(),
});
export default defineGatewayEventHandler(async (event) => {
  const p = await readValidatedBody(event, (v) => input.parse(v)),
    user = event.context.auth!.user.id,
    db = gatewayDatabase();
  db.exec(
    "CREATE TABLE IF NOT EXISTS zcode_private_shares(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,request_id TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,snapshot TEXT NOT NULL,UNIQUE(user_id,request_id))",
  );
  const meta = (r: Record<string, unknown>) => {
    const data = decryptJson(String(r.snapshot)) as { title: string; sessionId: string };
    return {
      share_id: r.id,
      share_code: r.id,
      access_mode: "private",
      status: r.status,
      title: data.title,
      source_session_id: data.sessionId,
      created_at: r.created,
      expires_at: r.expires,
    };
  };
  if (p.operation === "list")
    return {
      items: db
        .prepare("SELECT * FROM zcode_private_shares WHERE user_id=? ORDER BY created DESC")
        .all(user)
        .map(meta),
    };
  if (p.operation === "publish" || p.operation === "preflight") {
    if (!p.hostId || !p.threadId || (p.operation === "publish" && (!p.requestId || !p.turns)))
      throw Error("Incomplete share selection");
    const existing = db
      .prepare("SELECT * FROM zcode_private_shares WHERE user_id=? AND request_id=?")
      .get(user, p.requestId ?? null);
    if (existing) return meta(existing);
    const host = requireRecord(hostStore.getWithSecret(p.hostId), "Host not found");
    // 预检和发布都按原生轮次分页，不能让激活时最后一页截断用户的选择。
    const turns = await readShareTurns(
      (cursor) =>
        threadBroker.selfhostCapability(host, "thread/turns/list", {
          threadId: p.threadId,
          cursor,
          limit: 20,
          sortDirection: "asc",
          itemsView: p.operation === "preflight" ? "notLoaded" : "full",
        }),
      p.turns,
    );
    if (p.operation === "preflight")
      return {
        turns: turns.map(({ id, status }) => ({ id, status })),
        revision: gatewayEventStore.latestId(host.id, p.threadId),
        logEpoch: gatewayEventStore.epoch(host.id),
      };
    if (turns.some((t) => t.status === "inProgress")) throw Error("部分轮次尚未完成或已不可用");
    const clean = turns.map((t) => ({
      id: t.id,
      status: t.status,
      items: t.items.flatMap((item) =>
        item.type === "userMessage"
          ? [
              {
                id: item.id,
                type: item.type,
                content: Array.isArray(item.content)
                  ? item.content
                      .filter((c) => c.type === "text")
                      .map((c) => ({ type: "text", text: c.text }))
                  : [],
              },
            ]
          : item.type === "agentMessage"
            ? [{ id: item.id, type: item.type, text: item.text }]
            : [],
      ),
    }));
    const now = Date.now(),
      id = randomUUID();
    const data = {
      title: p.title || p.threadId,
      sessionId: p.threadId,
      history: { thread: { id: p.threadId, turns: clean } },
    };
    if (Buffer.byteLength(JSON.stringify(data)) > 4 * 1024 * 1024)
      throw Error("所选文本超过 4 MiB");
    db.prepare(
      "INSERT INTO zcode_private_shares VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,request_id) DO NOTHING",
    ).run(id, user, p.requestId!, "active", now, now + (p.ttlMs ?? 7 * day), encryptJson(data));
    return meta(
      db
        .prepare("SELECT * FROM zcode_private_shares WHERE user_id=? AND request_id=?")
        .get(user, p.requestId!)!,
    );
  }
  const row = db
    .prepare("SELECT * FROM zcode_private_shares WHERE id=? AND user_id=?")
    .get(p.id ?? "", user);
  if (!row) throw createError({ statusCode: 404, message: "找不到分享" });
  if (p.operation === "read") {
    if (row.status !== "active" || Number(row.expires) <= Date.now())
      throw createError({ statusCode: 410, message: "分享已失效" });
    return decryptJson(String(row.snapshot));
  }
  if (p.operation === "delete") {
    db.prepare("DELETE FROM zcode_private_shares WHERE id=? AND user_id=?").run(p.id!, user);
    return { deleted: true };
  }
  const status = p.operation === "revoke" ? "revoked" : "active";
  db.prepare("UPDATE zcode_private_shares SET status=? WHERE id=? AND user_id=?").run(
    status,
    p.id!,
    user,
  );
  return meta({ ...row, status });
});
