import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { build, preview } from "vite";

const web = resolve(import.meta.dirname, "../../packages/web");
const cwd = "/turn-fixture";
const threadId = "thread-file-cards";
const hostId = 1;
const host = {
  id: hostId,
  name: "Fixture",
  sshHost: "fixture",
  username: null,
  port: null,
  authMode: "agent",
};
const model = {
  id: "fixture-model",
  model: "fixture-model",
  displayName: "Fixture",
  isDefault: true,
  defaultReasoningEffort: "low",
  supportedReasoningEfforts: [{ reasoningEffort: "low" }],
};
const thread = {
  id: threadId,
  name: "逐轮文件",
  cwd,
  status: { type: "idle" },
  createdAt: 1,
  updatedAt: 2,
};
const patch = "@@ -1 +1 @@\n-old line\n+new line\n";
const turn = (id, path) => ({
  id,
  status: "completed",
  items: [
    { id: `${id}-user`, type: "userMessage", content: [{ type: "text", text: `请处理 ${id}` }] },
    {
      id: `${id}-edit`,
      type: "fileChange",
      status: "completed",
      changes: [{ path: `${cwd}/${path}`, kind: { type: "update" }, diff: patch }],
    },
    { id: `${id}-answer`, type: "agentMessage", text: `完成 ${id}` },
  ],
});

async function verify(page, origin) {
  let reverted = false;
  let conflict = true;
  let committed = false;
  let publishCompletion;
  const initialLookup = Promise.withResolvers();
  const operations = [];
  await page.addInitScript(() => {
    localStorage.setItem("selfhost.auth", "turn-files-fixture");
    localStorage.setItem("zcode-locale-preference", "zh-CN");
  });
  await page.route(new URL("/api/**", origin).href, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const body = request.postDataJSON();
    if (path === "/api/selfhost/turn-files") {
      assert.equal(body.hostId, hostId);
      assert.equal(body.threadId, threadId);
      assert.equal(body.cwd, cwd);
      operations.push(body);
      const summary = { files: 1, additions: 1, deletions: 1 };
      const details = {
        ...summary,
        items: [
          {
            path: `${cwd}/recent-file.ts`,
            additions: 1,
            deletions: 1,
            writeCount: 1,
            toolNames: ["apply_patch"],
            patches: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: ["-old line", "+new line"],
              },
            ],
          },
        ],
      };
      const safe = { path: `${cwd}/recent-file.ts`, operationCount: 1, toolNames: ["apply_patch"] };
      const valid = {
        canApply: true,
        ignoredFiles: [],
        safeFiles: [{ ...safe, action: "restore" }],
        unsafeFiles: [],
      };
      if (body.operation === "summaries" && !committed) {
        await route.fulfill({ json: { summaries: {} } });
        initialLookup.resolve();
        return;
      }
      if (body.operation === "summaries")
        return route.fulfill({
          json: {
            summaries: {
              recent: { ...summary, eligible: true, ...(reverted ? { state: "reverted" } : {}) },
            },
          },
        });
      assert.equal(
        body.turnId,
        "recent",
        "The selected turn, not the rest of the transcript, owns the operation",
      );
      if (body.operation === "details") return route.fulfill({ json: { details } });
      if (body.operation === "preview") return route.fulfill({ json: { preview: valid } });
      assert.equal(body.operation, "apply");
      assert(typeof body.commandId === "string" && body.commandId.length > 0);
      if (conflict) {
        conflict = false;
        return route.fulfill({
          json: {
            applied: false,
            response: "recent-file.ts: 外部修改",
            preview: {
              canApply: false,
              ignoredFiles: [],
              safeFiles: [],
              unsafeFiles: [{ ...safe, reason: "external_modified" }],
            },
          },
        });
      }
      reverted = true;
      return route.fulfill({ json: { applied: true, response: "已撤销", preview: valid } });
    }
    const responses = {
      "/api/hosts": [host],
      "/api/selfhost/projects": url.searchParams.has("organization")
        ? {
            items: [{ hostId, remotePath: cwd, name: "Fixture" }],
            memberships: { [threadId]: cwd },
          }
        : [{ hostId, remotePath: cwd, name: "Fixture" }],
      "/api/threads": { data: [thread], nextCursor: null },
      "/api/models": { data: [model], nextCursor: null },
      "/api/selfhost/settings": { locale: "zh-CN" },
      "/api/selfhost/capability": { value: [] },
      "/api/selfhost/organization": {
        value:
          body?.channel === "task-groups"
            ? { revision: 0, members: [], groups: [], order: [] }
            : [],
      },
      "/api/selfhost/workspace": {
        value: body?.channel === "system" ? { homedir: cwd, platform: "linux" } : [],
      },
    };
    return route.fulfill({ json: responses[path] ?? {} });
  });
  await page.routeWebSocket("**/api/realtime", (socket) => {
    publishCompletion = () =>
      socket.send(
        JSON.stringify({
          type: "thread.event",
          eventEpoch: "turn-files-fixture",
          event: {
            id: 1,
            hostId,
            threadId,
            event: { type: "turn.completed", turn: turn("recent", "recent-file.ts") },
          },
        }),
      );
    socket.onMessage((data) => {
      const call = JSON.parse(data);
      const reply = (message) =>
        socket.send(JSON.stringify({ ...message, requestId: call.requestId }));
      if (call.type === "auth.authenticate") reply({ type: "ready" });
      else if (call.type === "thread.native.controls")
        reply({
          type: "thread.native.controls.result",
          queue: false,
          fork: false,
          compact: false,
          queued: [],
        });
      else if (call.type === "thread.activate")
        reply({
          type: "thread.snapshot",
          thread,
          lastEventId: 0,
          eventEpoch: "turn-files-fixture",
          history: {
            thread: {
              ...thread,
              turns: [turn("older", "older-file.ts"), turn("recent", "recent-file.ts")],
            },
          },
        });
      else if (call.type === "project.defaults.read") reply({ defaults: { model: model.model } });
      else if (call.type === "ping") reply({ type: "pong", nonce: call.nonce });
      else if (call.requestId) reply({ type: "fixture.result" });
    });
  });
  await page.goto(
    new URL("/?" + new URLSearchParams({ host: String(hostId), cwd, thread: threadId }), origin)
      .href,
  );
  const expand = page.getByRole("button", { name: "展开已更改文件" });
  try {
    await expand.nth(1).waitFor();
  } catch (error) {
    throw Error(await page.locator("body").innerText(), { cause: error });
  }
  await initialLookup.promise;
  committed = true;
  publishCompletion();
  await expand.first().click();
  await page.locator(`[title="${cwd}/older-file.ts"]`).first().waitFor();
  assert.equal(operations.filter(({ operation }) => operation === "details").length, 0);
  await expand.first().click();
  await page.locator(`[title="${cwd}/recent-file.ts"]`).first().waitFor();
  const undo = page.getByRole("button", { name: "撤销", exact: true }).last();
  await undo.click();
  const dialog = page.getByRole("dialog");
  const confirm = dialog.getByRole("button", { name: "撤销文件", exact: true });
  await confirm.click();
  await dialog.getByText(/recent-file.ts: 外部修改/).waitFor();
  await confirm.click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByText("已撤销", { exact: true }).waitFor();
  await page.reload();
  await page.getByText("已撤销", { exact: true }).waitFor();
  await page.getByText("完成 older", { exact: true }).waitFor();
  await page.getByText("完成 recent", { exact: true }).waitFor();
}

const target = process.env.SELFHOST_TURN_FILES_TEST_URL;
const outDir = target ? null : await mkdtemp(join(tmpdir(), "selfhost-turn-cards-"));
let server;
try {
  if (outDir) {
    const config = {
      root: web,
      configFile: resolve(web, "vite.config.ts"),
      mode: "selfhost",
      logLevel: "error",
      build: { outDir },
    };
    await build(config);
    server = await preview({ ...config, preview: { host: "127.0.0.1", port: 0 } });
  }
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    for (const width of [1480, 390]) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        isMobile: width < 600,
      });
      page.setDefaultTimeout(10000);
      await verify(page, target ?? server.resolvedUrls.local[0]);
      await page.close();
      console.log(`PASS isolated per-turn file card, conflict, rewind and reload (${width}px)`);
    }
  } finally {
    await browser.close();
  }
} finally {
  await server?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
}
