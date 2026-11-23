import { z } from "zod";
import { type Gateway, type Message } from "./gateway.js";
import { array, rec, str } from "./threadProjection.js";
const day = 86400000;
export async function shareOperation(
  g: Gateway,
  hostId: number,
  method: string,
  p: Message,
  arg: unknown,
) {
  const call = async (operation: string, args: Message = {}) =>
    rec(await g.request("/api/selfhost/shares", z.unknown(), "POST", { operation, ...args }));
  const link = (s: Message) => ({
    ...s,
    share_url: new URL("?share=" + encodeURIComponent(str(s.share_code)), location.origin).href,
  });
  if (method === "getCapabilities")
    return {
      schema_version: 1,
      access_modes: ["private"],
      allowed_artifacts: [],
      ttl_ms: 7 * day,
      min_ttl_ms: day,
      max_ttl_ms: 30 * day,
      max_rows: 300,
      max_payload_bytes: 4 * 1024 * 1024,
      max_artifact_count: 0,
      max_artifact_bytes: 1,
      max_total_artifact_bytes: 1,
    };
  if (method === "listManagedShares") {
    const result = await call("list");
    return { items: array(result.items).map(link) };
  }
  const actions: Record<string, string> = {
    revokeManagedShare: "revoke",
    restoreManagedShare: "restore",
    deleteManagedShare: "delete",
  };
  if (actions[method]) return link(await call(actions[method], { id: arg }));
  if (method !== "preflight" && method !== "publish")
    throw Error("Unsupported private share operation");
  const id = str(p.sessionId),
    info = await g.call("thread.activate", { hostId, threadId: id, limit: 100 });
  const turns = array(rec(rec(info.history).thread).turns),
    selection = rec(p.selection);
  if (selection.kind === "rowAnchors") throw Error("请选择完整的对话轮次");
  const selected =
    selection.kind === "all"
      ? turns
      : turns.filter(
          (t) => Array.isArray(selection.productTurnIds) && selection.productTurnIds.includes(t.id),
        );
  const turnResults = selected.map((t) => ({
    productTurnId: t.id,
    blockingIssues:
      t.status === "inProgress" ? [{ reasonCode: "running_turn", productTurnId: t.id }] : [],
    skippableWarnings: [],
    deferredIssues: [],
  }));
  if (method === "preflight")
    return {
      revision: info.lastEventId,
      logEpoch: info.eventEpoch,
      capabilitiesFingerprint: "selfhost-private-text-v1",
      turnResults,
      blockingIssues: turnResults.flatMap((t) => t.blockingIssues),
      skippableWarnings: [],
      deferredIssues: [],
      supportedArtifactTypes: [],
      ttlOptions: { minMs: day, maxMs: 30 * day, defaultMs: 7 * day },
    };
  if (p.accessMode !== "private") throw Error("中心服务器仅支持账户私有分享");
  return link(
    await call("publish", {
      hostId,
      threadId: id,
      turns: selected.map((t) => t.id),
      title: p.title,
      requestId: p.clientRequestId,
      ttlMs: p.ttlMs,
    }),
  );
}
