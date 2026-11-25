import { createError, defineEventHandler, readValidatedBody } from "h3";
import { z } from "zod";
import { requireAuthenticatedUser } from "../../../utils/gateway/auth/context";
import { hashToken } from "../../../utils/gateway/storage/crypto";
import { gatewayDatabase } from "../../../utils/gateway/storage/database";
import { avatarImageSchema } from "../../../utils/selfhost-avatar";

const profileAvatarSchema = z.object({ avatar: avatarImageSchema.nullable() }).strict();

export default defineEventHandler(async (event) => {
  const { id } = requireAuthenticatedUser(event);
  const { avatar } = await readValidatedBody(event, (body) => profileAvatarSchema.parse(body));
  const now = new Date().toISOString();
  // 上传期间登录可能被撤销，同一条写入校验会话与账号。
  const result = gatewayDatabase()
    .prepare(`UPDATE users SET avatar=?, updated_at=? WHERE id=? AND is_active=1
      AND EXISTS (SELECT 1 FROM sessions WHERE user_id=users.id AND token_hash=? AND expires_at>?)`)
    .run(avatar, now, id, hashToken(event.context.auth!.token), now);
  if (!result.changes) throw createError({ statusCode: 401, message: "登录已失效" });
  return { avatar };
});
