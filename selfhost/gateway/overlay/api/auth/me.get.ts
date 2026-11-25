import { requireAuthenticatedUser } from "../../utils/gateway/auth/context";
import { gatewayDatabase } from "../../utils/gateway/storage/database";

export default defineEventHandler((event) => {
  const user = requireAuthenticatedUser(event);
  const row = gatewayDatabase().prepare("SELECT avatar FROM users WHERE id=?").get(user.id);
  return { user: { ...user, avatar: typeof row?.avatar === "string" ? row.avatar : null } };
});
