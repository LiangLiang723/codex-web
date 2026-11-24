import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

/** Conformance check from ZCode's public nonCliAcpRetirement suite, exercised against a real SSH account. */
export async function verifyNativeRecovery(page, hostId, threadId, readOnly = false) {
  const invalidId = randomUUID();
  const result = await page.evaluate(
    async ({ hostId, threadId, invalidId }) => {
      async function connect() {
        const ws = new WebSocket(
          new URL("/api/realtime", location.href).href.replace(/^http/, "ws"),
        );
        const pending = new Map();
        const ready = new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(Error("Timed out authenticating realtime client"));
            ws.close();
          }, 15000);
          ws.onopen = () => {
            const token = localStorage.getItem("selfhost.auth");
            ws.send(JSON.stringify({ type: "auth.authenticate", token }));
          };
          ws.onerror = () => {
            clearTimeout(timer);
            reject(Error("Realtime connection failed"));
          };
          ws.onmessage = ({ data }) => {
            if (typeof data !== "string") return;
            const message = JSON.parse(data);
            if (message.type === "ready") {
              clearTimeout(timer);
              resolve();
            }
            const finish = pending.get(message.requestId);
            if (finish) {
              pending.delete(message.requestId);
              finish(message);
            }
          };
        });
        await ready;
        return {
          close: () => ws.close(),
          request(type, id) {
            const requestId = String(++connect.sequence);
            return new Promise((resolve, reject) => {
              const timer = setTimeout(() => {
                pending.delete(requestId);
                reject(Error("Native Thread activation timed out"));
              }, 45000);
              pending.set(requestId, (value) => {
                clearTimeout(timer);
                resolve(value);
              });
              ws.send(JSON.stringify({ type, requestId, hostId, threadId: id }));
            });
          },
        };
      }
      connect.sequence = 0;
      const a = await connect();
      let original;
      try {
        original = await a.request("thread.activate", threadId);
      } finally {
        a.close();
      }
      const b = await connect();
      try {
        const missing = await b.request("thread.activate", invalidId);
        const restored = await b.request("thread.activate", threadId);
        const goal = await b.request("thread.goal.get", threadId);
        const complete = (m) =>
          (m.history?.thread?.turns ?? []).filter((t) => t.status === "completed").map((t) => t.id);
        return {
          missingType: missing.type,
          missingHistory: !!missing.history,
          initialId: original.history?.thread?.id,
          reloadedId: restored.history?.thread?.id,
          originalTurns: complete(original),
          restoredTurns: complete(restored),
          readOnly: restored.readOnly,
          goalType: goal.type,
        };
      } finally {
        b.close();
      }
    },
    { hostId, threadId, invalidId },
  );
  assert(result.missingType === "error" || result.missingType.endsWith(".error"));
  assert.equal(result.missingHistory, false);
  assert.equal(result.initialId, threadId);
  assert.equal(result.reloadedId, threadId);
  assert.equal(Boolean(result.readOnly), readOnly);
  if (readOnly) assert.equal(result.goalType, "thread.goal.snapshot");
  assert(result.originalTurns.length > 0, "Select a real Thread containing a completed turn");
  for (const id of result.originalTurns)
    assert(result.restoredTurns.includes(id), "Lost completed native turn " + id);
}
