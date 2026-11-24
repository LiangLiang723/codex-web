import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { HostRecord } from "~~/shared/types";
import { remoteHostIdentity } from "~~/shared/utils/workspace";
import { encryptJson, decryptJson } from "./gateway/storage/crypto";

export const targetChanged = "SSH 主机已变更，请核对目标目录后重新启用自动化";

export function automationBinding(host: HostRecord) {
  return createHash("sha256")
    .update(JSON.stringify([host.createdAt, remoteHostIdentity(host)]))
    .digest("hex");
}

export function suspendTarget(definition: Record<string, unknown>) {
  return {
    ...definition,
    targetBinding: null,
    enabled: false,
    nextRunAt: undefined,
    lifecycleStatus: "paused",
    lastError: targetChanged,
  };
}

export function suspendHostAutomations(db: DatabaseSync, user: number, hostId: number) {
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='selfhost_automations'")
      .get()
  )
    return;
  const suspended = db.prepare(
    "UPDATE selfhost_automations SET due=NULL,definition=? WHERE user_id=? AND host_id=? AND id=?",
  );
  for (const row of db
    .prepare("SELECT id,definition FROM selfhost_automations WHERE user_id=? AND host_id=?")
    .all(user, hostId)) {
    const definition = decryptJson(String(row.definition)) as Record<string, unknown>;
    suspended.run(encryptJson(suspendTarget(definition)), user, hostId, row.id);
  }
}
