import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const repo = resolve(import.meta.dirname, "../..");
const work = await mkdtemp(join(tmpdir(), "zcode-delivery-check-"));
const source = join(work, "gateway");
const dbFile = join(work, "receipts.sqlite");
let db;
try {
  execFileSync("python3", [join(repo, "selfhost/gateway/materialize.py"), source]);
  db = new DatabaseSync(dbFile);
  db.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES (1)",
  );
  const responses = { history: [], queue: [], legacy: false, oldTurns: [] };
  globalThis.deliveryFixture = {
    db,
    client: {
      async request(method, _params, _timeout, parse) {
        if (method === "thread/read")
          return parse({
            thread: {
              id: _params.threadId,
              historyMode: responses.legacy ? "legacy" : "paginated",
            },
          });
        if (method === "thread/turns/list")
          return parse({ data: responses.oldTurns, nextCursor: null, backwardsCursor: null });
        if (method === "thread/timeline/list" && !responses.legacy)
          return parse({
            data: responses.history,
            nextCursor: null,
            activeRealtimeSessionAtPageStart: null,
          });
        if (method === "thread/queue/list")
          return parse({ data: responses.queue, nextCursor: null });
        throw Error(`Unexpected recovery method ${method}`);
      },
    },
  };
  const mocks = {
    memory:
      "export const currentGatewayUserId = () => 1; export const runWithGatewayUser = (_, fn) => fn();",
    hosts: "export const hostStore = {};",
    errors: `export class CodexRpcError extends Error {
      constructor(rpcMethod, rpcCode, message, rpcData) {
        super(message);
        Object.assign(this, { rpcMethod, rpcCode, rpcData });
      }
    }`,
    database: "export const gatewayDatabase = () => globalThis.deliveryFixture.db;",
    broker:
      "export const threadBroker = { getHostClient: async () => globalThis.deliveryFixture.client };",
  };
  const { outputFiles } = await build({
    stdin: {
      resolveDir: source,
      contents: `
        export { createNativeDeliveryThread, recordNativeDelivery, queryNativeDelivery }
          from './server/utils/selfhost-delivery';
        export { remoteHosts } from './server/utils/gateway/state/remote-hosts';
        export { CodexRpcError } from './server/utils/gateway/http/errors';
      `,
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    alias: { "~~": source },
    nodePaths: [join(repo, "node_modules")],
    plugins: [
      {
        name: "delivery-fixture",
        setup(plugin) {
          plugin.onResolve({ filter: /.*/ }, ({ path }) => {
            const name = path.split("/").at(-1);
            if (Object.hasOwn(mocks, name)) return { path: name, namespace: "delivery-fixture" };
          });
          plugin.onLoad({ filter: /.*/, namespace: "delivery-fixture" }, ({ path }) => ({
            contents: mocks[path],
            loader: "js",
          }));
        },
      },
    ],
  });
  const gateway = await import(
    "data:text/javascript;base64," + Buffer.from(outputFiles[0].contents).toString("base64")
  );
  const host = { id: 1, name: "fixture" };
  const cwd = "/delivery-fixture";
  const threadId = randomUUID();
  const commandId = randomUUID();
  gateway.remoteHosts.bind(host, "physical-key:epoch-1", {}, "physical-key");
  const start = await gateway.createNativeDeliveryThread(
    host,
    cwd,
    commandId,
    true,
    async (bind) => {
      bind(threadId);
      throw Error("subscription closed after native creation");
    },
  );
  assert.equal(start.threadId, threadId);
  assert.equal(start.state, "created");

  db.close();
  db = new DatabaseSync(dbFile);
  globalThis.deliveryFixture.db = db;
  gateway.remoteHosts.bind(host, "physical-key:epoch-2", {}, "physical-key");
  assert.equal(gateway.remoteHosts.key(host.id), "physical-key:epoch-2");
  let extraStarts = 0;
  const same = await gateway.createNativeDeliveryThread(host, cwd, commandId, true, async () => {
    extraStarts++;
  });
  assert.equal(same.threadId, threadId);
  const remoteWrite = async () => {
    throw Error("native turn reply lost after transmission");
  };
  const result = await gateway.recordNativeDelivery(
    host,
    threadId,
    commandId,
    "startNow",
    remoteWrite,
  );
  assert.equal(result.state, "pending");
  const lookup = [{ sessionId: null, commandId }];
  const [unconfirmed] = await gateway.queryNativeDelivery(host, cwd, lookup);
  assert.equal(unconfirmed.state, "pending");
  let repeatedWrites = 0;
  const [pending, alsoPending] = await Promise.all(
    [1, 2].map(() =>
      gateway.recordNativeDelivery(host, threadId, commandId, "startNow", async () => {
        repeatedWrites++;
        return null;
      }),
    ),
  );
  assert.equal(pending.state, "pending");
  assert.equal(alsoPending.state, "pending");
  assert.equal(repeatedWrites, 0);

  responses.history = [
    {
      type: "item",
      position: 1,
      turnId: "first-turn",
      item: {
        type: "userMessage",
        id: "native-user-item",
        clientId: commandId,
        content: [{ type: "text", text: "fixture" }],
      },
    },
  ];
  const [accepted] = await gateway.queryNativeDelivery(host, cwd, lookup);
  assert.equal(accepted.state, "accepted");
  assert.equal(accepted.turnId, "first-turn");
  const oldCommand = randomUUID();
  responses.legacy = true;
  await gateway.recordNativeDelivery(host, threadId, oldCommand, "startNow", async () => {
    throw Error("reply lost");
  });
  responses.oldTurns = [
    {
      id: "old-turn",
      rootTurnId: null,
      status: "completed",
      items: [{ type: "userMessage", id: "user-old", clientId: oldCommand, content: [] }],
      itemsView: "full",
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    },
  ];
  const [legacy] = await gateway.queryNativeDelivery(host, cwd, [
    { sessionId: threadId, commandId: oldCommand },
  ]);
  assert.equal(legacy.state, "accepted");
  assert.equal(legacy.turnId, "old-turn");
  for (const [message, data] of [
    ["no active turn to steer"],
    ["expected active turn id old-turn but found new-turn"],
    [
      "cannot steer the active turn",
      { codexErrorInfo: { activeTurnNotSteerable: { turnKind: "review" } } },
    ],
  ]) {
    const commandId = randomUUID();
    const refused = await gateway.recordNativeDelivery(
      host,
      threadId,
      commandId,
      "guide",
      async () => {
        throw new gateway.CodexRpcError("turn/steer", -32600, message, data);
      },
    );
    assert.equal(refused.state, "rejected");
    const [stored] = await gateway.queryNativeDelivery(host, cwd, [
      { sessionId: threadId, commandId },
    ]);
    assert.equal(stored.state, "rejected");
  }
  gateway.remoteHosts.bind(host, "different-key:epoch-3", {}, "different-key");
  const [wrongHost] = await gateway.queryNativeDelivery(host, cwd, lookup);
  assert.equal(wrongHost.state, "missing");
  await assert.rejects(
    gateway.createNativeDeliveryThread(host, cwd, commandId, true, async () => {
      extraStarts++;
    }),
  );
  assert.equal(extraStarts, 0);
  console.log(
    "Gateway receipt persistence, reconnect scope and native history reconciliation verified",
  );
} finally {
  db?.close();
  delete globalThis.deliveryFixture;
  await rm(work, { recursive: true, force: true });
}
