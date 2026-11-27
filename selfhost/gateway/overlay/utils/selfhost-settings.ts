import { requireAuthenticatedUser } from "./gateway/auth/context";
import { gatewayDatabase, withGatewayDatabaseTransaction } from "./gateway/storage/database";
import { decryptJson, encryptJson, hashToken } from "./gateway/storage/crypto";
import { createError, type H3Event } from "h3";

function table() {
  const db = gatewayDatabase();
  db.exec(
    "CREATE TABLE IF NOT EXISTS zcode_settings (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, settings TEXT NOT NULL)",
  );
  return db;
}
export function settingsFor(event: H3Event) {
  const user = requireAuthenticatedUser(event);
  const row = table().prepare("SELECT settings FROM zcode_settings WHERE user_id=?").get(user.id);
  return row ? (decryptJson(String(row.settings)) as Record<string, unknown>) : {};
}
export function updateSettings(
  event: H3Event,
  change: Record<string, unknown>,
  onlyIfAbsent: readonly string[] = [],
) {
  const user = requireAuthenticatedUser(event);
  table();
  return withGatewayDatabaseTransaction((db) => {
    if (!db.prepare(
      "SELECT 1 FROM sessions WHERE user_id=? AND token_hash=? AND expires_at>?",
    ).get(user.id, hashToken(event.context.auth!.token), new Date().toISOString()))
      throw createError({ statusCode: 401, message: "登录已失效" });
    const previous = settingsFor(event);
    if (onlyIfAbsent.some((key) => Object.hasOwn(previous, key))) return previous;
    const current = { ...previous, ...change };
    db.prepare(
      "INSERT INTO zcode_settings(user_id,settings) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET settings=excluded.settings",
    ).run(user.id, encryptJson(current));
    return current;
  });
}
