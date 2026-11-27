import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const entry = process.argv[2];
assert(entry, "Pass the built Gateway .output/server/index.mjs");
const workspace = await mkdtemp(join(tmpdir(), "codex-web-account-state-db-"));
const path = join(workspace, "fixture.db");
const fixturePassword = randomBytes(24).toString("hex");
const env = {
  ...process.env,
  CODEX_GATEWAY_DB_PATH: path,
  CODEX_GATEWAY_CONFIG_SECRET: randomBytes(32).toString("hex"),
};
const allocator = createServer();
allocator.listen(0, "127.0.0.1");
await once(allocator, "listening");
const port = allocator.address().port;
await new Promise((done) => allocator.close(done));
const origin = "http://127.0.0.1:" + port;
const route = "/api/selfhost/browser-state";
const guard = AbortSignal.timeout(50_000);
let gateway;

async function start() {
  gateway = spawn(process.execPath, [resolve(entry)], {
    env: { ...env, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (;;) {
    guard.throwIfAborted();
    if (gateway.exitCode !== null) throw new Error("Gateway exited before readback");
    if ((await fetch(origin + "/api/health", { signal: guard }).catch(() => null))?.ok) return;
    await delay(35, undefined, { signal: guard });
  }
}

async function stop() {
  if (!gateway || gateway.exitCode !== null || gateway.signalCode !== null) return;
  const closed = once(gateway, "exit");
  gateway.kill();
  await closed;
}

async function api(endpoint, token, method = "GET", data) {
  const request = {
    method,
    headers: new Headers(token ? { Authorization: `Bearer ${token}` } : {}),
    signal: guard,
  };
  if (method !== "GET" && data !== undefined) {
    request.headers.set("Content-Type", "application/json");
    request.body = JSON.stringify(data);
  }
  return fetch(origin + endpoint, request);
}

async function login(username, password) {
  const response = await api("/api/auth/login", null, "POST", { username, password });
  assert.equal(response.status, 200);
  return (await response.json()).token;
}

async function read(token) {
  const response = await api(route, token);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json();
}

async function write(token, changes, importLegacy = false) {
  const response = await api(route, token, "PATCH", { changes, importLegacy });
  assert.equal(response.status, 200);
  return response.json();
}

try {
  const setup = resolve(import.meta.dirname, "../create-user.mjs");
  for (const username of ["first-fixture", "other-fixture"]) {
    const child = execFile(process.execPath, [setup, username], { env });
    child.stdin.end(fixturePassword + "\n");
    assert.deepEqual(await once(child, "exit"), [0, null]);
  }
  await start();
  assert.equal((await api(route, null)).status, 401);
  assert.equal((await api(route, null, "PATCH", { changes: [] })).status, 401);
  const first = await login("first-fixture", fixturePassword);
  const otherSession = await login("first-fixture", fixturePassword);
  const otherUser = await login("other-fixture", fixturePassword);
  const theme = "zcode-theme", pet = "codex-web:conversation-pet-preferences", client = "zcode-v4-client-id:v1";
  assert.deepEqual(await read(first), {});
  await Promise.all([write(first, [[theme, "zai-light"]]), write(otherSession, [[pet, "fixture"]])]);
  await write(first, [[client, "client-one"]]);
  assert.deepEqual(await read(first), { [theme]: "zai-light", [pet]: "fixture", [client]: "client-one" });
  assert.deepEqual(await read(otherSession), { [theme]: "zai-light", [pet]: "fixture" });
  assert.deepEqual(await read(otherUser), {});

  await write(first, [[pet, null]]);
  const imported = await write(first, [
    [theme, "zai-dark"], [pet, "old"], ["zcode-locale-preference", "ko-KR"],
  ], true);
  assert.equal(imported[theme], "zai-light");
  assert.equal(imported[pet], undefined);
  assert.equal(imported["zcode-locale-preference"], "ko-KR");
  const settings = await (await api("/api/selfhost/settings", first)).json();
  assert.equal(settings.localePreference, "ko-KR");
  assert.equal((await api(route, first, "PATCH", { changes: [["selfhost.auth", "fixture"]] })).status, 400);

  await stop();
  await start();
  assert.deepEqual(await read(first), imported);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT encrypted_value FROM zcode_browser_state WHERE key=?").get(theme);
    assert.match(row.encrypted_value, /^v1\$/u);
    assert.ok(!row.encrypted_value.includes("zai-light"));
  } finally {
    db.close();
  }
  assert.equal((await api("/api/auth/logout", first, "POST")).status, 200);
  assert.equal((await api(route, first)).status, 401);
  assert.equal((await read(otherSession))[theme], "zai-light");
  console.log("SQLite account state migration, tombstones, session scoping, encryption and restart passed");
} finally {
  await stop();
  await rm(workspace, { recursive: true, force: true });
}
