import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const repo = resolve(import.meta.dirname, "../..");
const work = await mkdtemp(join(tmpdir(), "zcode-history-check-"));
const source = process.argv[2] ?? join(work, "source");
const mocks = {
  memory: `
    export const currentGatewayUserId = () => 1;
    export const bindGatewayUser = (callback) => callback;
    export const runWithGatewayUser = (_user, callback) => callback();
    export const currentGatewayMemoryState = () => ({ pinnedThreads: [] });
  `,
  hosts: "export const hostStore = { getWithSecret: (id) => ({ id, name: 'fixture' }) };",
  projects: "export const projectStore = { ensureForPath: () => null };",
  "thread-metadata": "export const threadMetadataStore = { record() {} };",
  "sub-agent-threads": "export const subAgentThreadStore = { recordRuntimeEvent() {} };",
  "thread-notification-dispatcher": "export const dispatchThreadRuntimeNotification = () => {};",
  "thread-runtime-status-hub": "export const threadRuntimeStatusHub = { publish() {} };",
  "selfhost-thread-title": "export const webThreadSource = 'fixture';",
  "runtime-log": "export const runtimeLog = () => {};",
  logging: "export const gatewayLog = () => {};",
  errors: `
    export class CodexRpcError extends Error {
      constructor(rpcMethod, rpcCode, message, rpcData) {
        super(message);
        Object.assign(this, { rpcMethod, rpcCode, rpcData });
      }
    }
  `,
  broker: "export const threadBroker = globalThis.historyRecoveryFixture.broker;",
  h3: "export const createError = ({ statusMessage }) => Error(statusMessage);",
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
        export { ThreadHistoryReader } from './server/utils/gateway/runtime/thread-history-reader';
        export { ThreadOpenService } from './server/utils/gateway/runtime/thread-open-service';
        export { CodexRpcError } from './server/utils/gateway/http/errors';
        export { activateThread, unsubscribeThread } from './server/utils/gateway/realtime/handlers/thread-events';
        export { stateFor } from './server/utils/gateway/realtime/peer-state';
        export { remoteHosts } from './server/utils/gateway/state/remote-hosts';
        export { gatewayEventStore } from './server/utils/gateway/state/gateway-events';
        export { hostLifecycleBus } from './server/utils/gateway/state/host-events';
        export { hostSessionEvents } from './server/utils/gateway/runtime/host-session-events';
        export { threadRuntimeEvents } from './server/utils/gateway/runtime/thread-runtime-events';
        export { threadSnapshotStore } from './server/utils/gateway/state/thread-snapshots';
        export { appServerThreadSchema } from './shared/runtime/app-server';
        export { timelinePageToTurns } from './shared/thread-history/app-server-timeline';
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
        name: "fixture-infrastructure",
        setup(plugin) {
          plugin.onResolve({ filter: /.*/ }, ({ path }) => {
            const name = path.split("/").at(-1);
            if (Object.hasOwn(mocks, name)) return { path: name, namespace: "fixture" };
          });
          plugin.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
            contents: mocks[path],
            loader: "js",
          }));
        },
      },
    ],
  });
  globalThis.historyRecoveryFixture = { broker: {} };
  const gateway = await import(
    "data:text/javascript;base64," + Buffer.from(outputFiles[0].contents).toString("base64")
  );
  const host = { id: 1, name: "fixture" };
  const threadId = "fa1bfad3-d45b-4cab-bc0c-0810fb362af1";
  const turnId = "0d76c799-daed-44fe-825c-ba5b2eb71fe9";
  const threadFixture = {
    id: threadId,
    sessionId: "e6e93291-9b9d-4de5-8b48-f43d40454426",
    cwd: "/recovery-mock",
    historyMode: "legacy",
    name: "历史恢复",
    status: { type: "idle" },
    modelProvider: "fixture",
    preview: "",
    ephemeral: false,
    createdAt: 1,
    updatedAt: 2,
    cliVersion: "0.170.0",
    source: "cli",
    turns: [],
  };
  for (const key of [
    "environments",
    "extra",
    "forkedFromId",
    "attachedToThreadId",
    "parentThreadId",
    "section",
    "sectionEnteredAt",
    "projectId",
    "model",
    "reasoningEffort",
    "recencyAt",
    "path",
    "originator",
    "canAcceptDirectInput",
    "threadSource",
    "agentNickname",
    "agentRole",
    "daybreakEnabled",
    "gitInfo",
  ])
    threadFixture[key] = null;
  const assistant = { id: "native-item", type: "agentMessage", text: "前" };
  const turn = {
    id: turnId,
    rootTurnId: null,
    items: [assistant],
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: 10,
    completedAt: 20,
    durationMs: 10000,
  };
  const calls = [];
  let remoteTimeline = async () => {
    throw Error("fixture timeline unsupported for legacy");
  };
  const registry = {
    getHostClient: async () => ({
      async request(method, params, _timeout, parse) {
        calls.push({ method, params });
        switch (method) {
          case "thread/read":
            return parse({ thread: threadFixture });
          case "thread/turns/list":
            return parse({
              data: params.cursor
                ? [
                    {
                      ...turn,
                      id: "older-turn",
                      items: [],
                      status: "failed",
                      error: {
                        message: "historical error",
                        codexErrorInfo: null,
                        additionalDetails: null,
                        misalignment: null,
                      },
                    },
                  ]
                : [turn],
              nextCursor: params.cursor ? null : "opaque-turn-cursor",
              backwardsCursor: null,
            });
          case "thread/timeline/list":
            return parse(await remoteTimeline());
          default:
            throw Error(`Unexpected Codex request ${method}`);
        }
      },
    }),
  };
  const history = new gateway.ThreadHistoryReader(registry);
  const opening = new gateway.ThreadOpenService(registry, history);
  const owner = {};
  gateway.remoteHosts.bind(host, "fixture-epoch-one", owner);
  const native = gateway.appServerThreadSchema.parse(threadFixture);
  assert.equal(native.historyMode, "legacy");
  const initial = await history.loadInitialTimelinePage(host, native, 100);
  const earlier = await history.listTimelinePage(host, threadId, initial.nextCursor, 100);
  assert.equal(gateway.timelinePageToTurns(initial)[0].items[0].id, assistant.id);
  assert.equal(gateway.timelinePageToTurns(earlier)[0].error.message, "historical error");
  assert.deepEqual(
    calls.map(({ method }) => method),
    ["thread/turns/list", "thread/turns/list"],
  );
  assert.equal(calls[1].params.cursor, "opaque-turn-cursor");
  assert.equal(calls[0].params.itemsView, "full");
  assert.equal(calls[0].params.sortDirection, "desc");
  assert(calls[0].params.limit <= 50, "A page cannot outrun the cache Turn limit");
  process.stdout.write("PASS native legacy paging and opaque continuation\n");

  let resumeError;
  let subscribed = false;
  let resumes = 0;
  const controller = {
    isSubscribed: () => subscribed,
    async ensureSubscribed() {
      assert(subscribed, "Writable activation must own the native subscription");
    },
    async resumeForHistory() {
      resumes += 1;
      if (resumeError) throw resumeError;
      subscribed = true;
      return { thread: native };
    },
    setOpenSnapshot(value) {
      gateway.threadSnapshotStore.set(host.id, threadId, value);
    },
  };
  const open = () => opening.openThread(host, threadId, 100, controller, true);
  await open();
  subscribed = false;
  resumeError = new gateway.CodexRpcError(
    "thread/resume",
    -32600,
    `thread ${threadId} already has an active writer`,
  );
  assert.equal(
    (await open()).readOnlyReason,
    "activeWriter",
    "Warm history must recheck the writer",
  );
  resumeError = new gateway.CodexRpcError("thread/resume", -32600, "provider mismatch", {
    type: "modelProviderMismatch",
  });
  const mismatch = await open();
  assert.equal(mismatch.readOnlyReason, "modelProviderMismatch");
  assert.equal(mismatch.history.thread.id, threadId);
  assert.equal(mismatch.thread.sessionId, threadFixture.sessionId);
  resumeError = undefined;
  assert.equal((await open()).readOnly, false);
  const resumesWhileWritable = resumes;
  await open();
  assert.equal(resumes, resumesWhileWritable);
  process.stdout.write("PASS warm writer, typed provider mismatch and subscription reuse\n");

  subscribed = false;
  resumeError = new gateway.CodexRpcError(
    "thread/resume",
    -32600,
    "cannot resume an unloaded multi-agent v2 sub-agent through its parent; resume the parent first, or use thread/read to inspect it",
  );
  await assert.rejects(open(), /cannot resume an unloaded/);
  threadFixture.parentThreadId = "parent-thread";
  const inspected = await open();
  assert.equal(inspected.readOnly, true);
  assert.equal(inspected.readOnlyReason, "subagent");
  assert.equal(inspected.history.thread.turns[0].items[0].text, "前");
  assert.equal(subscribed, false, "Inspecting an unloaded child must not acquire a writer");
  threadFixture.parentThreadId = null;
  resumeError = undefined;
  process.stdout.write("PASS unloaded native child history and lineage check\n");

  // Exercise the actual Gateway publisher and canonical reduction. RPC, authentication, and
  // external notifications are fixture boundaries. No SSH, files, or model are involved.
  const paginated = { ...native, historyMode: "paginated" };
  controller.resumeForHistory = async () => {
    subscribed = true;
    return { thread: paginated };
  };
  let released = 0;
  Object.assign(globalThis.historyRecoveryFixture.broker, {
    retainThreadActivation() {
      return {
        ready: Promise.resolve(controller),
        release: () => {
          released += 1;
        },
      };
    },
    openThread: (...args) => opening.openThread(...args),
    resolveThreadSettings: async () => {},
  });
  const peerMessages = [];
  const peer = { send: (value) => peerMessages.push(JSON.parse(value)), close() {}, context: {} };
  gateway.stateFor(peer).userId = 1;
  const activate = () =>
    gateway.activateThread(peer, {
      type: "thread.activate",
      requestId: String(peerMessages.length),
      hostId: host.id,
      threadId,
      retryWriter: true,
    });
  const record = (event) => gateway.threadRuntimeEvents.record(host.id, threadId, event);
  const delta = {
    type: "timeline.item.delta",
    turnId,
    itemId: assistant.id,
    channel: "agentMessage",
    delta: "中",
  };
  gateway.remoteHosts.bind(host, "fixture-epoch-two", owner);
  subscribed = false;
  remoteTimeline = async () => {
    record({ type: "turn.started", turn: { ...turn, status: "inProgress", items: [] } });
    record({ type: "timeline.item.upsert", item: { ...assistant, turnId, startedAtMs: 1000 } });
    record(delta);
    record(delta);
    // Codex's own current page has already seen the first of the two deltas.
    return {
      data: [
        { type: "turnStarted", turnId, position: 1, startedAt: 10 },
        {
          type: "item",
          turnId,
          position: 2,
          item: { ...assistant, text: "前中", completedAtMs: null },
        },
      ],
      nextCursor: null,
      activeRealtimeSessionAtPageStart: null,
    };
  };
  await activate();
  const cold = peerMessages[0];
  assert.equal(cold.lastEventId, gateway.gatewayEventStore.latestId(host.id, threadId));
  assert.equal(cold.history.thread.turns.at(-1).items[0].text, "前中中");
  assert.equal(peerMessages.length, 1, "Cold snapshot must not replay its own deltas");
  const live = record(delta);
  assert.equal(peerMessages.at(-1).event.id, live.id);
  await activate();
  const warm = peerMessages.at(-1);
  assert.equal(warm.type, "thread.snapshot");
  assert.equal(warm.lastEventId, live.id);
  assert.equal(warm.history.thread.turns.at(-1).items[0].text, "前中中中");
  gateway.hostSessionEvents.emitClosed(1, host.id);
  gateway.remoteHosts.bind(host, "fixture-epoch-three", owner);
  gateway.hostLifecycleBus.emit({
    hostId: host.id,
    status: "connected",
    message: "fixture connected",
  });
  gateway.hostLifecycleBus.emit({
    hostId: host.id,
    status: "connected",
    message: "duplicate ready",
  });
  assert.equal(peerMessages.filter((value) => value.type === "thread.events.gap").length, 1);
  assert.equal(peerMessages.at(-1).type, "thread.events.gap");
  assert.equal(peerMessages.at(-1).eventEpoch, gateway.gatewayEventStore.epoch(host.id));
  assert.equal(released, 2);
  gateway.unsubscribeThread(peer, { type: "thread.unsubscribe", hostId: host.id, threadId });
  process.stdout.write("PASS aligned cold and warm cursors and proactive SSH epoch gap\n");
} finally {
  delete globalThis.historyRecoveryFixture;
  await rm(work, { recursive: true, force: true });
}
