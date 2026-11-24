import { posix } from "node:path";
import type { AgentEvent } from "~~/shared/agent/events";
import { recordFromUnknown } from "~~/shared/utils/records";
import { gatewayDatabase } from "./gateway/storage/database";
import { runtimeLog } from "./gateway/runtime/runtime-log";

const MAX_DIFF = 2 * 1024 * 1024;
const MAX_ITEM_BYTES = 4 * 1024 * 1024;
const MAX_PATHS = 128;
const absent = "0".repeat(40);
type Hunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
};
type Item = {
  path: string;
  patches: Hunk[];
  additions: number;
  deletions: number;
  writeCount: number;
  toolNames: string[];
};
type Summary = { files: number; additions: number; deletions: number };
type File = { path: string; operationCount: number } & (
  | { before: string; after: string; kind: string; diff: string }
  | { reason: "checkpoint_missing" | "unsupported_checkpoint"; message: string }
);
type Change = { path: string; type: string; move: boolean; diff: string };
type SavedTurn = { summary: Summary; details: Summary & { items: Item[] }; files: File[] };
type Pending = {
  cwd?: string;
  diff?: string;
  changes: Map<string, Change[]>;
  bytes: number;
  eligible: boolean;
};
const pending = new Map<string, Pending>();

function validRelative(path: string) {
  return (
    path.length > 0 &&
    path.length <= 4096 &&
    !path.includes("\\") &&
    Array.from(path).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) &&
    path
      .split("/")
      .every(
        (part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git",
      )
  );
}

function relative(cwd: string, nativePath: string) {
  // 原生路径是绝对路径或相对 Thread cwd 的路径，保留文件名中的空格。
  const path = posix.isAbsolute(nativePath)
    ? nativePath.slice(cwd.length + (cwd === "/" ? 0 : 1))
    : nativePath;
  if (posix.isAbsolute(nativePath) && !nativePath.startsWith(cwd === "/" ? "/" : cwd + "/"))
    return null;
  return validRelative(path) ? path : null;
}

function changesOf(item: Record<string, unknown>): Change[] {
  if (!Array.isArray(item.changes)) return [];
  return item.changes.flatMap((raw) => {
    const change = recordFromUnknown(raw);
    const kind = recordFromUnknown(change?.kind);
    if (
      typeof change?.path !== "string" ||
      typeof change.diff !== "string" ||
      typeof kind?.type !== "string"
    )
      return [];
    return [
      {
        path: change.path,
        type: kind.type,
        move: !!(kind.movePath ?? kind.move_path),
        diff: change.diff,
      },
    ];
  });
}

function parseAggregate(diff: string) {
  return diff
    .split(/(?=^diff --git )/mu)
    .filter(Boolean)
    .map((section) => {
      const lines = section.split("\n");
      const metadata = lines.slice(
        0,
        lines.findIndex((line) => line.startsWith("@@ ")) < 0
          ? lines.length
          : lines.findIndex((line) => line.startsWith("@@ ")),
      );
      const pair = metadata.flatMap((line) => {
        const match = /^index ([0-9a-f]{40})\.\.([0-9a-f]{40})$/u.exec(line);
        return match ? [{ before: match[1]!, after: match[2]! }] : [];
      })[0];
      const header = metadata[0] ?? "";
      const from = metadata.find((line) => line.startsWith("--- a/"))?.slice(6);
      const to = metadata.find((line) => line.startsWith("+++ b/"))?.slice(6);
      const zeroLengthPath = /^diff --git a\/(.+) b\/\1$/u.exec(header)?.[1];
      const path = to ?? from ?? zeroLengthPath ?? "";
      const patches: Hunk[] = [];
      let hunk: Hunk | undefined;
      for (const line of lines) {
        const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
        if (match) {
          hunk = {
            oldStart: Number(match[1]),
            oldLines: Number(match[2] ?? 1),
            newStart: Number(match[3]),
            newLines: Number(match[4] ?? 1),
            lines: [],
          };
          patches.push(hunk);
        } else if (hunk && /^[ +\-\\]/u.test(line)) hunk.lines.push(line);
      }
      const counts = patches.flatMap(({ lines: content }) => content);
      return {
        path,
        pair,
        patches,
        additions: counts.filter((line) => line.startsWith("+")).length,
        deletions: counts.filter((line) => line.startsWith("-")).length,
        rename:
          (from !== undefined && to !== undefined && from !== to) ||
          metadata.some((line) => /^rename (from|to) /u.test(line)),
      };
    });
}

function buildEvidence(
  cwd: string,
  diff: string,
  itemChanges: Change[],
  eligible: boolean,
): SavedTurn | null {
  const sections = parseAggregate(diff);
  if (
    !sections.length ||
    sections.length > MAX_PATHS ||
    sections.some(({ path }) => !relative(cwd, path))
  )
    return null;
  const groups = new Map<string, Change[]>();
  for (const change of itemChanges) {
    const path = relative(cwd, change.path);
    if (!path) continue;
    const entries = groups.get(path) ?? [];
    entries.push(change);
    groups.set(path, entries);
  }
  const files: File[] = [],
    items: Item[] = [],
    seen = new Set<string>();
  for (const section of sections) {
    const path = relative(cwd, section.path)!;
    if (seen.has(path)) return null;
    seen.add(path);
    const writes = groups.get(path) ?? [];
    const operationCount = Math.max(1, writes.length);
    items.push({
      path: posix.join(cwd, path),
      additions: section.additions,
      deletions: section.deletions,
      patches: section.patches,
      writeCount: operationCount,
      toolNames: ["apply_patch"],
    });
    if (!eligible || !section.pair || writes.length === 0) {
      files.push({
        path,
        operationCount,
        reason: "checkpoint_missing",
        message: "缺少该轮的完整原生文件凭据",
      });
      continue;
    }
    const change = writes[0]!;
    const { before, after } = section.pair;
    const kind = before === absent ? "add" : after === absent ? "delete" : "update";
    if (writes.length !== 1 || change.move || section.rename || change.type !== kind) {
      files.push({
        path,
        operationCount,
        reason: "unsupported_checkpoint",
        message: "仅支持可用单次成功补丁核对前后内容的普通文件",
      });
      continue;
    }
    files.push({ path, operationCount, before, after, kind, diff: change.diff });
  }
  const summary = {
    files: items.length,
    additions: items.reduce((sum, item) => sum + item.additions, 0),
    deletions: items.reduce((sum, item) => sum + item.deletions, 0),
  };
  return { summary, details: { ...summary, items }, files };
}

function database() {
  const db = gatewayDatabase();
  db.exec(`CREATE TABLE IF NOT EXISTS selfhost_turn_files (
    remote_key TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL,
    cwd TEXT NOT NULL, summary TEXT NOT NULL, evidence TEXT NOT NULL,
    PRIMARY KEY (remote_key, thread_id, turn_id)
  )`);
  return db;
}

export async function verifiedTurnDirectories(
  remoteKey: string,
  threadId: string,
  turnIds: string[],
  matches: (directory: string) => Promise<boolean>,
) {
  const verified = new Map<string, string>();
  if (!turnIds.length) return verified;
  // 观察时的工作目录可能是别名。只在相同远端、会话和轮次内查找，再由 SSH 核实物理目录。
  const rows = database()
    .prepare(`SELECT turn_id, cwd FROM selfhost_turn_files
    WHERE remote_key=? AND thread_id=? AND turn_id IN (${turnIds.map(() => "?").join(",")})`)
    .all(remoteKey, threadId, ...turnIds) as Array<{ turn_id: string; cwd: string }>;
  const paths = new Set(rows.map((row) => row.cwd));
  const allowed = new Set(
    (
      await Promise.all([...paths].map(async (path) => ((await matches(path)) ? path : null)))
    ).filter((path): path is string => path !== null),
  );
  for (const row of rows) if (allowed.has(row.cwd)) verified.set(row.turn_id, row.cwd);
  return verified;
}

export function readTurnFileSummary(
  remoteKey: string,
  threadId: string,
  turnId: string,
  cwd: string,
) {
  const row = database()
    .prepare(`SELECT summary FROM selfhost_turn_files
    WHERE remote_key = ? AND thread_id = ? AND turn_id = ? AND cwd = ?`)
    .get(remoteKey, threadId, turnId, cwd);
  return typeof row?.summary === "string" ? (JSON.parse(row.summary) as Summary) : null;
}

export function readTurnFileEvidence(
  remoteKey: string,
  threadId: string,
  turnId: string,
  cwd: string,
) {
  const row = database()
    .prepare(`SELECT evidence FROM selfhost_turn_files
    WHERE remote_key = ? AND thread_id = ? AND turn_id = ? AND cwd = ?`)
    .get(remoteKey, threadId, turnId, cwd);
  return typeof row?.evidence === "string" ? (JSON.parse(row.evidence) as SavedTurn) : null;
}

export function captureTurnFiles(
  remoteKey: string,
  threadId: string,
  event: AgentEvent,
  cwd?: string,
  connectionKey = remoteKey,
) {
  if (
    event.type !== "turn.started" &&
    event.type !== "turn.completed" &&
    event.type !== "turn.diff.updated" &&
    event.type !== "timeline.item.upsert"
  )
    return;
  const isTurn = event.type === "turn.started" || event.type === "turn.completed";
  const turn = isTurn ? recordFromUnknown(event.turn) : null;
  const rawId = isTurn
    ? turn?.id
    : event.type === "turn.diff.updated"
      ? event.turnId
      : event.item.turnId;
  if (typeof rawId !== "string" && typeof rawId !== "number") return;
  const turnId = String(rawId),
    key = JSON.stringify([remoteKey, connectionKey, threadId, turnId]);
  if (event.type === "turn.started") {
    if (!pending.has(key)) pending.set(key, { cwd, changes: new Map(), bytes: 0, eligible: true });
    while (pending.size > 64) {
      const oldest = pending.keys().next().value;
      if (oldest === undefined) break;
      pending.delete(oldest);
    }
    return;
  }
  const item = pending.get(key);
  if (!item) return;
  if (event.type === "turn.diff.updated") {
    // 原生通知是累积快照。空值同样覆盖旧值，不能复用较早的非空 diff。
    item.diff = Buffer.byteLength(event.diff) <= MAX_DIFF ? event.diff : undefined;
    return;
  }
  if (event.type === "timeline.item.upsert") {
    const native = event.item;
    if (
      native.type !== "fileChange" ||
      native.status !== "completed" ||
      typeof native.id !== "string" ||
      !item.eligible ||
      item.changes.has(native.id)
    )
      return;
    const changes = changesOf(native);
    item.bytes += changes.reduce((sum, change) => sum + Buffer.byteLength(change.diff), 0);
    if (item.bytes > MAX_ITEM_BYTES || item.changes.size >= MAX_PATHS) {
      item.eligible = false;
      item.changes.clear();
    } else item.changes.set(native.id, changes);
    return;
  }
  pending.delete(key);
  if (
    !item.diff ||
    !(cwd ?? item.cwd) ||
    (cwd && item.cwd && posix.normalize(cwd) !== posix.normalize(item.cwd))
  )
    return;
  try {
    const sourceCwd = posix.normalize(cwd ?? item.cwd!).replace(/\/$/u, "") || "/";
    const evidence = buildEvidence(
      sourceCwd,
      item.diff,
      [...item.changes.values()].flat(),
      item.eligible,
    );
    if (!evidence) return;
    database()
      .prepare(`INSERT INTO selfhost_turn_files (remote_key, thread_id, turn_id, cwd, summary, evidence)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
      .run(
        remoteKey,
        threadId,
        turnId,
        sourceCwd,
        JSON.stringify(evidence.summary),
        JSON.stringify(evidence),
      );
  } catch (error) {
    runtimeLog("turn file evidence unavailable", {
      threadId,
      turnId,
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}
