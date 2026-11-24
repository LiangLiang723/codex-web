import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gatewayDatabasePath, gatewayDatabase } from "./gateway/storage/database";
import { decryptJson, encryptJson } from "./gateway/storage/crypto";
import { runWithGatewayUser } from "./gateway/state/memory";
import { ensureUserConfigLoaded } from "./gateway/http/errors";
import { hostStore } from "./gateway/state/hosts";
import { threadBroker } from "./gateway/runtime/broker";
import { callWorkspace } from "./selfhost-workspace";
import { automationBinding, suspendTarget, targetChanged } from "./selfhost-automation-binding";
import { z } from "zod";

const assetDir = process.env.SELFHOST_ASSET_DIR || "/app/selfhost-assets";
const upstream = () => createRequire(import.meta.url)(join(assetDir, "organization.cjs"));
const groups = new Map<string, DatabaseSync>();
function groupRepo(user: number, host: number) {
  const scope = user + "-" + host;
  let db = groups.get(scope);
  if (!db) {
    db = new DatabaseSync(join(dirname(gatewayDatabasePath()), "groups-" + scope + ".sqlite"));
    db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL");
    db.exec(readFileSync(join(assetDir, "task-groups.sql"), "utf8"));
    db.exec(upstream().TASK_GROUP_ADMISSIONS_SQL);
    groups.set(scope, db);
  }
  return new (upstream().TaskGroupRepository)(db);
}
const groupMethods = new Set(["read", "save", "ungroup", "move", "admit"]);
export function taskGroups(user: number, host: number, method: string, args: unknown[]) {
  if (!groupMethods.has(method)) throw Error("Unknown group operation");
  const repo = groupRepo(user, host);
  if (method === "admit") {
    const p = z
      .object({
        tasks: z
          .array(
            z
              .object({ taskId: z.string(), workspacePath: z.string(), hostId: z.string() })
              .passthrough(),
          )
          .max(3000),
        placement: z.unknown().optional(),
      })
      .parse(args[0]);
    return repo.admit(p.tasks, p.placement);
  }
  return repo[method](...args);
}
function database() {
  const db = gatewayDatabase();
  db.exec(`CREATE TABLE IF NOT EXISTS selfhost_automations(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,host_id INTEGER NOT NULL,cwd TEXT NOT NULL,due INTEGER,definition TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS selfhost_automation_due ON selfhost_automations(due);
 CREATE TABLE IF NOT EXISTS selfhost_automation_runs(id TEXT PRIMARY KEY,automation_id TEXT NOT NULL REFERENCES selfhost_automations(id) ON DELETE CASCADE,created INTEGER NOT NULL,detail TEXT NOT NULL);`);
  return db;
}
const record = z.record(z.string(), z.unknown());
type Definition = Record<string, any>;
function save(user: number, host: number, a: Definition) {
  database()
    .prepare(
      "INSERT INTO selfhost_automations(id,user_id,host_id,cwd,due,definition) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET due=excluded.due,definition=excluded.definition",
    )
    .run(
      a.automationId,
      user,
      host,
      a.workspacePath,
      a.enabled ? (a.nextRunAt ?? null) : null,
      encryptJson(a),
    );
  return a;
}
function runRow(id: string, a: string, r: Definition) {
  database()
    .prepare(
      "INSERT INTO selfhost_automation_runs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET detail=excluded.detail",
    )
    .run(id, a, r.createdAt, encryptJson(r));
}
const fields = z.object({
  title: z.string().min(1).max(256),
  prompt: z.string().min(1).max(262144),
  cronExpr: z.string().min(1).max(200),
  recurring: z.boolean().optional(),
  targetTaskId: z.string().nullable().optional(),
  scheduleRule: z.record(z.string(), z.unknown()).optional(),
  modelSelection: z
    .object({
      modelId: z.string(),
      providerId: z.string(),
      options: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  mode: z.string().optional(),
  endAt: z.number().optional(),
  maxRuns: z.number().int().positive().optional(),
});
function schedule(a: Definition) {
  const t = upstream().computeInitialAutomationNextRunAt(a);
  if (!t || !Number.isFinite(t)) throw Error("无效的调度表达式");
  return t;
}
async function verifiedTarget(hostId: number, directory: unknown, threadId?: string | null) {
  const cwd = z.string().startsWith("/").parse(directory);
  const host = hostStore.getWithSecret(hostId);
  if (!host) throw Error("SSH 主机不存在");
  const binding = automationBinding(host);
  const canonicalDirectory = z
    .string()
    .startsWith("/")
    .parse(
      await callWorkspace(host, {
        channel: "system",
        method: "resolveDirectory",
        args: [{ path: cwd }],
      }),
    );
  if (threadId) {
    const read = (await threadBroker.selfhostCapability(host, "thread/read", {
      threadId,
      includeTurns: false,
    })) as { thread?: { cwd?: string } };
    if (read.thread?.cwd !== canonicalDirectory && read.thread?.cwd !== cwd)
      throw Error("目标对话的工作目录与所选项目不一致");
  }
  const current = hostStore.getWithSecret(hostId);
  if (!current || automationBinding(current) !== binding) throw Error(targetChanged);
  return { workspacePath: cwd, workspaceKey: cwd, targetBinding: binding, canonicalDirectory };
}
export async function automations(
  user: number,
  hostId: number,
  cwd: string,
  method: string,
  args: unknown[],
) {
  const p = record.parse(args[0] ?? {}),
    db = database();
  if (method === "listAllAutomations" || method === "listAutomations")
    return db
      .prepare(
        "SELECT definition FROM selfhost_automations WHERE user_id=? AND host_id=? AND (? OR cwd=?) ORDER BY rowid DESC",
      )
      .all(user, hostId, method === "listAllAutomations" ? 1 : 0, cwd)
      .map((row) => {
        const a = decryptJson(String(row.definition)) as Definition;
        const host = hostStore.get(hostId);
        return a.enabled && (!host || a.targetBinding !== automationBinding(host))
          ? save(user, hostId, suspendTarget(a))
          : a;
      });
  if (method === "createAutomation") {
    const input = fields.parse(p),
      now = Date.now();
    const a = {
      ...input,
      automationId: randomUUID(),
      // 表单可以从项目 A 选择 B，派发目标归用户的选择和经验证的远端主机。
      ...(await verifiedTarget(hostId, p.workspacePath ?? cwd, input.targetTaskId)),
      locationKind: "remote",
      title: input.title,
      recurring: input.recurring ?? true,
      enabled: true,
      lifecycleStatus: "active",
      dispatchStatus: "idle",
      dispatchAttempts: 0,
      runCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    return save(user, hostId, { ...a, nextRunAt: schedule(a) });
  }
  const row = db
    .prepare("SELECT definition FROM selfhost_automations WHERE user_id=? AND host_id=? AND id=?")
    .get(user, hostId, String(p.automationId));
  if (!row) throw Error("找不到自动化任务");
  const a = decryptJson(String(row.definition)) as Definition;
  if (method === "deleteAutomation") {
    db.prepare("DELETE FROM selfhost_automations WHERE id=?").run(a.automationId);
    return;
  }
  if (method === "listAutomationRuns") {
    const runs = db
      .prepare(
        "SELECT detail FROM selfhost_automation_runs WHERE automation_id=? ORDER BY created DESC",
      )
      .all(a.automationId)
      .map((row) => decryptJson(String(row.detail)) as Definition);
    const host = hostStore.getWithSecret(hostId);
    if (host && a.targetBinding === automationBinding(host))
      await Promise.all(
        runs
          .filter((r) => r.outcome === "running" && r.turnId && r.sessionId)
          .slice(0, 12)
          .map(async (r) => {
            const result = (await threadBroker.selfhostCapability(host, "thread/read", {
              threadId: r.sessionId,
              includeTurns: true,
            })) as { thread: { turns: { id: string; status: string }[] } };
            const status = result.thread.turns.find((t) => t.id === r.turnId)?.status;
            if (status && status !== "inProgress") {
              r.outcome =
                status === "completed"
                  ? "succeeded"
                  : status === "interrupted"
                    ? "stopped"
                    : "failed";
              r.updatedAt = Date.now();
              runRow(r.runId, a.automationId, r);
            }
          })
          .map((p) => p.catch(() => {})),
      );
    return runs;
  }
  if (method === "deleteAutomationRun") {
    db.prepare("DELETE FROM selfhost_automation_runs WHERE id=? AND automation_id=?").run(
      String(p.runId),
      a.automationId,
    );
    return;
  }
  if (method === "runAutomationNow") return dispatch(user, hostId, a, false);
  if (method === "updateAutomation") {
    Object.assign(a, fields.partial().parse(p.patch ?? p));
  } else if (method === "setAutomationEnabled" || method === "restartAutomation") {
    a.enabled = method === "restartAutomation" || z.boolean().parse(p.enabled);
    if (a.enabled) {
      Object.assign(a, await verifiedTarget(hostId, a.workspacePath, a.targetTaskId));
      delete a.lastError;
    }
  } else throw Error("Unknown automation operation");
  a.updatedAt = Date.now();
  a.lifecycleStatus = a.enabled ? "active" : "paused";
  a.nextRunAt = a.enabled ? schedule(a) : undefined;
  return save(user, hostId, a);
}
async function dispatch(user: number, hostId: number, a: Definition, scheduled: boolean) {
  const latest = database()
    .prepare("SELECT definition FROM selfhost_automations WHERE user_id=? AND host_id=? AND id=?")
    .get(user, hostId, a.automationId);
  if (!latest) throw Error("找不到自动化任务");
  const claimedAt = a.nextRunAt;
  a = decryptJson(String(latest.definition)) as Definition;
  if (scheduled && (!a.enabled || claimedAt !== a.nextRunAt)) return;
  const host = hostStore.getWithSecret(hostId);
  // 数字主机 ID 可被重新使用。执行时再次核对并保留旧定义与历史，避免误派给新机器。
  if (!host || a.targetBinding !== automationBinding(host)) {
    save(user, hostId, suspendTarget(a));
    throw Error(targetChanged);
  }
  const now = Date.now(),
    id = a.automationId + ":" + (scheduled ? a.nextRunAt : "manual:" + randomUUID()),
    db = database();
  if (db.prepare("SELECT id FROM selfhost_automation_runs WHERE id=?").get(id)) return;
  const r: Definition = {
    runId: id,
    automationId: a.automationId,
    workspaceKey: a.workspaceKey,
    trigger: scheduled ? "schedule" : "manual",
    scheduledAt: scheduled ? a.nextRunAt : undefined,
    dispatchStatus: "claimed",
    attempts: 1,
    createdAt: now,
    updatedAt: now,
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    runRow(id, a.automationId, r);
    a.runCount++;
    a.lastRunAt = now;
    a.updatedAt = now;
    if (scheduled) {
      a.nextRunAt = a.recurring ? upstream().computeAutomationNextRunAt(a, now) : undefined;
      if (
        !a.nextRunAt ||
        (a.maxRuns && a.runCount >= a.maxRuns) ||
        (a.endAt && a.nextRunAt > a.endAt)
      ) {
        a.enabled = false;
        a.lifecycleStatus = "completed";
      }
    }
    save(user, hostId, a);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  try {
    const model = a.modelSelection?.modelId,
      effort = a.modelSelection?.options?.reasoningLevel;
    const policy = a.mode === "guarded" ? "untrusted" : "on-request";
    const target = await verifiedTarget(hostId, a.workspacePath, a.targetTaskId);
    // 路径别名重新指向其他目录时保留原定义，实际开轮只用已验证的规范目录。
    if (
      a.canonicalDirectory !== target.canonicalDirectory ||
      a.targetBinding !== target.targetBinding
    ) {
      save(user, hostId, suspendTarget(a));
      throw Error(targetChanged);
    }
    const started = a.targetTaskId
      ? null
      : await threadBroker.startThread(host, {
          cwd: target.canonicalDirectory,
          model,
          approvalPolicy: policy,
          sandbox: "workspace-write",
        });
    const threadId = a.targetTaskId ?? started?.thread?.id;
    if (!threadId) throw Error("Codex returned no Thread");
    const currentHost = hostStore.getWithSecret(hostId);
    if (!currentHost || automationBinding(currentHost) !== a.targetBinding)
      throw Error(targetChanged);
    r.sessionId = threadId;
    runRow(id, a.automationId, r);
    const startedTurn = await threadBroker.startTurn(host, threadId, {
      text: a.prompt,
      cwd: target.canonicalDirectory,
      model,
      effort,
      approvalPolicy: policy,
      clientUserMessageId: id,
    });
    r.turnId = startedTurn?.turn?.id;
    r.dispatchStatus = "dispatched";
    r.outcome = "running";
    return { status: "queued", taskId: threadId, sessionId: threadId, runId: id };
  } catch (e) {
    r.dispatchStatus = "failed_to_dispatch";
    r.error = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    r.updatedAt = Date.now();
    runRow(id, a.automationId, r);
  }
}
export async function runDueAutomations() {
  const now = Date.now(),
    rows = database()
      .prepare(
        "SELECT * FROM selfhost_automations WHERE due IS NOT NULL AND due<=? ORDER BY due LIMIT 20",
      )
      .all(now);
  for (const row of rows) {
    const user = Number(row.user_id);
    await runWithGatewayUser(user, async () => {
      ensureUserConfigLoaded(user);
      await dispatch(
        user,
        Number(row.host_id),
        decryptJson(String(row.definition)) as Definition,
        true,
      );
    }).catch(() => {});
  }
  return { count: rows.length };
}
