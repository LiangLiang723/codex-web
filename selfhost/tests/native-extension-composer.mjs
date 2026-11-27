import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { build } from "esbuild";
import {
  nativeUserInputItems,
  restoreNativeTurnText,
} from "../../packages/web/src/selfhost/nativeTurnInput.ts";

const binary = process.env.SELFHOST_COMPOSER_CODEX_BIN ?? "codex";
const fixtureHome = await realpath(await mkdtemp(join(tmpdir(), "selfhost-native-composer-")));
const codexHome = join(fixtureHome, ".codex");
const cwd = join(fixtureHome, "workspace");
const skillName = "fixture-review";
const repoSkill = join(cwd, ".agents/skills/review (workspace)/SKILL.md");
const repoPhrase = "COMPOSER_FIXTURE_REPO_INSTRUCTIONS_5B5D24";
const pluginPhrase = "COMPOSER_FIXTURE_PLUGIN_INSTRUCTIONS_E9F207";
const pluginName = "fixture-audit";
const marketplace = "composer-fixture";
const pluginId = `${pluginName}@${marketplace}`;
const app = { type: "mention", name: "Fixture App", path: "app://fixture_app" };
const instructionPhrase = "CODEX_NATIVE_INSTRUCTION_FIXTURE_2A93FE";
const originalPrompt = "Fixture turn to steer";
const steerPrompt = "Change the fixture plan in this turn";
const steerClientId = "fixture-same-turn-input";
const initialModelRequest = Promise.withResolvers();
const releaseModelRequest = Promise.withResolvers();
const env = {
  HOME: fixtureHome,
  CODEX_HOME: codexHome,
  PATH: process.env.PATH,
  LANG: "en_US.UTF-8",
  SELFHOST_COMPOSER_FIXTURE_KEY: "fixture-only",
};

const requests = [];
let heldOriginalRequest = false;
const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/responses") {
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks));
  requests.push(payload);
  const id = `response_${requests.length}`;
  const message = {
    type: "message",
    id: `message_${requests.length}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Fixture response", annotations: [] }],
  };
  const initialSteerStep =
    !heldOriginalRequest && JSON.stringify(payload.input).includes(originalPrompt);
  if (initialSteerStep) {
    heldOriginalRequest = true;
    initialModelRequest.resolve(payload);
    await releaseModelRequest.promise;
  }
  const item = initialSteerStep
    ? {
        type: "function_call",
        id: "fixture-tool-item",
        call_id: "fixture-tool-call",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "printf fixture" }),
        status: "completed",
      }
    : message;
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { id, model: "gpt-5" } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id, status: "completed", output: [item] } },
  ]) {
    response.write("data: " + JSON.stringify(event) + "\n\n");
  }
  response.end();
});

let child;

async function startAppServer() {
  child = spawn(binary, ["app-server"], { cwd, env, stdio: ["pipe", "pipe", "inherit"] });
  const appServer = child;
  const pending = new Map();
  const completed = new Map();
  const started = [];
  const deleted = new Set();
  let nextId = 0;
  const lines = createInterface({ input: appServer.stdout });
  lines.on("line", (line) => {
    const value = JSON.parse(line);
    pending.get(value.id)?.(value);
    if (value.method === "turn/started") started.push(value.params);
    if (value.method === "turn/completed") {
      completed.set(value.params.turn.id, value.params.turn);
      lines.emit("turnCompleted", value.params.turn);
    }
    if (value.method === "thread/deleted") {
      deleted.add(value.params.threadId);
      lines.emit("threadDeleted");
    }
  });
  const rpc = (method, params) => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`App Server timed out on ${method}`));
      }, 15000);
      pending.set(id, (value) => {
        pending.delete(id);
        clearTimeout(timer);
        if (value.error) reject(new Error(`${method}: ${value.error.message}`));
        else resolve(value.result);
      });
      appServer.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  };
  await once(appServer, "spawn");
  const info = await rpc("initialize", {
    clientInfo: { name: "fixture", title: "Selfhost native composer", version: "1" },
    capabilities: { experimentalApi: true },
  });
  assert.equal(info.codexHome, codexHome);
  appServer.stdin.write('{"method":"initialized"}\n');

  return {
    rpc,
    started,
    version: info.userAgent.split(" ")[0],
    async waitForDeletion(threadId) {
      const signal = AbortSignal.timeout(15000);
      while (!deleted.has(threadId)) await once(lines, "threadDeleted", { signal });
    },
    async waitForTurn(turnId) {
      const signal = AbortSignal.timeout(15000);
      while (!completed.has(turnId)) await once(lines, "turnCompleted", { signal });
      return completed.get(turnId);
    },
  };
}

async function stopAppServer() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  child.kill();
  await closed;
}

async function writeFixture(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function writeNativeInstructions() {
  const bundlePath = join(fixtureHome, "user-instructions.mjs");
  await build({
    entryPoints: [resolve(import.meta.dirname, "../worker/user-instructions.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: bundlePath,
  });
  const call = async (method, ...args) => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { userInstructions } from ${JSON.stringify(bundlePath)};
      const [method, args] = JSON.parse(process.argv[1]);
      console.log(JSON.stringify(await userInstructions[method](...args)));
    `,
        JSON.stringify([method, args]),
      ],
      { env },
    );
    return JSON.parse(stdout);
  };
  const initial = await call("get");
  assert.deepEqual(initial, { content: "", filePath: join(codexHome, "AGENTS.md") });
  await call("save", "Base instructions", initial);
  const override = join(codexHome, "AGENTS.override.md");
  await writeFixture(override, "Old override instructions");
  const active = await call("get");
  assert.equal(active.filePath, override);
  await call("save", instructionPhrase, active);
  await assert.rejects(call("save", "Stale alternate instructions", active), /Codex 指令已变化/);
  assert.equal((await call("get")).content, instructionPhrase);
}

const skillDocument = (phrase) =>
  `---\nname: ${skillName}\ndescription: A skill for checking the composer's explicit selection.\n---\n${phrase}\n`;

try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  await writeFixture(
    join(codexHome, "config.toml"),
    `
model = "gpt-5"
model_provider = "composer-test"
approval_policy = "never"
sandbox_mode = "read-only"
check_for_update_on_startup = false
chatgpt_base_url = "${origin}"
[model_providers.composer-test]
name = "Selfhost composer fixture"
base_url = "${origin}/v1"
wire_api = "responses"
env_key = "SELFHOST_COMPOSER_FIXTURE_KEY"
request_max_retries = 0
stream_max_retries = 0
[projects.${JSON.stringify(cwd)}]
trust_level = "trusted"
`,
  );
  await writeFixture(repoSkill, skillDocument(repoPhrase));
  const marketRoot = join(fixtureHome, "local-market");
  const pluginRoot = join(marketRoot, "plugins", pluginName);
  await writeFixture(
    join(marketRoot, ".agents/plugins/marketplace.json"),
    JSON.stringify({
      name: marketplace,
      plugins: [{ name: pluginName, source: { source: "local", path: `./plugins/${pluginName}` } }],
    }),
  );
  await writeFixture(
    join(pluginRoot, ".codex-plugin/plugin.json"),
    JSON.stringify({
      name: pluginName,
      description: "Composer fixture plugin",
      version: "1.0.0",
      skills: "./skills",
    }),
  );
  await writeFixture(join(pluginRoot, "skills/review/SKILL.md"), skillDocument(pluginPhrase));
  const run = (args) => promisify(execFile)(binary, args, { cwd, env, timeout: 30000 });
  await run(["plugin", "marketplace", "add", "--json", "--", marketRoot]);
  await run(["plugin", "add", "--json", "--", pluginId]);

  await writeNativeInstructions();
  const active = await startAppServer();
  const installed = await active.rpc("plugin/installed", { cwds: [cwd] });
  assert(
    installed.marketplaces
      .flatMap((group) => group.plugins)
      .some((plugin) => plugin.id === pluginId && plugin.installed && plugin.enabled),
  );
  const { data } = await active.rpc("skills/list", { cwds: [cwd], forceReload: true });
  const candidates = data[0].skills.filter((skill) => skill.enabled);
  const workspaceSkill = candidates.find((skill) => skill.path === repoSkill);
  const pluginSkill = candidates.find((skill) => skill.pluginId === pluginId);
  assert.equal(workspaceSkill?.name, skillName);
  assert.equal(pluginSkill?.name, `${pluginName}:${skillName}`);

  const sent = [];
  for (const [selected, phrase, siblingPhrase] of [
    [workspaceSkill, repoPhrase, pluginPhrase],
    [pluginSkill, pluginPhrase, repoPhrase],
  ]) {
    const { thread } = await active.rpc("thread/start", { cwd });
    const text = `验证🧪 [$${selected.name}](<${selected.path}>) [@${pluginName}](plugin://${pluginId}) [$Fixture App](${app.path})`;
    const input = nativeUserInputItems({ text });
    assert.deepEqual(input.slice(1), [
      { type: "skill", name: selected.name, path: selected.path },
      { type: "mention", name: pluginName, path: `plugin://${pluginId}` },
      app,
    ]);
    const requestCount = requests.length;
    const { turn } = await active.rpc("turn/start", { threadId: thread.id, input });
    const completed = await active.waitForTurn(turn.id);
    assert.equal(completed.status, "completed", JSON.stringify(completed.error));
    const prompts = requests.slice(requestCount).map((request) => JSON.stringify(request.input));
    assert(prompts.some((prompt) => prompt.includes(input[0].text) && prompt.includes(phrase)));
    assert(prompts.every((prompt) => !prompt.includes(siblingPhrase)));
    assert(prompts.some((prompt) => prompt.includes(instructionPhrase)));
    sent.push({ threadId: thread.id, turnId: turn.id, text, input });
  }

  const { thread: steeredThread } = await active.rpc("thread/start", { cwd });
  const { turn: steeredTurn } = await active.rpc("turn/start", {
    threadId: steeredThread.id,
    input: nativeUserInputItems({ text: originalPrompt }),
  });
  const input = nativeUserInputItems({ text: steerPrompt });
  const signal = AbortSignal.timeout(15000);
  const request = await Promise.race([
    initialModelRequest.promise,
    once(signal, "abort").then(() => {
      throw signal.reason;
    }),
  ]);
  assert.ok(
    request.tools.some(({ name }) => name === "exec_command"),
    JSON.stringify(request.tools.map(({ name }) => name)),
  );
  await assert.rejects(
    active.rpc("turn/steer", {
      threadId: steeredThread.id,
      expectedTurnId: "stale-turn",
      input,
    }),
    /expected active turn id/iu,
  );
  const steered = await active.rpc("turn/steer", {
    threadId: steeredThread.id,
    expectedTurnId: steeredTurn.id,
    clientUserMessageId: steerClientId,
    input,
  });
  assert.equal(steered.turnId, steeredTurn.id);
  releaseModelRequest.resolve();
  const completed = await active.waitForTurn(steeredTurn.id);
  assert.equal(completed.status, "completed", JSON.stringify(completed.error));
  assert.deepEqual(
    active.started
      .filter(({ threadId }) => threadId === steeredThread.id)
      .map(({ turn }) => turn.id),
    [steeredTurn.id],
  );
  assert.ok(requests.some(({ input }) => JSON.stringify(input).includes(steerPrompt)));

  await stopAppServer();
  const reopened = await startAppServer();
  const { data: steeredHistory } = await reopened.rpc("thread/turns/list", {
    threadId: steeredThread.id,
    limit: 5,
    itemsView: "full",
  });
  const restoredSteer = steeredHistory
    .find(({ id }) => id === steeredTurn.id)
    ?.items.find((item) => item.type === "userMessage" && item.clientId === steerClientId);
  assert.deepEqual(restoredSteer?.content, input);
  console.log(
    `PASS native steer ${active.version}: stale target, same active turn, model input and cold history`,
  );
  for (const { threadId, turnId, text, input } of sent) {
    const { thread } = await reopened.rpc("thread/read", { threadId, includeTurns: true });
    const { data: turns } = await reopened.rpc("thread/turns/list", { threadId, limit: 5 });
    for (const history of [thread.turns, turns]) {
      const content = history
        .find((turn) => turn.id === turnId)
        ?.items.find((item) => item.type === "userMessage")?.content;
      assert.deepEqual(content, input);
      assert.equal(restoreNativeTurnText(content), text);
    }
  }
  console.log(
    `PASS native composer ${active.version}: skills, plugin, app mention, user instructions and cold history`,
  );
  const [archived, other] = sent.map(({ threadId }) => threadId);
  await reopened.rpc("thread/archive", { threadId: archived });
  assert.equal((await reopened.rpc("thread/read", { threadId: archived })).thread.id, archived);
  await reopened.rpc("thread/delete", { threadId: archived });
  await reopened.waitForDeletion(archived);
  await assert.rejects(
    reopened.rpc("thread/read", { threadId: archived }),
    /no rollout found|not found|does not exist|thread not loaded/i,
  );
  const archivedList = await reopened.rpc("thread/list", { archived: true, modelProviders: [] });
  assert(!archivedList.data.some(({ id }) => id === archived));
  assert.equal((await reopened.rpc("thread/read", { threadId: other })).thread.id, other);
  await reopened.rpc("thread/delete", { threadId: other });
  await reopened.waitForDeletion(other);
  await stopAppServer();
  const afterDeletion = await startAppServer();
  for (const threadId of [archived, other]) {
    await assert.rejects(
      afterDeletion.rpc("thread/read", { threadId }),
      /no rollout found|not found|does not exist|thread not loaded/i,
    );
  }
  console.log(
    `PASS native thread/delete ${reopened.version}: archived and active files, notifications, cold read`,
  );
} finally {
  releaseModelRequest.resolve();
  await stopAppServer();
  if (server.listening) {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  }
  await rm(fixtureHome, { recursive: true, force: true });
}
