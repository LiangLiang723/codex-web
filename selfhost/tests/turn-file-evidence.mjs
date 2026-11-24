import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const repo = resolve(import.meta.dirname, "../..");
const stage = await mkdtemp(join(tmpdir(), "selfhost-file-evidence-"));
const cwd = "/fixture/workspace";
const nativeTurnId = "native-turn";
const remoteKey = "verified-remote-fixture";
const oldText = "unchanged line\nstaged separately\n";
const newText = "unchanged line\nagent modification\n";
const path = "filename has spaces.txt";
const oid = (text) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest("hex");
const toolPatch = "@@ -1,2 +1,2 @@\n unchanged line\n-staged separately\n+agent modification\n";
const aggregate = `diff --git a/${path} b/${path}\nindex ${oid(oldText)}..${oid(newText)}\n--- a/${path}\n+++ b/${path}\n${toolPatch}`;

try {
  const gateway = join(stage, "gateway");
  execFileSync("python3", [join(repo, "selfhost/gateway/materialize.py"), gateway]);
  const out = join(stage, "evidence.mjs");
  await build({
    entryPoints: [join(gateway, "server/utils/selfhost-turn-files.ts")],
    outfile: out,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    alias: { "~~": gateway },
    nodePaths: [join(repo, "node_modules")],
  });
  process.env.CODEX_GATEWAY_DB_PATH = join(stage, "fixture.sqlite");
  const { captureTurnFiles, readTurnFileSummary, readTurnFileEvidence, verifiedTurnDirectories } =
    await import(pathToFileURL(out));

  function emit(threadId, event) {
    captureTurnFiles(remoteKey, threadId, event, cwd);
  }
  function start(thread) {
    emit(thread, { type: "turn.started", turn: { id: nativeTurnId } });
  }
  function patch(thread, id, status) {
    emit(thread, {
      type: "timeline.item.upsert",
      item: {
        id,
        turnId: nativeTurnId,
        type: "fileChange",
        status,
        changes: [
          { path: `${cwd}/${path}`, kind: { type: "update", movePath: null }, diff: toolPatch },
        ],
      },
    });
  }
  function finish(thread) {
    emit(thread, { type: "turn.completed", turn: { id: nativeTurnId } });
  }
  function diff(thread, value = aggregate) {
    emit(thread, { type: "turn.diff.updated", turnId: nativeTurnId, diff: value });
  }

  start("successful");
  patch("successful", "one", "inProgress");
  patch("successful", "one", "completed");
  diff("successful");
  finish("successful");
  assert.deepEqual(readTurnFileSummary(remoteKey, "successful", nativeTurnId, cwd), {
    files: 1,
    additions: 1,
    deletions: 1,
  });
  assert.equal(
    readTurnFileEvidence(remoteKey, "successful", nativeTurnId, cwd).details.items[0].patches[0]
      .lines[2],
    "+agent modification",
  );
  assert.deepEqual(readTurnFileEvidence(remoteKey, "successful", nativeTurnId, cwd).files, [
    {
      path,
      operationCount: 1,
      before: oid(oldText),
      after: oid(newText),
      kind: "update",
      diff: toolPatch,
    },
  ]);
  const aliases = await verifiedTurnDirectories(
    remoteKey,
    "successful",
    [nativeTurnId],
    async (path) => path === cwd,
  );
  assert.equal(aliases.get(nativeTurnId), cwd);
  assert.equal(
    (await verifiedTurnDirectories(remoteKey, "successful", [nativeTurnId], async () => false))
      .size,
    0,
  );
  assert.equal(readTurnFileSummary("another-remote", "successful", nativeTurnId, cwd), null);
  assert.equal(
    readTurnFileEvidence(remoteKey, "successful", nativeTurnId, "/other-workspace"),
    null,
  );

  start("twice");
  patch("twice", "one", "completed");
  patch("twice", "two", "completed");
  diff("twice");
  finish("twice");
  assert.equal(
    readTurnFileEvidence(remoteKey, "twice", nativeTurnId, cwd).files[0].reason,
    "unsupported_checkpoint",
  );
  start("invalidated");
  patch("invalidated", "one", "completed");
  diff("invalidated");
  diff("invalidated", "");
  finish("invalidated");
  assert.equal(readTurnFileEvidence(remoteKey, "invalidated", nativeTurnId, cwd), null);
  console.log(
    "PASS materialized Gateway captures only bounded, same-turn native evidence with exact file counts",
  );
} finally {
  await rm(stage, { recursive: true, force: true });
}
