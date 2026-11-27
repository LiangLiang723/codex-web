import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { build, preview } from "vite";
import { browserStateFixture } from "./fixtures/browser-state.mjs";

const web = resolve(import.meta.dirname, "../../packages/web");
const hostId = 1;
const cwd = "/followup-fixture";
const threadId = "11111111-1111-4111-8111-111111111111";
const timestamp = Math.floor(Date.now() / 1000);
const thread = {
  id: threadId,
  name: "Follow-up fixture",
  cwd,
  createdAt: timestamp,
  updatedAt: timestamp,
  status: { type: "active" },
};
const project = { hostId, remotePath: cwd, name: "Fixture" };
const model = {
  id: "fixture",
  model: "fixture",
  displayName: "Fixture",
  isDefault: true,
  defaultReasoningEffort: "low",
  supportedReasoningEfforts: [{ reasoningEffort: "low" }],
};

async function verify(page, origin, mobile) {
  let currentTurn = { id: "running-turn", status: "inProgress", items: [] };
  let queueAvailable = true;
  let rejectSteer = false;
  let eventId = 0;
  let socket;
  const submissions = [];
  const queued = [];
  const turns = [currentTurn];
  const settings = { locale: "zh-CN", zcodeInteractionBehavior: "queue" };
  const event = (value) =>
    socket.send(
      JSON.stringify({
        type: "thread.event",
        eventEpoch: "followup-epoch",
        event: {
          hostId,
          threadId,
          id: ++eventId,
          createdAt: new Date().toISOString(),
          event: value,
        },
      }),
    );

  await page.addInitScript(() => {
    localStorage.setItem("selfhost.auth", "fixture");
    localStorage.setItem("zcode-locale-preference", "zh-CN");
  });
  await page.route(new URL("/api/**", origin).href, (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postDataJSON();
    if (url.pathname === "/api/selfhost/settings" && request.method() === "PATCH")
      Object.assign(settings, body);
    const responses = {
      "/api/auth/me": { id: 1, username: "fixture" },
      "/api/hosts": [
        {
          id: hostId,
          name: "Fixture",
          sshHost: "fixture",
          username: "fixture",
          port: 22,
          authMode: "agent",
        },
      ],
      "/api/selfhost/projects": url.searchParams.has("organization")
        ? { items: [project], memberships: { [threadId]: cwd } }
        : [project],
      "/api/projects": [project],
      "/api/threads": { data: [thread], nextCursor: null },
      "/api/selfhost/thread-summary": { thread },
      "/api/models": { data: [model], nextCursor: null },
      "/api/selfhost/settings": settings,
      "/api/selfhost/capability": { value: [] },
      "/api/selfhost/workspace": { value: { homedir: cwd, platform: "linux" } },
      "/api/selfhost/organization": {
        value:
          body?.channel === "task-groups"
            ? { revision: 0, members: [], groups: [], order: [] }
            : [],
      },
    };
    return route.fulfill({ json: responses[url.pathname] ?? {} });
  });
  const theme = mobile ? "zai-light" : "zai-dark";
  await page.route(
    new URL("/api/selfhost/browser-state", origin).href,
    browserStateFixture({ "zcode-theme": theme }),
  );
  await page.routeWebSocket("**/api/realtime", (ws) => {
    socket = ws;
    ws.onMessage((raw) => {
      const call = JSON.parse(raw);
      const reply = (data) =>
        ws.send(JSON.stringify({ type: "fixture.result", requestId: call.requestId, ...data }));
      const userMessage = (turnId) => ({
        id: call.deliveryId,
        type: "userMessage",
        clientId: call.deliveryId,
        turnId,
        content: [{ type: "text", text: call.text }],
      });
      switch (call.type) {
        case "auth.authenticate":
          return reply({ type: "ready" });
        case "thread.activate":
          return reply({
            thread,
            history: { thread: { ...thread, turns } },
            lastEventId: eventId,
            eventEpoch: "followup-epoch",
          });
        case "project.defaults.read":
          return reply({ defaults: { model: model.id } });
        case "thread.native.controls":
          return reply({ queue: queueAvailable, queued });
        case "thread.goal.get":
          return reply({ goal: null });
        case "thread.queue.add":
          submissions.push(call);
          queued.push({
            id: call.deliveryId,
            clientUserMessageId: call.deliveryId,
            input: [{ type: "text", text: call.text }],
          });
          return reply({ state: "accepted", delivery: "queue" });
        case "turn.steer": {
          submissions.push(call);
          if (rejectSteer) {
            currentTurn.status = "completed";
            event({ type: "turn.completed", turn: currentTurn });
            currentTurn = { id: "replacement-turn", status: "inProgress", items: [] };
            turns.push(currentTurn);
            event({ type: "turn.started", turn: currentTurn });
            return reply({ state: "rejected", delivery: "guide" });
          }
          const item = userMessage(currentTurn.id);
          currentTurn.items.push(item);
          event({ type: "timeline.item.upsert", item });
          return reply({ state: "accepted", delivery: "guide", turnId: currentTurn.id });
        }
        case "turn.start": {
          submissions.push(call);
          const turn = {
            id: "fresh-turn",
            status: "completed",
            items: [userMessage("fresh-turn")],
          };
          turns.push(turn);
          event({ type: "turn.completed", turn });
          return reply({ state: "accepted", delivery: "startNow", turnId: turn.id });
        }
        case "turn.interrupt":
          submissions.push(call);
          return reply({});
        case "ping":
          return reply({ type: "pong", nonce: call.nonce });
        default:
          if (call.requestId) return reply({});
      }
    });
  });

  const url = new URL("/", origin);
  url.search = new URLSearchParams({ host: String(hostId), cwd, thread: threadId });
  await page.goto(url.href);
  await page.getByTestId("v4-stop").waitFor();
  await page.locator(`html.theme-${theme}`).waitFor();
  const editor = page.getByTestId("v4-composer-input");
  const editable = editor.and(page.locator('[contenteditable="true"]'));
  const options = page.getByRole("button", { name: "发送方式", exact: true });
  const send = page.getByTestId("v4-composer-send");
  const activate = (locator) => (mobile ? locator.tap() : locator.click());
  const type = async (text) => {
    await activate(editable);
    await page.keyboard.insertText(text);
  };
  const choose = async (name) => {
    await activate(options);
    const item = page.getByRole("menuitem", { name, exact: true });
    await item.waitFor();
    const box = await page.getByRole("menu").boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= page.viewportSize().width);
    await activate(item);
  };
  const expectSubmission = (type, text, expectedTurnId) => {
    const call = submissions.at(-1);
    assert.equal(call.type, type);
    assert.equal(call.text, text);
    assert.equal(call.threadId, threadId);
    assert.equal(call.expectedTurnId, expectedTurnId);
    assert.ok(call.deliveryId);
  };
  const expectDelivered = async (text) => {
    await editor.getByText(text, { exact: true }).waitFor({ state: "hidden" });
    await page.getByText(text, { exact: true }).waitFor();
  };

  await type("Wait for this turn");
  await activate(page.getByRole("button", { name: "加入队列", exact: true }));
  await expectDelivered("Wait for this turn");
  expectSubmission("thread.queue.add", "Wait for this turn");

  await type("Guide this turn");
  await choose("引导当前任务");
  await expectDelivered("Guide this turn");
  expectSubmission("turn.steer", "Guide this turn", "running-turn");
  assert.equal(await page.getByText("Wait for this turn", { exact: true }).count(), 1);

  if (!mobile) {
    const platform = await page.evaluate(() => navigator.platform);
    await type("Steer via shortcut");
    await editor.press(platform.includes("Mac") ? "Meta+Enter" : "Control+Enter");
    await expectDelivered("Steer via shortcut");
    expectSubmission("turn.steer", "Steer via shortcut", "running-turn");
  }

  rejectSteer = true;
  await type("Keep my stale draft");
  await choose("引导当前任务");
  await page.getByText("Codex 拒绝了本次输入。请检查当前轮次后继续。", { exact: true }).waitFor();
  assert.equal(await editor.innerText(), "Keep my stale draft");
  expectSubmission("turn.steer", "Keep my stale draft", "running-turn");
  rejectSteer = false;
  await choose("引导当前任务");
  await expectDelivered("Keep my stale draft");
  expectSubmission("turn.steer", "Keep my stale draft", "replacement-turn");

  if (!mobile) {
    await page.getByTestId("task-settings-button").click();
    await page.locator('[data-settings-section-nav="agentBehavior"]').click();
    await page.getByRole("combobox", { name: "交互行为", exact: true }).click();
    const saved = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/selfhost/settings" &&
        response.request().method() === "PATCH" &&
        response.ok(),
    );
    await page.getByRole("option", { name: "引导", exact: true }).click();
    await saved;
    assert.equal(settings.zcodeInteractionBehavior, "guide");
    await page.goto(url.href);
    await editor.and(page.locator('[aria-placeholder="提出后续修改要求"]')).waitFor();
    await type("Default steer after reload");
    await activate(page.getByRole("button", { name: "引导当前任务", exact: true }));
    await expectDelivered("Default steer after reload");
    expectSubmission("turn.steer", "Default steer after reload", "replacement-turn");
    await type("Queue for one message");
    await choose("加入队列");
    await expectDelivered("Queue for one message");
    expectSubmission("thread.queue.add", "Queue for one message");
    assert.equal(settings.zcodeInteractionBehavior, "guide");
  }

  queueAvailable = false;
  await page.reload();
  await type("Legacy host steers");
  await activate(page.getByRole("button", { name: "引导当前任务", exact: true }));
  await expectDelivered("Legacy host steers");
  expectSubmission("turn.steer", "Legacy host steers", "replacement-turn");
  assert.equal(await options.count(), 0);

  currentTurn.status = "completed";
  event({ type: "turn.completed", turn: currentTurn });
  await page.getByRole("button", { name: "发送", exact: true }).waitFor();
  assert.equal(await send.getAttribute("aria-label"), "发送");
  assert.equal(await options.count(), 0);
  assert.ok(submissions.every(({ type }) => type === "turn.steer" || type === "thread.queue.add"));
  await type("Start after the active turn ends");
  await activate(send);
  await expectDelivered("Start after the active turn ends");
  expectSubmission("turn.start", "Start after the active turn ends");
}

const target = process.env.SELFHOST_FOLLOWUP_TEST_URL;
const outDir = target ? null : await mkdtemp(join(tmpdir(), "selfhost-followup-"));
let server;
try {
  if (outDir) {
    const config = { root: web, mode: "selfhost", logLevel: "error", build: { outDir } };
    await build(config);
    server = await preview({ ...config, preview: { host: "127.0.0.1", port: 0 } });
  }
  const origin = target ?? server.resolvedUrls.local[0];
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    for (const width of [1240, 390]) {
      const mobile = width === 390;
      const page = await browser.newPage({
        viewport: { width, height: 820 },
        isMobile: mobile,
        hasTouch: mobile,
      });
      page.setDefaultTimeout(30000);
      try {
        await verify(page, origin, mobile);
        console.log(`PASS self-hosted follow-up delivery at ${width}px`);
      } catch (error) {
        console.error(
          await page
            .locator("body")
            .innerText({ timeout: 3000 })
            .catch(() => ""),
        );
        throw error;
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
} finally {
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  if (outDir) await rm(outDir, { recursive: true, force: true });
}
