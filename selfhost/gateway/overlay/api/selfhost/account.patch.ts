import { createError, defineEventHandler, readValidatedBody } from "h3";
import { z } from "zod";
import { requireAuthenticatedUser } from "../../utils/gateway/auth/context";
import { sessionActivityTracker } from "../../utils/gateway/auth/session-activity-tracker";
import { sessionRevocationEvents } from "../../utils/gateway/auth/session-events";
import { hashPassword, hashToken, verifyPassword } from "../../utils/gateway/storage/crypto";
import { withGatewayDatabaseTransaction } from "../../utils/gateway/storage/database";

const changeSchema = z
  .object({
    currentPassword: z.string().min(1).max(4096),
    username: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .transform((s) => s.toLowerCase())
      .optional(),
    newPassword: z.string().min(8).max(4096).optional(),
  })
  .strict()
  .refine((input) => input.username !== undefined || input.newPassword !== undefined);

export default defineEventHandler(async (event) => {
  const { id } = requireAuthenticatedUser(event);
  const input = await readValidatedBody(event, (value) => changeSchema.parse(value));
  const revoked = withGatewayDatabaseTransaction((db) => {
    // 读取请求体期间另一台设备可能已撤销此登录，写入时再次校验原会话。
    if (
      !db
        .prepare("SELECT 1 FROM sessions WHERE user_id=? AND token_hash=? AND expires_at>?")
        .get(id, hashToken(event.context.auth!.token), new Date().toISOString())
    ) {
      throw createError({ statusCode: 401, message: "登录已失效" });
    }
    const current = db
      .prepare("SELECT username,password_hash FROM users WHERE id=? AND is_active=1")
      .get(id);
    if (!current || !verifyPassword(input.currentPassword, String(current.password_hash))) {
      throw createError({ statusCode: 403, message: "当前密码不正确" });
    }
    const username = input.username ?? String(current.username);
    if (db.prepare("SELECT 1 FROM users WHERE username=? AND id<>?").get(username, id)) {
      throw createError({ statusCode: 409, message: "该用户名已被使用" });
    }
    if (username === current.username && input.newPassword === undefined) return [];
    // 保持账号 ID 与主机归属；提交后再通知旧连接，避免回滚时误踢用户。
    db.prepare("UPDATE users SET username=?,password_hash=?,updated_at=? WHERE id=?").run(
      username,
      input.newPassword === undefined ? current.password_hash : hashPassword(input.newPassword),
      new Date().toISOString(),
      id,
    );
    const sessions = db.prepare("SELECT token_hash FROM sessions WHERE user_id=?").all(id);
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
    return sessions.map((row) => String(row.token_hash));
  });
  for (const hash of revoked) {
    sessionActivityTracker.forget(hash);
    sessionRevocationEvents.emit(hash);
  }
  return { reauthenticate: revoked.length > 0 };
});
