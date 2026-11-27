import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createServer } from "vite";

const root = resolve(import.meta.dirname, "../../packages/web");
const vite = await createServer({
  root,
  configFile: resolve(root, "vite.config.ts"),
  mode: "selfhost",
  logLevel: "silent",
  server: { middlewareMode: true, hmr: false, watch: null, ws: false },
});
const cwd = "/sidebar-state-fixture";
const first = { id: "active", cwd, createdAt: 100, updatedAt: 101, recencyAt: 100 };
const second = { ...first, id: "other", recencyAt: 105 };
const chosen = { providerId: "codex-ssh", modelId: "other-model", options: { reasoningLevel: "high" } };
const settings = new Map([
  [first.id, { approvalPolicy: "on-request", model: "default-model", effort: "low" }],
  [second.id, { approvalPolicy: "on-request", model: "default-model", effort: "low" }],
]);
const listeners = new Set();
const frames = new Set();
let eventId = 0;
let status = { type: "idle" };
let readOnly = false;
let payload;
const eventEpoch = "isolated";
const activeTurn = { id: "native-turn", startedAt: 110, status: "inProgress", items: [] };
const input = {
  type: "userMessage", turnId: activeTurn.id, id: "native-user", clientId: "submit",
  startsTurn: true, content: [{ type: "text", text: "Question" }],
};
const reply = {
  id: "native-reply", type: "agentMessage", turnId: activeTurn.id,
  text: "Answer", phase: "final_answer",
};
const dispatch = (event, threadId = first.id) => {
  for (const listener of listeners) {
    listener({ type: "thread.event", eventEpoch, event: { hostId: 1, threadId, id: ++eventId, event } });
  }
};
const gateway = {
  on(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  send: async () => {},
  call: async (type, { threadId }) => {
    if (type === "thread.activate") {
      return {
        thread: threadId === first.id ? first : second,
        threadSettings: settings.get(threadId),
        eventEpoch,
        lastEventId: eventId,
        readOnly,
        history: { thread: { id: threadId, turns: [] } },
      };
    }
    return {};
  },
  request: async (url, schema, method, body) => {
    if (url.startsWith("/api/threads?")) {
      return schema.parse({ data: [{ ...first, status }, { ...second, status: { type: "idle" } }] });
    }
    if (url === "/api/threads/settings" && method === "POST") {
      payload = body;
      const { hostId, threadId, ...change } = body;
      assert.equal(hostId, 1);
      const next = { ...settings.get(threadId), ...change };
      settings.set(threadId, next);
      dispatch({ type: "thread.settings.updated", threadSettings: next }, threadId);
      return schema.parse({});
    }
    return schema.parse({ summaries: {} });
  },
};

function nextSnapshot(predicate) {
  return new Promise((accept, reject) => {
    const timeout = setTimeout(() => {
      frames.delete(receive);
      reject(Error("Timed out waiting for the corresponding Web snapshot"));
    }, 4000);
    function receive(data) {
      if (!predicate(data)) return;
      clearTimeout(timeout);
      frames.delete(receive);
      accept(data);
    }
    frames.add(receive);
  });
}

let bridge;
try {
  const { SessionBridge } = await vite.ssrLoadModule("/src/selfhost/sessionBridge.ts");
  const models = ["default-model", "other-model"].map((model) => ({
    model, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
  }));
  bridge = new SessionBridge(gateway, 1, cwd, models, (_channel, _event, wire) => {
    if (wire.kind === "complete") for (const receive of frames) receive(wire.frame.payload.snapshot);
  }, async () => undefined);
  const index = () => nextSnapshot((snapshot) => Array.isArray(snapshot?.sessions));
  const conversation = (predicate) =>
    nextSnapshot((snapshot) => snapshot?.sessionId === first.id && predicate(snapshot));
  const subscribe = (sessionId) => bridge.handle("subscribeConversationV4", { sessionId });
  const command = (type, data) => bridge.handle("sendConversationCommandV4", {
    envelope: {
      type, payload: data, workspace: { workspacePath: cwd, workspaceKey: cwd }, commandId: randomUUID(),
      clientId: "isolated", sessionId: first.id, issuedAt: Date.now(),
    },
  });

  let next = index();
  await bridge.handle("subscribeSessionsIndexV4", {});
  assert.equal((await next).sessions[0].phase, "completedSuccess");
  const original = await subscribe(first.id);
  next = index();
  status = { type: "active", activeFlags: [] };
  first.recencyAt = 110;
  dispatch({ type: "turn.started", turn: activeTurn });
  const running = (await next).sessions[0];
  assert.equal(running.phase, "running");
  next = index();
  status = { type: "active", activeFlags: ["waitingOnApproval"] };
  dispatch({ type: "thread.status.changed", status });
  const waiting = (await next).sessions[0];
  assert.deepEqual(waiting.pendingInteractionSummary, {
    permissionCount: 1, userInputCount: 0,
  });
  next = conversation((snapshot) => snapshot.rows.window.some((row) => row.text === reply.text));
  dispatch({ type: "timeline.item.upsert", item: reply });
  const priorReplyId = (await next).rows.window.find((row) => row.text === reply.text).rowId;
  next = conversation((snapshot) => snapshot.control.phase === "completedSuccess");
  const terminal = index();
  status = { type: "idle" };
  dispatch({ type: "timeline.item.upsert", item: input });
  dispatch({ type: "turn.completed", turn: { ...activeTurn, status: "completed", completedAt: 120 } });
  const completed = (await next).rows.window;
  assert.deepEqual(completed.filter((row) => row.text).map((row) => row.text), ["Question", "Answer"]);
  assert.equal(completed.find((row) => row.text === "Answer").rowId, priorReplyId);
  const summary = (await terminal).sessions[0];
  assert.equal(summary.phase, "completedSuccess");
  assert.equal(summary.lastActivityAt, 110_000);
  const { deriveTaskLeadingIndicator } =
    await vite.ssrLoadModule(resolve(root, "../ui/src/lib/taskListItemPresentation.ts"));
  assert.equal(deriveTaskLeadingIndicator({}, { phase: running.phase }), "loading");
  assert.equal(deriveTaskLeadingIndicator({}, {
    phase: waiting.phase, pendingInteractions: waiting.pendingInteractionSummary,
  }), "none");
  assert.equal(deriveTaskLeadingIndicator({}, { phase: summary.phase }), "none");

  next = conversation((snapshot) => snapshot.config.mode === "yolo");
  assert.equal((await command("switchCollaborationMode", { mode: "yolo" })).status, "accepted");
  assert.equal(payload.approvalPolicy, "never");
  assert.deepEqual(payload.sandboxPolicy, { type: "dangerFullAccess" });
  await next;

  next = conversation((snapshot) => snapshot.config.model === chosen.modelId);
  assert.equal((await command("switchModelConfig", {
    provider: chosen.providerId, model: chosen.modelId, thought: "high",
  })).status, "accepted");
  assert.deepEqual((await next).config.modelSelection, chosen);
  next = conversation((snapshot) => snapshot.config.planEnabled);
  assert.equal((await command("switchCollaborationMode", { mode: "plan", planEnabled: true })).status,
    "accepted");
  assert.equal(payload.collaborationMode.settings.model, chosen.modelId);
  assert.equal(payload.collaborationMode.settings.reasoningEffort, "high");
  assert.equal(Object.hasOwn(payload, "sandboxPolicy"), false);
  await next;

  await bridge.handle("unsubscribeConversationV4", { subscriptionId: original.ack.subscriptionId });
  next = nextSnapshot((snapshot) => snapshot?.sessionId === second.id);
  await subscribe(second.id);
  assert.equal((await next).config.model, "default-model");
  readOnly = true;
  next = conversation((snapshot) => snapshot.config.planEnabled);
  await subscribe(first.id);
  const reopened = (await next).config;
  assert.equal(reopened.mode, "yolo");
  assert.equal(reopened.thought, "high");
  assert.deepEqual(reopened.modelSelection, chosen);
  assert.equal((await command("switchCollaborationMode", { mode: "guarded" })).status, "failed");
  assert.equal(settings.get(first.id).approvalPolicy, "never");

  const { acceptComposerRecentReceipt, prepareComposerRecentReceipt, readComposerRecent } =
    await vite.ssrLoadModule(resolve(root, "../ui/src/lib/composerRecent.ts"));
  const stored = new Map();
  const storage = { getItem: (key) => stored.get(key), setItem: (key, value) => stored.set(key, value) };
  const scope = { clientNamespace: "host-1/workspace", hostId: "local", projectId: "A" };
  const older = prepareComposerRecentReceipt(scope, { mode: "build" });
  for (const receipt of [
    prepareComposerRecentReceipt(scope, { mode: "yolo", planEnabled: true }),
    prepareComposerRecentReceipt(scope, { modelSelection: chosen }),
    older,
  ]) {
    assert.equal(acceptComposerRecentReceipt(receipt, storage, first.id), true);
  }
  const pref = readComposerRecent(cwd, undefined, storage, { ...scope, projectId: "B" });
  assert.deepEqual(pref, { mode: "yolo", planEnabled: true, modelSelection: chosen });
  assert.equal(readComposerRecent(cwd, undefined, storage, { ...scope, clientNamespace: "host-2/workspace" }), null);
  assert.deepEqual(readComposerRecent(cwd, undefined, storage, scope, first.id), pref);
  assert.equal(readComposerRecent(cwd, undefined, storage, scope, second.id), null);
  const { initializeNewTaskDraft } =
    await vite.ssrLoadModule(resolve(root, "../ui/src/v4/composer/newTaskDraft.ts"));
  const { installSelfhostBrowserStorage } =
    await vite.ssrLoadModule(resolve(root, "../ui/src/lib/browserEnvironment.ts"));
  globalThis.window = {};
  installSelfhostBrowserStorage(storage);
  const { draft } = initializeNewTaskDraft({ text: "" }, cwd, undefined, {}, scope);
  assert.equal(draft.mode, pref.mode);
  assert.equal(draft.planEnabled, pref.planEnabled);
  assert.deepEqual(draft.modelSelection, pref.modelSelection);
  const { submitNativeInput } = await vite.ssrLoadModule("/src/selfhost/nativeDelivery.ts");
  const sent = [];
  const offlineReopen = {
    gateway: {
      call: async (type, params) => {
        sent.push({ type, params });
        return { state: "accepted", delivery: "startNow", turnId: "after-restart" };
      },
    },
    hostId: 1,
    cwd,
  };
  const restarted = { threadSettings: { model: "default-model", approvalPolicy: "on-request" } };
  await submitNativeInput(offlineReopen, first.id, { ...pref, text: "Next question" }, randomUUID(), {
    active: restarted, followupMode: "guide", first: false,
  });
  assert.equal(sent[0].type, "turn.start");
  assert.equal(sent[0].params.approvalPolicy, "never");
  assert.deepEqual(sent[0].params.sandboxPolicy, { type: "dangerFullAccess" });
  assert.equal(sent[0].params.model, chosen.modelId);
  assert.equal(sent[0].params.effort, "high");
  assert.equal(sent[0].params.collaborationMode.mode, "plan");
  await submitNativeInput(offlineReopen, first.id, { ...pref, mode: "guarded", text: "Next" }, randomUUID(), {
    active: { threadSettings: { sandboxPolicy: { type: "dangerFullAccess" } } },
    followupMode: "guide", first: false,
  });
  assert.equal(sent[1].params.approvalPolicy, "untrusted");
  assert.equal(sent[1].params.sandboxPolicy.type, "workspaceWrite");
  console.log("PASS native sidebar lifecycle, late initial input, thread settings and draft preferences");
} finally {
  bridge?.dispose();
  await vite.close();
}
