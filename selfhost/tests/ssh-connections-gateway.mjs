import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import ssh2 from "ssh2";

const entry = process.argv[2];
assert(entry, "Pass the built Gateway .output/server/index.mjs");
const repo = resolve(import.meta.dirname, "../..");
const work = await mkdtemp(join(tmpdir(), "zcode-ssh-check-"));
const password = randomBytes(16).toString("hex");
const keyPath = join(work, "host-key");
const authSockets = new Set();
const heldSockets = new Set();
const watchdog = AbortSignal.timeout(60_000);
let processUnderTest;
let socket;
let ssh;
let held;

async function bind(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening", { signal: watchdog });
  return server.address().port;
}

try {
  const stateDir = join(work, "state");
  const env = {
    ...process.env,
    CODEX_GATEWAY_DB_PATH: join(stateDir, "test.sqlite"),
    CODEX_GATEWAY_CONFIG_SECRET: randomBytes(32).toString("hex"),
  };
  delete env.CODEX_GATEWAY_KNOWN_HOSTS;
  execFileSync(process.execPath, [join(repo, "selfhost/create-user.mjs"), "fixture"], {
    env,
    input: password + "\n",
  });
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath]);
  const [, encoded] = (await readFile(keyPath + ".pub", "utf8")).split(" ");
  const fingerprint =
    "SHA256:" +
    createHash("sha256").update(Buffer.from(encoded, "base64")).digest("base64").replace(/=+$/, "");
  ssh = new ssh2.Server({ hostKeys: [await readFile(keyPath)] }, (client) => {
    authSockets.add(client);
    client.on("error", () => {});
    client.once("close", () => authSockets.delete(client));
    client.on("authentication", (attempt) => {
      if (attempt.username === "interactive") {
        if (attempt.method === "keyboard-interactive")
          attempt.prompt([{ prompt: "Fixture verification code", echo: false }], () =>
            attempt.reject(),
          );
        else attempt.reject(["keyboard-interactive"]);
      } else if (attempt.method === "password" && attempt.password === password) attempt.accept();
      else attempt.reject(["password"]);
    });
    client.on("ready", () => client.on("session", (_accept, reject) => reject()));
  });
  const sshPort = await bind(ssh);
  held = createServer((connection) => {
    heldSockets.add(connection);
    connection.on("error", () => {});
    connection.once("close", () => heldSockets.delete(connection));
    connection.resume();
  });
  const heldPort = await bind(held);
  const reservation = createServer();
  const port = await bind(reservation);
  await new Promise((done) => reservation.close(done));
  const origin = "http://127.0.0.1:" + port;
  processUnderTest = spawn(process.execPath, [resolve(entry)], {
    env: { ...env, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (;;) {
    watchdog.throwIfAborted();
    const health = await fetch(origin + "/api/health").catch(() => null);
    if (health?.ok) break;
    if (processUnderTest.exitCode !== null) throw Error("Gateway exited before health check");
    await delay(50, undefined, { signal: watchdog });
  }

  const probePath = "/api/selfhost/ssh-test";
  assert.equal((await fetch(origin + probePath, { method: "POST" })).status, 401);
  const login = await fetch(origin + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "fixture", password }),
  });
  assert(login.ok, "Gateway login must succeed");
  const { token } = await login.json();
  async function api(path, body, signal = watchdog) {
    const response = await fetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    assert(response.ok, path + " returned " + response.status);
    return response.json();
  }
  const draft = {
    name: "Fixture",
    sshHost: "127.0.0.1",
    username: "fixture",
    port: sshPort,
    hostKeyFingerprint: fingerprint,
    authMode: "password",
    password,
  };
  async function outcome(host, status, hostId) {
    assert.deepEqual(await api(probePath, { hostId, host }), { status });
  }
  await outcome(draft, "connected");
  await outcome({ ...draft, password: "incorrect-fixture-password" }, "authentication");
  await outcome({ ...draft, hostKeyFingerprint: "SHA256:" + "A".repeat(43) }, "hostKey");
  await outcome({ ...draft, username: "interactive" }, "mfaRequired");
  assert.deepEqual(await api("/api/hosts"), []);
  process.stdout.write(
    "PASS real SSH authentication, fingerprint verification and isolated draft tests\n",
  );

  for (const slowHost of [
    { ...draft, port: heldPort },
    { ...draft, proxyUrl: "socks5h://127.0.0.1:" + heldPort },
  ]) {
    const controller = new AbortController();
    const accepted = once(held, "connection", { signal: watchdog });
    const pending = assert.rejects(api(probePath, { host: slowHost }, controller.signal), {
      name: "AbortError",
    });
    const [connection] = await accepted;
    const closed = once(connection, "close", { signal: AbortSignal.timeout(4000) });
    controller.abort();
    await Promise.all([pending, closed]);
  }
  process.stdout.write(
    "PASS canceling direct and SOCKS5 probes closes the server's pending socket\n",
  );

  const configured = await api("/api/hosts", {
    ...draft,
    port: heldPort,
    avatar: "fab fa-docker:#7654c9",
  });
  assert.equal(configured.password, undefined);
  assert.equal(configured.avatar, "fab fa-docker:#7654c9");
  socket = new WebSocket(origin.replace("http:", "ws:") + "/api/realtime");
  function nextMessage(predicate) {
    return new Promise((done, reject) => {
      const stop = () => socket.removeEventListener("message", receive);
      function receive(event) {
        const value = JSON.parse(event.data);
        if (!predicate(value)) return;
        stop();
        watchdog.removeEventListener("abort", cancel);
        done(value);
      }
      function cancel() {
        stop();
        reject(watchdog.reason);
      }
      socket.addEventListener("message", receive);
      watchdog.addEventListener("abort", cancel, { once: true });
    });
  }
  await once(socket, "open", { signal: watchdog });
  const ready = nextMessage((message) => message.type === "ready");
  socket.send(JSON.stringify({ type: "auth.authenticate", token }));
  await ready;
  socket.send(JSON.stringify({ type: "host.lifecycle.subscribe" }));
  const command = (type) => socket.send(JSON.stringify({ type, hostId: configured.id }));
  async function cancelConnection(connection) {
    const canceled = nextMessage(
      (message) =>
        message.type === "host.lifecycle" &&
        message.event.hostId === configured.id &&
        message.event.status === "canceled",
    );
    const closed = once(connection, "close", { signal: AbortSignal.timeout(4000) });
    command("host.mfa.cancel");
    await Promise.all([canceled, closed]);
  }
  const first = [...heldSockets][0] ?? (await once(held, "connection", { signal: watchdog }))[0];
  await cancelConnection(first);
  assert.equal(heldSockets.size, 0);
  const next = once(held, "connection", { signal: watchdog });
  command("host.mfa.connect");
  const [retry] = await next;
  await cancelConnection(retry);
  assert.equal(heldSockets.size, 0);
  const { password: _password, ...edit } = draft;
  await outcome(edit, "connected", configured.id);
  const [saved] = await api("/api/hosts");
  assert.equal(saved.port, heldPort);
  assert.equal(saved.avatar, "fab fa-docker:#7654c9");
  process.stdout.write(
    "PASS saved host cancellation, explicit retry and stored credential reuse\n",
  );
} finally {
  socket?.close();
  if (processUnderTest?.exitCode === null) {
    processUnderTest.kill();
    await once(processUnderTest, "exit");
  }
  for (const client of authSockets) client.end();
  for (const connection of heldSockets) connection.destroy();
  ssh?.close();
  held?.close();
  await rm(work, { recursive: true, force: true });
}
