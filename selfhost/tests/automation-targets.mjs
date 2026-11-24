import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const tmp = await mkdtemp(join(tmpdir(), "selfhost-schedule-"));
const moduleFile = join(tmp, "gateway.cjs");
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1)");
let host = { id: 1, sshHost: "a", username: "qa", createdAt: "first" };
const calls = [];
const mocks = new Map([
  ["./gateway/storage/database", "exports.gatewayDatabase=()=>globalThis.qaDb;"],
  [
    "./gateway/storage/crypto",
    "exports.encryptJson=JSON.stringify; exports.decryptJson=JSON.parse;",
  ],
  [
    "./gateway/state/hosts",
    "exports.hostStore={get:()=>globalThis.qaHost(),getWithSecret:()=>globalThis.qaHost()};",
  ],
  ["./gateway/http/errors", "exports.ensureUserConfigLoaded=()=>{};"],
  ["./gateway/state/memory", "exports.runWithGatewayUser=(u,f)=>f();"],
  ["./gateway/runtime/broker", "exports.threadBroker=globalThis.qaBroker;"],
  ["./selfhost-workspace", "exports.callWorkspace=async(h,r)=>r.args[0].path;"],
  [
    "~~/shared/utils/workspace",
    "exports.remoteHostIdentity=h=>JSON.stringify([h.sshHost,h.username,h.port??22,h.hostKeyFingerprint??null,h.proxyUrl]);",
  ],
]);
globalThis.qaDb = db;
globalThis.qaHost = () => host;
globalThis.qaBroker = {
  startThread: async (h, p) => {
    calls.push([h.sshHost, p.cwd]);
    return { thread: { id: "qa-thread" } };
  },
  startTurn: async (h, id, p) => {
    calls.push([h.sshHost, p.cwd]);
    return { turn: { id: "qa-turn" } };
  },
};
try {
  process.env.SELFHOST_ASSET_DIR = tmp;
  await writeFile(
    join(tmp, "organization.cjs"),
    "exports.computeInitialAutomationNextRunAt=()=>Date.now()-1; exports.computeAutomationNextRunAt=()=>Date.now()+60000;",
  );
  await build({
    entryPoints: [
      resolve(import.meta.dirname, "../gateway/overlay/utils/selfhost-organization.ts"),
    ],
    outfile: moduleFile,
    bundle: true,
    platform: "node",
    format: "cjs",
    define: { "import.meta.url": JSON.stringify(pathToFileURL(moduleFile).href) },
    plugins: [
      {
        name: "mock-target-host",
        setup(b) {
          b.onResolve({ filter: /.*/ }, (a) =>
            mocks.has(a.path) ? { path: a.path, namespace: "qa" } : undefined,
          );
          b.onLoad({ filter: /.*/, namespace: "qa" }, (a) => ({
            contents: mocks.get(a.path),
            loader: "js",
          }));
        },
      },
    ],
  });
  const { automations, runDueAutomations } = createRequire(import.meta.url)(moduleFile);
  const task = await automations(1, 1, "/A", "createAutomation", [
    { title: "qa", prompt: "qa", cronExpr: "* * * * *", workspacePath: "/B" },
  ]);
  assert.equal(task.workspacePath, "/B");
  await automations(1, 1, "/A", "runAutomationNow", [{ automationId: task.automationId }]);
  assert.deepEqual(calls, [
    ["a", "/B"],
    ["a", "/B"],
  ]);
  host = { ...host, sshHost: "replacement", createdAt: "second" };
  await runDueAutomations();
  assert.equal(calls.length, 2);
  const [paused] = await automations(1, 1, "/A", "listAllAutomations", []);
  assert.equal(paused.enabled, false);
  await assert.rejects(
    automations(1, 1, "/A", "runAutomationNow", [{ automationId: task.automationId }]),
  );
  await automations(1, 1, "/A", "setAutomationEnabled", [
    { automationId: task.automationId, enabled: true },
  ]);
  await automations(1, 1, "/B", "runAutomationNow", [{ automationId: task.automationId }]);
  assert.deepEqual(calls.slice(-2), [
    ["replacement", "/B"],
    ["replacement", "/B"],
  ]);
  console.log("PASS selected automation directory, replaced host suspension and explicit rebind");
} finally {
  db.close();
  await rm(tmp, { recursive: true, force: true });
}
