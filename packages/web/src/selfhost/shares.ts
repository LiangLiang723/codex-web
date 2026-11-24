import { z } from "zod";
import { type Gateway, type Message } from "./gateway.js";
import { array, rec, str } from "./threadProjection.js";
const day = 86400000;
const allSelections = new WeakMap<Gateway, Map<string, string[]>>();
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
    selection = rec(p.selection);
  if (selection.kind === "rowAnchors") throw Error("请选择完整的对话轮次");
  const key = JSON.stringify([hostId, id]);
  const all = selection.kind === "all";
  const saved = allSelections.get(g) ?? new Map<string, string[]>();
  let ids = all
    ? saved.get(key)
    : Array.isArray(selection.productTurnIds)
      ? selection.productTurnIds.map(String)
      : undefined;
  if (!all && !ids?.length) throw Error("请选择完整的对话轮次");
  if (method === "preflight" || !ids) {
    const info = await call("preflight", { hostId, threadId: id, ...(all ? {} : { turns: ids }) });
    const selected = array(info.turns);
    ids = selected.map((t) => str(t.id));
    if (all) {
      saved.set(key, ids);
      if (saved.size > 32) saved.delete(saved.keys().next().value!);
      allSelections.set(g, saved);
    }
    const turnResults = selected.map((t) => ({
      productTurnId: t.id,
      blockingIssues:
        t.status === "inProgress" ? [{ reasonCode: "running_turn", productTurnId: t.id }] : [],
      skippableWarnings: [],
      deferredIssues: [],
    }));
    if (method === "preflight")
      return {
        revision: info.revision,
        logEpoch: info.logEpoch,
        capabilitiesFingerprint: "selfhost-private-text-v1",
        turnResults,
        blockingIssues: turnResults.flatMap((t) => t.blockingIssues),
        skippableWarnings: [],
        deferredIssues: [],
        supportedArtifactTypes: [],
        ttlOptions: { minMs: day, maxMs: 30 * day, defaultMs: 7 * day },
      };
  }
  if (p.accessMode !== "private") throw Error("中心服务器仅支持账户私有分享");
  return link(
    await call("publish", {
      hostId,
      threadId: id,
      turns: ids,
      title: p.title,
      requestId: p.clientRequestId,
      ttlMs: p.ttlMs,
    }),
  );
}
