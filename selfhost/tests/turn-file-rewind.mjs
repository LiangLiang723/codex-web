import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = await realpath(await mkdtemp(join(tmpdir(), "selfhost-turn-files-")));
const cwd = join(root, "worktree");
const home = join(root, "home");
const helper = fileURLToPath(new URL("../worker/turn-file-rewind.py", import.meta.url));
const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
const threadId = "synthetic-thread";
const oid = (text) =>
  text === null
    ? "0".repeat(40)
    : createHash("sha1")
        .update(`blob ${Buffer.byteLength(text)}\0`)
        .update(text)
        .digest("hex");
const file = (path, kind, before, after, diff) => ({
  path,
  before: oid(before),
  after: oid(after),
  kind,
  diff,
  operationCount: 1,
});

function git(...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { env });
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout.toString();
}

function call(operation, turnId, files = [], commandId, workingDirectory = cwd) {
  const result = spawnSync("python3", ["-I", helper], {
    env,
    input: JSON.stringify({ operation, cwd: workingDirectory, threadId, turnId, files, commandId }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

try {
  const metadataCheck = spawnSync(
    "python3",
    [
      "-I",
      "-c",
      `
import runpy, sys
matches = runpy.run_path(sys.argv[1])["same_moved_file"]
original = {"dev":1,"ino":2,"mode":420,"gid":3,"hash":"verified-content","provenance":None}
moved = {**original,"provenance":"01000000"}
assert matches(moved, original) == (sys.platform == "darwin")
for key, change in (("dev",9),("ino",17),("mode",448),("gid",4),("hash","later-edit")):
    assert not matches({**moved,key:change}, original)
assert not matches(original, moved)
`,
      helper,
    ],
    { env, encoding: "utf8" },
  );
  assert.equal(metadataCheck.status, 0, metadataCheck.stderr);
  await mkdir(cwd);
  await mkdir(home);
  git("init", "-q");
  const kept = join(cwd, "updated.txt");
  const added = join(cwd, "added.txt");
  const deleted = join(cwd, "deleted.txt");
  await writeFile(kept, "staged baseline\n");
  await writeFile(deleted, "former text\n");
  git("add", "--", "updated.txt", "deleted.txt");
  const index = await readFile(join(cwd, ".git", "index"));
  await writeFile(kept, "user baseline\nagent edit\n");
  await writeFile(added, "+literal heading\n-second line\n", { mode: 0o644 });
  await rm(deleted);
  const changed = file(
    "updated.txt",
    "update",
    "user baseline\n",
    "user baseline\nagent edit\n",
    "@@ -1 +1,2 @@\n user baseline\n+agent edit\n",
  );
  const normal = [
    changed,
    file(
      "added.txt",
      "add",
      null,
      "+literal heading\n-second line\n",
      "+literal heading\n-second line\n",
    ),
    file("deleted.txt", "delete", "former text\n", null, "former text\n"),
  ];

  const beforePreview = call("apply", "first", normal, "unconfirmed");
  assert.equal(beforePreview.applied, false);
  assert.equal(await readFile(added, "utf8"), "+literal heading\n-second line\n");
  const preview = call("preview", "first", normal);
  assert.equal(preview.canApply, true, JSON.stringify(preview));
  assert.deepEqual(
    preview.safeFiles.map(({ path, action }) => [relative(cwd, path), action]),
    [
      ["updated.txt", "restore"],
      ["added.txt", "delete"],
      ["deleted.txt", "restore"],
    ],
  );
  await writeFile(kept, "user baseline\nagent edit\nexternal continuation\n");
  const conflicted = call("apply", "first", normal, "command-when-changed");
  assert.equal(conflicted.applied, false);
  assert.equal(conflicted.preview.unsafeFiles[0].reason, "external_modified");
  assert.equal(await readFile(added, "utf8"), "+literal heading\n-second line\n");
  await assert.rejects(readFile(deleted), { code: "ENOENT" });
  assert.deepEqual(await readFile(join(cwd, ".git", "index")), index);

  const misleading = {
    ...changed,
    diff: "@@ -1,2 +1,2 @@\n user baseline\n-user unrelated bytes\n+agent edit\n",
  };
  await writeFile(kept, "user baseline\nagent edit\n");
  assert.equal(
    call("preview", "first", [misleading]).unsafeFiles[0].reason,
    "checkpoint_unreadable",
  );
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "updated.txt"), "user baseline\nagent edit\n");
  await symlink(outside, join(cwd, "alias"));
  const aliased = { ...changed, path: "alias/updated.txt" };
  assert.equal(call("preview", "alias", [aliased]).canApply, false);
  assert.equal(await readFile(join(outside, "updated.txt"), "utf8"), "user baseline\nagent edit\n");

  // macOS 的 /tmp 与 /private/tmp 通过不同路径名到达同一原生目录。
  const parentAlias = join(root, "workspaces");
  await symlink(root, parentAlias);
  const applied = call(
    "apply",
    "first",
    normal,
    "successful-command",
    join(parentAlias, "worktree"),
  );
  assert.equal(applied.applied, true);
  assert.equal(await readFile(kept, "utf8"), "user baseline\n");
  await assert.rejects(readFile(added), { code: "ENOENT" });
  assert.equal(await readFile(deleted, "utf8"), "former text\n");
  assert.deepEqual(await readFile(join(cwd, ".git", "index")), index);
  await writeFile(kept, "later edit after completed rewind\n");
  assert.deepEqual(call("apply", "first", normal, "successful-command"), applied);
  assert.deepEqual(call("states", "first"), { reverted: ["first"] });
  assert.equal(await readFile(kept, "utf8"), "later edit after completed rewind\n");

  // Persist the exact midway state of an interrupted helper after its first rename/link pair.
  const parent = await stat(cwd);
  const journal = join(home, ".zcode-selfhost-turn-rewind", `${parent.dev}-${parent.ino}`);
  const crashName = "interrupted.txt";
  const crashPath = join(cwd, crashName);
  const stage = ".zcode-rewind-0123456789abcdef01234567-0";
  const side = join(cwd, stage);
  const crashBefore = "previous\n";
  const crashAfter = "agent edit\n";
  await mkdir(side, { mode: 0o700 });
  await writeFile(crashPath, crashAfter);
  await writeFile(join(side, "new"), crashBefore);
  const fingerprint = async (path, content) => {
    const meta = await stat(path);
    const provenance =
      process.platform === "darwin"
        ? spawnSync("xattr", ["-px", "com.apple.provenance", path], { encoding: "utf8" })
            .stdout.replace(/\s+/gu, "")
            .toLowerCase()
        : "";
    return {
      dev: meta.dev,
      ino: meta.ino,
      mode: meta.mode & 0o777,
      gid: meta.gid,
      hash: oid(content),
      provenance: provenance || null,
    };
  };
  const crashStep = {
    path: crashName,
    stage,
    parent: [parent.dev, parent.ino],
    current: await fingerprint(crashPath, crashAfter),
    installed: await fingerprint(join(side, "new"), crashBefore),
  };
  await rename(crashPath, join(side, "original"));
  await link(join(side, "new"), crashPath);
  await writeFile(
    join(journal, "pending.json"),
    JSON.stringify({
      phase: "moving",
      threadId,
      turnId: "interrupted",
      commandId: "dropped-ack",
      steps: [crashStep],
    }),
  );
  await mkdir(join(journal, "lock"), { mode: 0o700 });
  await writeFile(join(journal, "lock", "2147483647-0123456789abcdef01234567.owner"), "");
  const crash = file(
    crashName,
    "update",
    crashBefore,
    crashAfter,
    "@@ -1 +1 @@\n-previous\n+agent edit\n",
  );
  assert.equal(call("preview", "interrupted", [crash]).canApply, true);
  assert.equal(await readFile(crashPath, "utf8"), crashAfter);
  await assert.rejects(stat(side), { code: "ENOENT" });
  await assert.rejects(stat(join(journal, "pending.json")), { code: "ENOENT" });
  assert.deepEqual(await readFile(join(cwd, ".git", "index")), index);
  console.log(
    "PASS isolated SSH worker preview, all-file conflict, exact undo, Git index, interrupted recovery and durable retry",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
