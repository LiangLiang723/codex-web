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
    for (const viewport of [
      { width: 1480, height: 900 },
      { width: 390, height: 844 },
    ]) {
      const page = await browser.newPage({ viewport });
      try {
        const origin = vite.resolvedUrls.local[0];
        const fixture = new URL("/resync-fixture", origin).href;
        await page.route(fixture, (route) => route.fulfill({ contentType: "text/html", body: "" }));
        await page.goto(fixture);
        const result = await page.evaluate(
          async (ui) => {
            const { openWorkspace } = await import("/src/selfhost/services.ts");
            const { createAgentConversationTransport } = await import(
              `${ui}/agentConversationTransport.ts`
            );
            const { SessionDataLayer } = await import(`${ui}/sessionDataLayer.ts`);
            const threadId = "resync-fixture";
            const cwd = "/resync-fixture";
            const turn = {
              id: "turn-1",
              status: "inProgress",
              items: [{ id: "reply-1", type: "agentMessage", text: "前半段" }],
            };
            const thread = { id: threadId, cwd, status: { type: "active" }, turns: [turn] };
            const watchers = new Set();
            const gateway = {
              models: async () => [],
              request: async (url, schema) =>
                schema.parse(
                  url.startsWith("/api/threads?") ? { data: [thread], nextCursor: null } : {},
                ),
              on(listener) {
                watchers.add(listener);
                return () => watchers.delete(listener);
              },
              onTerminal: () => () => {},
              async send({ type }) {
                if (type !== "thread.unsubscribe") throw new Error(`Unexpected command ${type}`);
              },
              async call(type) {
                if (type === "thread.goal.get") return { goal: null };
                if (type !== "thread.activate") throw new Error(`Unexpected request ${type}`);
                return { thread, history: { thread }, lastEventId: 0 };
              },
            };
            const workspace = await openWorkspace(gateway, 1, cwd, () => {});
            const agent = workspace.services.zcodeAgentService;
            const transport = createAgentConversationTransport(agent, { workspacePath: cwd });
            const layer = new SessionDataLayer({ transport });
            const { store } = layer.acquire(threadId);
            const waitForState = (predicate) =>
              new Promise((done, reject) => {
                const read = () => {
                  const state = store.getState();
                  if (state.status === "error") finish(new Error(state.lastError));
                  else if (predicate(state)) finish(null, state);
                };
                const off = store.subscribe(read);
                const deadline = setTimeout(
                  () => finish(new Error("Timed out waiting for projection")),
                  10000,
                );
                function finish(error, state) {
                  clearTimeout(deadline);
                  off();
                  if (error) reject(error);
                  else done(state);
                }
                read();
              });
            const reply = (state) =>
              state.snapshot?.rows.window.find((row) => row.kind === "assistantText");
            const emit = (event, id) => {
              for (const listener of watchers)
                listener({ type: "thread.event", event: { hostId: 1, threadId, event, id } });
            };
            try {
              const first = await waitForState((state) => reply(state)?.text === "前半段");
              // 从真实帧装配故障进入同订阅恢复路径，保留原生在途轮次。
              store.handleAssemblyFault(first.subscriptionId, "online");
              await waitForState((state) => state.snapshot.seq > first.snapshot.seq);
              emit(
                {
                  type: "turn.completed",
                  turn: {
                    ...turn,
                    status: "completed",
                    items: [{ ...turn.items[0], text: "前半段，接着完成" }],
                  },
                },
                1,
              );
              const final = await waitForState(
                (state) => reply(state)?.text === "前半段，接着完成",
              );

              const target = { workspacePath: cwd };
              const recoveryChecks = [];
              for (const topic of ["SessionsIndex", "WorkspaceConfig"]) {
                const { ack } = await agent[`subscribe${topic}V4`](target);
                const recovered = await agent[`resync${topic}V4`]({
                  ...target,
                  subscriptionId: ack.subscriptionId,
                  base: null,
                });
                recoveryChecks.push({ initial: ack, recovered: recovered.ack });
                await agent[`unsubscribe${topic}V4`]({
                  ...target,
                  subscriptionId: ack.subscriptionId,
                });
              }
              await store.close();
              const expired = await agent
                .resyncConversationV4({
                  ...target,
                  subscriptionId: first.subscriptionId,
                  base: null,
                })
                .then(
                  () => "unexpected success",
                  (error) => error.message,
                );
              return {
                first: first.subscriptionId,
                final: final.subscriptionId,
                status: final.status,
                replyState: reply(final).state,
                recoveryChecks,
                expired,
              };
            } finally {
              layer.dispose();
              workspace.dispose();
            }
          },
          `/@fs/${resolve(repo, "packages/ui/src/v4").slice(1)}`,
        );
        assert.equal(result.final, result.first);
        assert.equal(result.status, "live");
        assert.equal(result.replyState, "complete");
        for (const { initial, recovered } of result.recoveryChecks)
          assert.deepEqual(recovered, { ...initial, mode: "snapshot" });
        assert.match(result.expired, /fault\.subscription\.notOwned/);
        process.stdout.write(`PASS replayable conversation resync (${viewport.width}px)\n`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
} finally {
  await vite.close();
}
