import type { Message } from "./gateway.js";

export function rec(v: unknown): Message {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v))
    : {};
}
export function array(v: unknown): Message[] {
  return Array.isArray(v) ? v.map(rec) : [];
}
export function str(v: unknown, fallback = "") {
  return typeof v === "string" ? v : fallback;
}
export function num(v: unknown, fallback = 0) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function nativeItemDurationMs(item: Message) {
  const start = num(item.startedAtMs, -1);
  const end = num(item.completedAtMs, -1);
  if (start >= 0 && end >= start) return end - start;
  const duration = num(item.durationMs, -1);
  return duration >= 0 ? duration : undefined;
}
