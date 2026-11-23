import { createError, readRawBody } from "h3";
import { z } from "zod";
import { catalogEvents } from "../../utils/gateway/config/pinned-thread-events";
import { requireAuthenticatedUser } from "../../utils/gateway/auth/context";
import { updateSettings } from "../../utils/selfhost-settings";
export default defineEventHandler(async (event) => {
  const text = await readRawBody(event);
  if (!text || Buffer.byteLength(text) > 256 * 1024)
    throw createError({ statusCode: 400, message: "Invalid settings body" });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw createError({ statusCode: 400, message: "Invalid JSON" });
  }
  const parsed = z.record(z.string().min(1).max(96), z.unknown()).safeParse(raw);
  if (
    !parsed.success ||
    Object.keys(parsed.data).some((k) => ["__proto__", "constructor", "prototype"].includes(k))
  )
    throw createError({ statusCode: 400, message: "Invalid settings" });
  const result = updateSettings(event, parsed.data);
  catalogEvents.publish(requireAuthenticatedUser(event).id);
  return result;
});
