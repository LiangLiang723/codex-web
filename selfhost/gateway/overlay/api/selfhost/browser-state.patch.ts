import { createError, readRawBody } from "h3";
import { z } from "zod";
import { requireAuthenticatedUser } from "../../utils/gateway/auth/context";
import { isBrowserStateKey, writeBrowserState } from "../../utils/selfhost-browser-state";

const input = z.object({
  changes: z.array(z.tuple([
    z.string().min(1).max(8192).refine(isBrowserStateKey),
    z.string().max(6 * 1024 * 1024).nullable(),
  ])).min(1).max(1024),
  importLegacy: z.boolean().default(false),
}).strict();

export default defineEventHandler(async (event) => {
  requireAuthenticatedUser(event);
  const raw = await readRawBody(event);
  if (!raw || Buffer.byteLength(raw) > 8 * 1024 * 1024)
    throw createError({ statusCode: 413, message: "浏览器状态写入过大" });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw createError({ statusCode: 400, message: "Invalid JSON" });
  }
  const parsed = input.safeParse(body);
  if (!parsed.success)
    throw createError({ statusCode: 400, message: "Invalid browser state" });
  return writeBrowserState(event, parsed.data.changes, parsed.data.importLegacy);
});
