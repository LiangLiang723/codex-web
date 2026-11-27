import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const web = resolve(import.meta.dirname, "../../packages/web");
const vite = await createServer({
  root: web,
  configFile: resolve(web, "vite.config.ts"),
  mode: "selfhost",
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, hmr: false },
});

try {
  await vite.listen();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    const fixture = new URL("/delivery-fixture", vite.resolvedUrls.local[0]).href;
    await page.route(fixture, (route) => route.fulfill({ contentType: "text/html", body: "" }));
    await page.goto(fixture);
    const result = await page.evaluate(async () => {
      const { SessionBridge } = await import("/src/selfhost/sessionBridge.ts");
      const { projectThread } = await import("/src/selfhost/threadProjection.ts");
      const threadId = "original-native-thread";
      const cwd = "/delivery-fixture";
      const commandId = crypto.randomUUID();
      const calls = [];
      let receipt = "created";
      const subscribers = new Set();
      const previousTurn = {
        id: "earlier",
        status: "completed",
        items: [
          {
            id: "answer",
            type: "agentMessage",
            text: "Earlier answer",
          },
        ],
      };
      const runningTurn = { id: "running", status: "inProgress", items: [] };
      const thread = { id: threadId, cwd, turns: [previousTurn, runningTurn] };
      const queuedInput = {
        id: "persisted-queue-item",
        clientUserMessageId: "queue-source",
        input: [],
      };
      const gateway = {
        on(listener) {
          subscribers.add(listener);
          return () => subscribers.delete(listener);
        },
        async send() {},
        async call(type, args) {
          calls.push({ type, ...args });
          if (type === "thread.activate") return { thread, history: { thread } };
          if (type === "thread.goal.get") return { goal: null };
          if (type === "thread.native.controls")
            return { fork: true, compact: true, queue: true, queued: [queuedInput] };
          if (type === "thread.start") throw Error("fixture: native thread created, reply lost");
          if (type === "turn.start") {
            receipt = "pending";
            throw Error("fixture: reply lost after sending native input");
          }
          if (type === "thread.delivery.query") {
            return {
              results: args.commands.map((key) => ({
                key,
                ...(key.commandId === commandId
                  ? { state: receipt, threadId, delivery: "startNow", turnId: "first-turn" }
                  : { state: "missing" }),
              })),
            };
          }
          if (type === "thread.queue.add") return { state: "accepted", delivery: "queue" };
          if (type === "thread.queue.delete") return { deleted: true };
          if (type === "turn.steer")
            return { state: "accepted", delivery: "guide", turnId: "running" };
          if (type === "thread.fork") return { thread: { id: "native-fork" } };
          if (type === "thread.native.compact") return {};
          throw Error(`Unexpected call ${type}`);
        },
      };
      const makeBridge = () =>
        new SessionBridge(
          gateway,
          1,
          cwd,
          [],
          () => {},
          async () => undefined,
        );
      const bridge = makeBridge();
      const envelope = {
        commandId,
        clientId: "fixture",
        type: "createSession",
        sessionId: null,
        issuedAt: Date.now(),
        payload: { workspaceId: cwd, firstInput: { text: "First input" } },
      };
      const first = await bridge.handle("sendConversationCommandV4", { envelope }).then(
        () => "resolved",
        () => "unconfirmed",
      );
      const lookup = {
        commands: [
          { sessionId: null, commandId },
          { sessionId: threadId, commandId: crypto.randomUUID() },
        ],
      };
      const afterReload = makeBridge();
      const pending = await afterReload.handle("queryConversationCommandsV4", lookup);
      receipt = "accepted";
      const confirmed = await afterReload.handle("queryConversationCommandsV4", lookup);
      const { ack: subscription } = await afterReload.handle("subscribeConversationV4", {
        sessionId: threadId,
      });
      const run = (type, payload) =>
        afterReload.handle("sendConversationCommandV4", {
          envelope: {
            commandId: crypto.randomUUID(),
            clientId: "fixture",
            sessionId: threadId,
            type,
            payload,
            issuedAt: Date.now(),
            baseRevision: 1,
            baseLogEpoch: subscription.logEpoch,
          },
        });
      const attachments = [
        { ref: "/fixture/image.png", fileName: "image.png", mime: "image/png", bytes: 18 },
      ];
      const queued = await run("sendText", {
        text: "Later",
        requestedDelivery: "queue",
        attachments,
      });
      const guided = await run("sendText", {
        text: "Now",
        requestedDelivery: "guide",
        expectedTurnId: "running",
        attachments,
      });
      const staleGuide = await run("sendText", {
        text: "This was meant for the earlier turn",
        requestedDelivery: "guide",
        expectedTurnId: "earlier",
      });
      const deleted = await run("deleteQueueItem", { queueItemId: queuedInput.id });
      const { rows } = await afterReload.handle("conversationRowsRangeV4", { sessionId: threadId });
      const target = rows.find((row) => row.entityId === "answer");
      const fork = await run("forkAssistant", {
        target: { rowId: target.rowId, entityId: target.entityId },
      });
      const staleFork = await run("forkAssistant", {
        target: { rowId: target.rowId, entityId: "different" },
      });
      const busyCompact = await run("compact", {});
      for (const deliver of subscribers)
        deliver({
          type: "thread.event",
          event: {
            threadId,
            hostId: 1,
            id: 1,
            event: {
              type: "turn.completed",
              turn: { ...runningTurn, status: "completed" },
            },
          },
        });
      await afterReload.handle("resyncConversationV4", {
        subscriptionId: subscription.subscriptionId,
      });
      const compact = await run("compact", {});
      const controls = projectThread(
        {
          nativeControls: {
            queue: true,
            fork: true,
            compact: true,
            queued: [
              {
                id: "native-queue",
                clientUserMessageId: "queue-command",
                input: [{ type: "text", text: "Queued" }],
              },
            ],
          },
          tokenUsage: {
            total: { inputTokens: 54, outputTokens: 15, cachedInputTokens: 3 },
            last: { totalTokens: 42 },
            modelContextWindow: 2048,
          },
          history: {
            thread: {
              turns: [
                {
                  id: "completed-turn",
                  status: "completed",
                  items: [{ id: "assistant", type: "agentMessage", text: "Completed" }],
                },
              ],
            },
          },
        },
        threadId,
        "epoch",
        2,
        [],
        new Map(),
      );
      const compacting = projectThread(
        {
          nativeControls: { queue: true, compact: true },
          history: {
            thread: {
              turns: [
                {
                  ...runningTurn,
                  items: [{ id: "compact-item", type: "contextCompaction", status: "inProgress" }],
                },
              ],
            },
          },
        },
        threadId,
        "epoch",
        2,
        [],
        new Map(),
      );
      const reviewing = projectThread(
        {
          nativeControls: { queue: true },
          history: {
            thread: {
              turns: [
                {
                  ...runningTurn,
                  items: [{ id: "review", type: "enteredReviewMode", review: "fixture" }],
                },
              ],
            },
          },
        },
        threadId,
        "epoch",
        2,
        [],
        new Map(),
      );
      bridge.dispose();
      afterReload.dispose();
      return {
        first,
        calls,
        pending,
        confirmed,
        controls,
        queued,
        guided,
        staleGuide,
        deleted,
        fork,
        staleFork,
        busyCompact,
        compact,
        compacting,
        reviewing,
      };
    });
    assert.equal(
      result.first,
      "unconfirmed",
      "uncertain admission is retained by the V4 pending registry",
    );
    assert.deepEqual(result.calls.filter(({ type }) => type === "thread.start").length, 1);
    const sends = result.calls.filter(({ type }) => type === "turn.start");
    assert.equal(sends.length, 1, "recovery reads must not dispatch the same native input again");
    assert.equal(sends[0].threadId, "original-native-thread");
    assert.deepEqual(
      result.pending.results.map(({ result }) => result),
      ["unknown", "unknown"],
    );
    assert.equal(result.confirmed.results[0].result.result.sessionId, "original-native-thread");
    assert.equal(result.confirmed.results[1].result, "unknown");
    assert.equal(result.controls.queue.items[0].queueItemId, "native-queue");
    assert.equal(result.controls.queue.items[0].sourceCommandId, "queue-command");
    assert.equal(result.controls.usage.contextWindow.usedTokens, 42);
    assert.equal(
      result.controls.rows.window.find(({ kind }) => kind === "assistantText").actions.canFork,
      true,
    );
    assert.equal(result.queued.result.delivery, "queue");
    assert.equal(result.guided.result.delivery, "guide");
    assert.equal(result.staleGuide.status, "failed");
    assert(!result.calls.some(({ text }) => text === "This was meant for the earlier turn"));
    const queue = result.calls.find(({ type }) => type === "thread.queue.add");
    const steer = result.calls.find(({ type }) => type === "turn.steer");
    assert.equal(steer.expectedTurnId, "running");
    assert.deepEqual(steer.files, queue.files);
    assert.deepEqual(steer.images, [{ path: "/fixture/image.png" }]);
    assert.equal(result.deleted.status, "accepted");
    assert.equal(
      result.calls.find(({ type }) => type === "thread.queue.delete").queuedSubmissionId,
      "persisted-queue-item",
    );
    assert.equal(result.fork.result.sessionId, "native-fork");
    assert.equal(result.calls.find(({ type }) => type === "thread.fork").turnId, "earlier");
    assert.equal(result.calls.find(({ type }) => type === "thread.fork").boundary, "after");
    assert.equal(result.staleFork.status, "failed");
    assert.equal(result.busyCompact.status, "failed");
    assert.equal(result.compact.status, "accepted");
    assert.deepEqual(
      result.compacting.control.activeWorks.map(({ kind }) => kind),
      ["compact"],
    );
    assert.equal(result.compacting.inputRouting.mode, "enqueue");
    assert.equal(result.compacting.inputRouting.steerTurnId, undefined);
    assert.equal(result.reviewing.inputRouting.mode, "enqueue");
    assert.equal(result.reviewing.inputRouting.steerTurnId, undefined);
    console.log("Native delivery, queue and completed turn projection verified");
  } finally {
    await browser.close();
  }
} finally {
  await vite.close();
}
