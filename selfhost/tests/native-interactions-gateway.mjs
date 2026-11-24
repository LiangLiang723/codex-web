import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const repo = resolve(import.meta.dirname, "../..");
const work = await mkdtemp(join(tmpdir(), "zcode-native-interactions-"));
const source = process.argv[2] ?? join(work, "gateway");
const mocks = {
  "@posva/event-emitter": "export { EventEmitter } from 'node:events';",
  memory:
    "export const currentGatewayUserId = () => 1; export const bindGatewayUser = (callback) => callback;",
  "remote-hosts": "export const remoteHosts = { key: () => globalThis.interactionFixtureEpoch };",
  "thread-snapshots": "export const threadSnapshotStore = {};",
  "thread-timeline-pages": "export const threadTimelinePageStore = {};",
  "host-services": "export const sshConnections = {};",
  "host-events": "export const hostLifecycleBus = {};",
  "ssh-identity": "export const sshEndpointIdentity = () => 'fixture';",
  "remote-command": "export const remoteLoginShellCommand = () => '';",
  rpc: "export const CodexRpcClient = class {};",
  "runtime-log": "export const runtimeLog = () => {};",
  "accepted-user-message": "export const recordAcceptedUserMessage = () => {};",
  "thread-attachments": "export const sendWithUploadedFiles = () => {};",
  "thread-payload":
    "export const buildTurnStartParams = () => ({}); export const buildUserInput = () => [];",
};

try {
  if (!process.argv[2])
    execFileSync("python3", [join(repo, "selfhost/gateway/materialize.py"), source], {
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
  const { outputFiles } = await build({
    stdin: {
      resolveDir: source,
      contents: `
        export { mapCodexNotification } from './server/utils/gateway/agent/providers/codex/codex-event-mapper';
        export { pendingServerRequests } from './server/utils/gateway/runtime/pending-server-requests';
        export { applyEventToOpenSnapshot } from './server/utils/gateway/runtime/open-snapshot-events';
        export { gatewayEventStore } from './server/utils/gateway/state/gateway-events';
        export { ThreadTurnCommandService } from './server/utils/gateway/runtime/turn-commands';
        export { SharedCodexClient } from './server/utils/gateway/infra/rpc/shared-codex-client';
        export { realtimeClientMessageSchema } from './shared/runtime/realtime/client-message-schema';
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
        name: "fixture-owned-transport",
        setup(plugin) {
          plugin.onResolve({ filter: /.*/ }, ({ path }) => {
            const name = Object.hasOwn(mocks, path) ? path : path.split("/").at(-1);
            if (mocks[name]) return { path: name, namespace: "fixture" };
          });
          plugin.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
            contents: mocks[path],
          }));
        },
      },
    ],
  });
  const {
    mapCodexNotification,
    pendingServerRequests,
    applyEventToOpenSnapshot,
    gatewayEventStore,
    ThreadTurnCommandService,
    SharedCodexClient,
    realtimeClientMessageSchema,
  } = await import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
  );
  const host = { id: 1 };
  const threadId = "fixture-thread";
  const turnId = "fixture-turn";
  globalThis.interactionFixtureEpoch = "fixture-remote-one";
  const commandMethod = "item/commandExecution/requestApproval";
  const createdAt = new Date().toISOString();
  const remember = (id, method, details) => {
    const params = { threadId, turnId, itemId: "shared-native-item", ...details };
    const { event } = mapCodexNotification({ id, method, params, emittedAtMs: 1 });
    assert.equal(event.type, "serverRequest.requested");
    pendingServerRequests.track(host.id, threadId, { id, method, params });
    pendingServerRequests.remember({ id: 1, hostId: host.id, threadId, event, createdAt });
    return event.item;
  };
  const first = remember(10, commandMethod, { approvalId: "a" });
  const second = remember("10", commandMethod, { approvalId: "b" });
  assert.notEqual(first.id, second.id);
  assert.equal(first.params.itemId, second.params.itemId);
  remember(11, "item/fileChange/requestApproval", { reason: "fixture" });
  const mcp = remember(12, "mcpServer/elicitation/request", { turnId: null });
  assert.equal(mcp.turnId ?? null, null);
  assert.deepEqual(
    pendingServerRequests.forThread(host.id, threadId).map(({ event }) => event.requestId),
    [10, "10", 11, 12],
  );
  const unboundSnapshot = {
    thread: { id: threadId },
    history: { thread: { id: threadId, turns: [] } },
  };
  const mcpEvent = pendingServerRequests.forThread(host.id, threadId).at(-1).event;
  assert.equal(applyEventToOpenSnapshot(unboundSnapshot, mcpEvent), unboundSnapshot);

  const epoch = gatewayEventStore.epoch(host.id);
  assert(
    realtimeClientMessageSchema.safeParse({
      type: "serverRequest.respond",
      requestId: "web-response",
      hostId: host.id,
      threadId,
      serverRequestId: 10,
      eventEpoch: epoch,
      result: { decision: "accept" },
    }).success,
  );
  const wire = [];
  const client = Object.create(SharedCodexClient.prototype);
  client.connection = {
    pendingRequests: new Map([
      [10, false],
      ["10", false],
      [11, false],
    ]),
    client: { respond: (id, result) => wire.push({ id, result }) },
  };
  const service = new ThreadTurnCommandService({ getHostClient: async () => client }, {});
  const answer = (requestId, decision, eventEpoch = epoch, thread = threadId) =>
    service.respondToServerRequest(host, thread, { requestId, result: { decision }, eventEpoch });
  await assert.rejects(answer(10, "accept", "obsolete"));
  await assert.rejects(answer(10, "accept", epoch, "other-thread"));
  assert.equal(wire.length, 0);
  const concurrent = await Promise.allSettled([answer(10, "accept"), answer(10, "decline")]);
  assert.deepEqual(
    concurrent.map(({ status }) => status),
    ["fulfilled", "rejected"],
  );
  assert.deepEqual(wire, [{ id: 10, result: { decision: "accept" } }]);
  assert.equal(pendingServerRequests.forThread(host.id, threadId).length, 4);
  pendingServerRequests.resolveFromNotification(host.id, threadId, {
    method: "serverRequest/resolved",
    params: { threadId, requestId: 10 },
  });
  assert.deepEqual(
    pendingServerRequests.forThread(host.id, threadId).map(({ event }) => event.requestId),
    ["10", 11, 12],
  );
  await answer("10", "decline");
  assert.deepEqual(wire[1], { id: "10", result: { decision: "decline" } });
  globalThis.interactionFixtureEpoch = "fixture-remote-two";
  assert.deepEqual(pendingServerRequests.forThread(host.id, threadId), []);
  await assert.rejects(answer(11, "accept"));
  assert.equal(wire.length, 2);
  console.log(
    "PASS native request identity, scope, concurrent decisions and authoritative resolution",
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
