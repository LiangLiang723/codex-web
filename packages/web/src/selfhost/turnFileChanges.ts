import {
  conversationRowTargetSchema,
  type CommandAck,
  type CommandEnvelope,
  type ConversationSnapshot,
  v4ConversationFileChangesResultSchema,
  v4ConversationFileRewindPreviewResultSchema,
  type V4ConversationFileChangesResult,
} from "@zcode/shared/zcode-protocol-v4";
import { z } from "zod";
import type { Gateway, Message } from "./gateway.js";

type Item = V4ConversationFileChangesResult["items"][number];
type Hunk = Item["patches"][number];
const summarySchema = v4ConversationFileChangesResultSchema.omit({ items: true }).extend({
  eligible: z.boolean(),
});
const summariesSchema = z.record(z.string(), summarySchema);
type Summary = z.infer<typeof summarySchema>;
const summariesKey = "selfhostTurnFileSummaries";
const revertedNotices = new WeakMap<Message, Set<string>>();
const maxDiffLength = 2 * 1024 * 1024;

function record(value: unknown): Message {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Message) : {};
}

function parseHunks(diff: string): Hunk[] {
  if (diff.length > maxDiffLength) return [];
  const hunks: Hunk[] = [];
  let hunk: Hunk | undefined;
  for (const line of diff.split("\n")) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (match) {
      hunk = {
        oldStart: Number(match[1]),
        oldLines: Number(match[2] ?? 1),
        newStart: Number(match[3]),
        newLines: Number(match[4] ?? 1),
        lines: [],
      };
      hunks.push(hunk);
    } else if (hunk && /^[ +\-\\]/u.test(line)) hunk.lines.push(line);
  }
  return hunks;
}

function displayPath(cwd: string, path: string) {
  return path.startsWith("/") || !cwd ? path : `${cwd.replace(/\/$/u, "")}/${path}`;
}

function item(path: string, patches: Hunk[], writeCount = 1): Item {
  const lines = patches.flatMap((patch) => patch.lines);
  return {
    path,
    patches,
    writeCount,
    toolNames: ["apply_patch"],
    additions: lines.filter((line) => line.startsWith("+")).length,
    deletions: lines.filter((line) => line.startsWith("-")).length,
  };
}

function literalPatch(text: string, adding: boolean): Hunk[] {
  if (text.length > maxDiffLength) return [];
  const lines = text.replace(/\n$/u, "").split("\n");
  const count = text.length ? lines.length : 0;
  if (!count) return [];
  const marked = lines.map((line) => (adding ? "+" : "-") + line);
  if (!text.endsWith("\n")) marked.push("\\ No newline at end of file");
  return [
    {
      oldStart: adding ? 0 : 1,
      oldLines: adding ? 0 : count,
      newStart: adding ? 1 : 0,
      newLines: adding ? count : 0,
      lines: marked,
    },
  ];
}

function storedItemChanges(turn: Message, cwd: string): Item[] {
  const groups = new Map<string, Item>();
  for (const raw of Array.isArray(turn.items) ? turn.items : []) {
    const native = record(raw);
    if (
      native.type !== "fileChange" ||
      native.status !== "completed" ||
      !Array.isArray(native.changes)
    )
      continue;
    for (const change of native.changes.map(record)) {
      if (typeof change.path !== "string" || !change.path || typeof change.diff !== "string")
        continue;
      const path = displayPath(cwd, change.path);
      const kind = record(change.kind).type;
      const patches =
        kind === "add" || kind === "delete"
          ? literalPatch(change.diff, kind === "add")
          : parseHunks(change.diff);
      const previous = groups.get(path);
      groups.set(
        path,
        item(path, [...(previous?.patches ?? []), ...patches], (previous?.writeCount ?? 0) + 1),
      );
    }
  }
  return [...groups.values()];
}

function cumulativeDiff(diff: string, cwd: string, writes: Item[]): Item[] {
  if (!diff || diff.length > maxDiffLength) return [];
  const counts = new Map(writes.map((row) => [row.path, row.writeCount]));
  return diff
    .split(/(?=^diff --git )/mu)
    .filter(Boolean)
    .flatMap((section) => {
      const metadata = section.split(/^@@ /mu, 1)[0] ?? "";
      const relative =
        /^\+\+\+ b\/(.*)$/mu.exec(metadata)?.[1] ??
        /^--- a\/(.*)$/mu.exec(metadata)?.[1] ??
        /^diff --git a\/(.+) b\/\1$/mu.exec(metadata)?.[1];
      if (!relative) return [];
      const path = displayPath(cwd, relative);
      return [item(path, parseHunks(section), counts.get(path) ?? 1)];
    });
}

function localTurnFileDetails(turn: Message, cwd: string): V4ConversationFileChangesResult {
  // 冷历史只有 fileChange items 时逐次展示补丁，同一条路径只产生一张文件卡。
  const changes = storedItemChanges(turn, cwd);
  const cumulative = cumulativeDiff(typeof turn.diff === "string" ? turn.diff : "", cwd, changes);
  const items = cumulative.length ? cumulative : changes;
  return {
    files: items.length,
    items,
    additions: items.reduce((sum, file) => sum + file.additions, 0),
    deletions: items.reduce((sum, file) => sum + file.deletions, 0),
  };
}

function savedTurnFileSummary(activation: Message, turnId: string): Summary | undefined {
  const summaries = activation[summariesKey] as Record<string, Summary> | undefined;
  return summaries && Object.hasOwn(summaries, turnId) ? summaries[turnId] : undefined;
}

export function turnFileHeader(activation: Message, turn: Message, cwd: string) {
  const saved = typeof turn.id === "string" ? savedTurnFileSummary(activation, turn.id) : undefined;
  const { files, additions, deletions, state } = saved ?? localTurnFileDetails(turn, cwd);
  if (!files) return {};
  return {
    fileChanges: { files, additions, deletions, ...(state ? { state } : {}) },
    ...(saved?.eligible &&
    state !== "reverted" &&
    activation.readOnly !== true &&
    turn.status !== "inProgress"
      ? { actions: { canRewindFiles: true as const } }
      : {}),
  };
}

export function markTurnFilesReverted(activation: Message, turnId: string) {
  if (!turnId) return;
  const notices = revertedNotices.get(activation) ?? new Set<string>();
  notices.add(turnId);
  revertedNotices.set(activation, notices);
  const saved = savedTurnFileSummary(activation, turnId);
  if (saved) saved.state = "reverted";
}

export async function loadTurnFileSummaries(
  gateway: Gateway,
  activation: Message,
  scope: Scope,
  turnIds: string[],
) {
  const { summaries } = await gateway.request(
    "/api/selfhost/turn-files",
    z.object({ summaries: summariesSchema }),
    "POST",
    {
      ...scope,
      operation: "summaries",
      turnIds,
    },
  );
  for (const [id, summary] of Object.entries(summaries)) {
    if (
      revertedNotices.get(activation)?.has(id) ||
      savedTurnFileSummary(activation, id)?.state === "reverted"
    )
      summary.state = "reverted";
  }
  activation[summariesKey] = { ...record(activation[summariesKey]), ...summaries };
  return Object.keys(summaries).length > 0;
}

type Scope = { hostId: number; threadId: string; cwd: string };
const details = z.object({ details: v4ConversationFileChangesResultSchema.nullable() });
const preview = z.object({ preview: v4ConversationFileRewindPreviewResultSchema });
const applied = z.object({
  applied: z.boolean(),
  response: z.string(),
  preview: v4ConversationFileRewindPreviewResultSchema,
});

const readTurnFileDetails = (gateway: Gateway, scope: Scope, turnId: string) =>
  gateway.request("/api/selfhost/turn-files", details, "POST", {
    ...scope,
    operation: "details",
    turnId,
  });
const previewTurnFileRewind = (gateway: Gateway, scope: Scope, turnId: string) =>
  gateway.request("/api/selfhost/turn-files", preview, "POST", {
    ...scope,
    operation: "preview",
    turnId,
  });
const applyTurnFileRewind = (
  gateway: Gateway,
  scope: Scope,
  turnId: string,
  commandId: string,
) =>
  gateway.request("/api/selfhost/turn-files", applied, "POST", {
    ...scope,
    operation: "apply",
    turnId,
    commandId,
  });

type Subscription = {
  session?: string;
  activation?: Message;
  needsActivation: boolean;
  ordinal: number;
};

function turnsFor(activation: Message): Message[] {
  const turns = record(record(activation.history).thread).turns;
  return Array.isArray(turns) ? turns.map(record) : [];
}

export class TurnFileBridge<Sub extends Subscription> {
  constructor(
    private readonly gateway: Gateway,
    private readonly hostId: number,
    private readonly cwd: string,
    private readonly logEpoch: string,
    private readonly subscriptions: () => Iterable<Sub>,
    private readonly project: (sub: Sub, info: Message, session: string) => ConversationSnapshot,
    private readonly publish: (sub: Sub, info: Message) => void,
  ) {}

  async read(params: Message, preview: boolean) {
    const session = typeof params.sessionId === "string" ? params.sessionId : "";
    const { info, row, turn, turnId, rewindAllowed } = this.resolve(session, params);
    const scope = this.scope(session);
    if (preview) {
      if (!rewindAllowed || info.readOnly === true || !row.actions?.canRewindFiles)
        throw Error("会话正在运行或有待处理的请求，完成后可撤销");
      return (await previewTurnFileRewind(this.gateway, scope, turnId)).preview;
    }
    const saved = savedTurnFileSummary(info, turnId);
    const native = saved ? await readTurnFileDetails(this.gateway, scope, turnId) : null;
    const details = native?.details ?? localTurnFileDetails(turn, this.cwd);
    return { ...details, ...(saved?.state ? { state: saved.state } : {}) };
  }

  async apply(command: CommandEnvelope): Promise<CommandAck> {
    const revisionAtDecision = command.baseRevision ?? 0;
    const commandId = command.commandId;
    try {
      const session = command.sessionId ?? "";
      const { info, row, turnId, rewindAllowed } = this.resolve(session, {
        ...command,
        target: record(command.payload).target,
      });
      if (!rewindAllowed || info.readOnly === true || !row.actions?.canRewindFiles)
        throw Error("会话正在运行或有待处理的请求，完成后可撤销");
      const value = await applyTurnFileRewind(this.gateway, this.scope(session), turnId, commandId);
      if (!value.applied)
        return {
          commandId,
          revisionAtDecision,
          status: "failed",
          reasonCode: "codex.turnFilesConflict",
          message: value.response,
          result: { type: "applyFileRewind", ...value },
        };
      for (const candidate of this.subscriptions()) {
        if (candidate.session === session && candidate.activation) {
          markTurnFilesReverted(candidate.activation, turnId);
          this.publish(candidate, candidate.activation);
        }
      }
      return {
        commandId,
        revisionAtDecision,
        status: "accepted",
        result: { type: "applyFileRewind", ...value },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stale = message === "proto.staleRevision" || message === "proto.staleLogEpoch";
      return {
        commandId,
        revisionAtDecision,
        status: stale ? "stale" : "failed",
        reasonCode: stale ? message : "codex.turnFilesFailed",
        message,
      };
    }
  }

  private scope(session: string): Scope {
    return { hostId: this.hostId, threadId: session, cwd: this.cwd };
  }

  private resolve(session: string, params: Message) {
    const path = params.workspacePath ?? record(params.workspace).workspacePath;
    if (typeof path === "string" && path && path !== this.cwd)
      throw Error("fault.subscription.notOwned");
    if (params.baseLogEpoch !== this.logEpoch) throw Error("proto.staleLogEpoch");
    const sub = [...this.subscriptions()].find(
      (candidate) =>
        candidate.session === session &&
        candidate.ordinal === params.baseRevision &&
        !candidate.needsActivation &&
        candidate.activation,
    );
    if (!sub?.activation) throw Error("proto.staleRevision");
    const info = sub.activation;
    const target = conversationRowTargetSchema.parse(params.target);
    const snapshot = this.project(sub, info, session);
    const row = snapshot.rows.window.find(
      (candidate) =>
        candidate.kind === "turnHeader" &&
        candidate.rowId === target.rowId &&
        candidate.entityId === target.entityId,
    );
    const turn = turnsFor(info).find((entry) => entry.id === row?.turnId);
    if (!row || !turn || !row.turnId || row.kind !== "turnHeader")
      throw Error("fault.fileChanges.targetNotFound");
    return {
      info,
      row,
      turn,
      turnId: row.turnId,
      rewindAllowed: snapshot.availability.rewindFiles?.allowed === true,
    };
  }
}
