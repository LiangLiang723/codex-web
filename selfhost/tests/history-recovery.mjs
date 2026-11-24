import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const repo = resolve(import.meta.dirname, "../..");
const web = resolve(repo, "packages/web");
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
    const fixture = new URL("/history-recovery-fixture", vite.resolvedUrls.local[0]).href;
    await page.route(fixture, (route) => route.fulfill({ contentType: "text/html", body: "" }));
    await page.goto(fixture);
    const result = await page.evaluate(
      async (ui) => {
        const { openWorkspace } = await import("/src/selfhost/services.ts");
        const { createAgentConversationTransport } = await import(
          `${ui}/agentConversationTransport.ts`
        );
        const { SessionDataLayer } = await import(`${ui}/sessionDataLayer.ts`);
        const threadId = "thread-recovery";
        const turnId = "turn-recovery";
        const commandId = "1b4a3af9-0b09-48c7-ba82-a4d73b747e39";
        const cwd = "/history-recovery-fixture";
        const target = { workspacePath: cwd, sessionId: threadId };
        const prompt = {
          type: "userMessage",
          id: commandId,
          clientId: commandId,
          content: [{ type: "text", text: "继续" }],
        };
        const assistant = { id: "reply-id", type: "agentMessage", text: "前" };
        const thread = { id: threadId, cwd, name: "回放验收", status: { type: "active" } };
        const watchers = new Set();
        const emit = (msg) => watchers.forEach((watch) => watch(msg));
        const event = (id, value, eventEpoch = "first") =>
          emit({
            type: "thread.event",
            eventEpoch,
            event: { id, hostId: 1, threadId, event: value },
          });
        const snapshot = (text, state, id, eventEpoch = "first") => ({
          thread,
          history: {
            thread: {
              id: threadId,
              turns: [
                {
                  id: turnId,
                  status: state,
                  completedAt: state === "completed" ? 100 : null,
                  items: [prompt, { ...assistant, text, timelinePosition: 5 }],
                },
              ],
            },
          },
          lastEventId: id,
          eventEpoch,
          oldestTimelineCursor: "older-page",
        });
        const delta = {
          type: "timeline.item.delta",
          turnId,
          itemId: assistant.id,
          channel: "agentMessage",
          delta: "中",
        };
        let activations = 0;
        let nextSnapshot = snapshot("前", "inProgress", 10);
        const gateway = {
          request: async (url, schema) =>
            schema.parse(
              url.startsWith("/api/threads?") ? { data: [thread], nextCursor: null } : {},
            ),
          models: async () => [],
          on(watch) {
            watchers.add(watch);
            return () => watchers.delete(watch);
          },
          onTerminal: () => () => {},
          async send() {},
          async call(method) {
            if (method === "thread.goal.get") return { goal: null };
            if (method === "thread.timeline.load")
              return {
                data: [
                  { type: "turnStarted", turnId, position: 1, startedAt: 1 },
                  {
                    type: "item",
                    turnId,
                    position: 2,
                    item: { type: "reasoning", id: "earlier-item", summary: ["早些"] },
                  },
                ],
                nextCursor: null,
              };
            if (method !== "thread.activate") throw Error(`Unexpected request ${method}`);
            activations += 1;
            if (activations === 1) {
              // 原生激活调用建立订阅时帧可以先于投影的 ACK，并与快照游标重叠。
              emit({ type: "ready" });
              event(10, delta);
              event(11, delta);
              event(11, delta);
              event(12, delta);
            } else if (nextSnapshot instanceof Error) {
              throw nextSnapshot;
            } else {
              event(100, delta, "first");
            }
            return structuredClone(nextSnapshot);
          },
        };
        const workspace = await openWorkspace(gateway, 1, cwd, () => {});
        const agent = workspace.services.zcodeAgentService;
        await agent.getSessionLifecycle(target);
        const activationsBeforeSubscribe = activations;
        const transport = createAgentConversationTransport(agent, { workspacePath: cwd });
        const layer = new SessionDataLayer({ transport });
        const { store } = layer.acquire(threadId);
        const waitFor = (predicate) =>
          new Promise((resolve, reject) => {
            const read = () => {
              const state = store.getState();
              if (predicate(state)) {
                clearTimeout(timeout);
                off();
                resolve(state);
              }
            };
            const off = store.subscribe(read);
            const timeout = setTimeout(() => {
              off();
              reject(Error(JSON.stringify(store.getState())));
            }, 5500);
            read();
          });
        const reply = (state) =>
          state.snapshot?.rows.window.find((r) => r.kind === "assistantText");
        const user = (state) => state.snapshot?.rows.window.find((r) => r.kind === "userInput");
        try {
          const initial = await waitFor((state) => reply(state)?.text === "前中中");
          event(13, {
            type: "timeline.item.upsert",
            item: { ...prompt, turnId, id: "real-native-item" },
          });
          event(14, {
            type: "turn.completed",
            turn: { id: turnId, status: "completed", completedAt: 100, items: [] },
          });
          const completed = await waitFor(
            (state) =>
              state.snapshot?.control.phase === "completedSuccess" &&
              user(state)?.entityId === "real-native-item",
          );
          await agent.conversationRowsRangeV4({ ...target, limit: 20 });
          const { ack } = await agent.resyncConversationV4({
            ...target,
            subscriptionId: completed.subscriptionId,
            base: null,
          });
          const afterPage = await waitFor((state) => state.snapshot?.seq > completed.snapshot.seq);
          nextSnapshot = Error("fixture SSH unavailable");
          emit({ type: "thread.events.gap", hostId: 1, threadId, eventEpoch: "offline" });
          const failed = await waitFor(
            (state) => state.snapshot?.control.lastError?.message === nextSnapshot.message,
          );
          nextSnapshot = snapshot("前中中结束", "completed", 21, "second");
          nextSnapshot.history.thread.turns[0].items[0] = { ...prompt, id: "real-native-item" };
          emit({ type: "thread.events.gap", hostId: 1, threadId, eventEpoch: "second" });
          const recovered = await waitFor((state) => reply(state)?.text === "前中中结束");
          return {
            activationsBeforeSubscribe,
            stableUser:
              initial.snapshot.rows.window.find((r) => r.kind === "userInput").rowId ===
                user(completed).rowId && user(completed).rowId === user(recovered).rowId,
            commandId: user(completed).sourceCommandId,
            inOrder: user(completed).rowId < reply(completed).rowId,
            nativeId: user(recovered).entityId,
            phase: afterPage.snapshot.control.phase,
            afterPaging: reply(afterPage).text,
            earlierRow: afterPage.snapshot.rows.window.some(
              (row) => row.entityId === "earlier-item",
            ),
            recoverableFailure: failed.snapshot.control.lastError.recoverable,
            preservedAfterFailure: reply(failed).text,
            subscriptionPreserved:
              ack.subscriptionId === completed.subscriptionId &&
              recovered.subscriptionId === completed.subscriptionId,
          };
        } finally {
          layer.dispose();
          workspace.dispose();
        }
      },
      `/@fs/${resolve(repo, "packages/ui/src/v4").slice(1)}`,
    );
    assert.deepEqual(result, {
      activationsBeforeSubscribe: 0,
      stableUser: true,
      commandId: "1b4a3af9-0b09-48c7-ba82-a4d73b747e39",
      inOrder: true,
      nativeId: "real-native-item",
      phase: "completedSuccess",
      afterPaging: "前中中",
      earlierRow: true,
      recoverableFailure: true,
      preservedAfterFailure: "前中中",
      subscriptionPreserved: true,
    });
    process.stdout.write(
      "PASS first activation, ordered replay, terminal paging and scoped recovery\n",
    );
  } finally {
    await browser.close();
  }
} finally {
  await vite.close();
}
