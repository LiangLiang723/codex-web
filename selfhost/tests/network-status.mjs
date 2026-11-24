import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const web = resolve(import.meta.dirname, "../../packages/web");
const target = process.env.SELFHOST_NETWORK_TEST_URL;
const vite = target
  ? null
  : await createServer({
      root: web,
      configFile: resolve(web, "vite.config.ts"),
      mode: "selfhost",
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, hmr: false },
    });
const hostId = 1;
const threadId = "network-fixture";
const turnId = "turn-network-fixture";
const cwd = "/network-fixture";
const project = { hostId, remotePath: cwd, name: "Network Fixture" };
const host = {
  id: hostId,
  name: "Test Mac",
  sshHost: "fixture",
  username: null,
  port: null,
  authMode: "agent",
};
const model = {
  id: "test-model",
  model: "test-model",
  displayName: "Test Model",
  isDefault: true,
  defaultReasoningEffort: "low",
  supportedReasoningEfforts: [{ reasoningEffort: "low" }],
};
const thread = {
  id: threadId,
  cwd,
  name: "网络提示测试",
  createdAt: 1,
  updatedAt: 2,
  status: { type: "active" },
};
const timedOut = {
  message: "stream disconnected before completion",
  codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
  additionalDetails: "operation timed out",
};

async function verifyNetworkStatus(page, origin) {
  const turn = {
    id: turnId,
    status: "inProgress",
    items: [
      { id: "prompt", type: "userMessage", content: [{ type: "text", text: "测试模型连线" }] },
    ],
  };
  const commands = [];
  const errors = [];
  let eventId = 0;
  let recoveryEvent = null;
  let socket;
  let hostSubscribed = false;
  let pendingReady;
  let holdReady = false;
  let losePong = false;
  const retry = (message, id = turnId) => ({
    type: "error.reported",
    params: { threadId, turnId: id, willRetry: true, error: { message } },
  });
  const emit = (event) => {
    const envelope = {
      id: ++eventId,
      hostId,
      threadId,
      createdAt: new Date().toISOString(),
      event,
    };
    socket.send(JSON.stringify({ type: "thread.event", event: envelope }));
    return envelope;
  };
  const sendHost = (status, id = hostId) => {
    assert(hostSubscribed);
    socket.send(JSON.stringify({ type: "host.lifecycle", event: { hostId: id, status } }));
  };
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("selfhost.auth", "network-test-fixture");
    localStorage.setItem("zcode-locale-preference", "zh-CN");
  });
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    const request = route.request().postDataJSON();
    const responses = {
      "/api/hosts": [host],
      "/api/selfhost/projects": url.searchParams.get("organization")
        ? { items: [project], memberships: { [threadId]: cwd } }
        : [project],
      "/api/threads": { data: [thread], nextCursor: null },
      "/api/models": { data: [model], nextCursor: null },
      "/api/selfhost/settings": { locale: "zh-CN" },
      "/api/selfhost/capability": { value: [] },
      "/api/selfhost/organization":
        request?.channel === "task-groups"
          ? { value: { revision: 0, members: [], groups: [], order: [] } }
          : { value: [] },
      "/api/selfhost/workspace":
        request?.channel === "system"
          ? { value: { homedir: "/fixture-home", platform: "darwin" } }
          : { value: [] },
    };
    return route.fulfill({ json: responses[url.pathname] ?? {} });
  });
  await page.routeWebSocket("**/api/realtime", (ws) => {
    socket = ws;
    hostSubscribed = false;
    ws.onMessage((data) => {
      const call = JSON.parse(data);
      commands.push(call);
      const reply = (message) => ws.send(JSON.stringify({ ...message, requestId: call.requestId }));
      switch (call.type) {
        case "auth.authenticate":
          if (holdReady) pendingReady = () => reply({ type: "ready" });
          else reply({ type: "ready" });
          break;
        case "thread.activate":
          reply({
            type: "thread.snapshot",
            thread,
            history: { thread: { ...thread, turns: [turn] } },
            recentEvents: recoveryEvent ? [recoveryEvent] : [],
            lastEventId: eventId,
            eventEpoch: "test-epoch",
          });
          break;
        case "project.defaults.read":
          reply({ defaults: { model: model.model } });
          break;
        case "host.lifecycle.subscribe":
          hostSubscribed = true;
          break;
        case "ping":
          if (!losePong) reply({ type: "pong", nonce: call.nonce });
          break;
        default:
          if (call.requestId) reply({ type: "test.result" });
      }
    });
  });

  const url = new URL("/", origin);
  url.search = new URLSearchParams({ host: String(hostId), cwd, thread: threadId });
  await page.goto(url.href);
  await page
    .getByText("测试模型连线", { exact: true })
    .waitFor({ timeout: 20000 })
    .catch(async (error) => {
      throw new Error(
        `${error.message}\n${(await page.locator("body").innerText()).slice(0, 600)}\n${commands.map(({ type }) => type).join(", ")}\n${errors.join("\n")}`,
        { cause: error },
      );
    });
  emit(retry("Reconnecting... 2/5", "older-turn"));
  recoveryEvent = emit(retry("Reconnecting... 2/5"));
  const counter = page.getByText("正在重新连接模型… 2/5", { exact: true });
  await counter.waitFor({ timeout: 7000 });

  const webNotice = page.getByText("网页连接已断开，正在自动重连…", { exact: true });
  holdReady = true;
  await socket.close({ code: 1001, reason: "fixture disconnect" });
  await webNotice.waitFor();
  await waitForReadyRequest();
  holdReady = false;
  pendingReady();
  await webNotice.waitFor({ state: "hidden" });
  await counter.waitFor();
  await page.reload();
  await counter.waitFor();

  recoveryEvent = emit(retry("Stream was interrupted"));
  const countFree = page.getByText("正在重新连接模型…", { exact: true });
  await countFree.waitFor();
  emit(retry("Reconnecting... 3/5", "older-turn"));
  await page.getByText("正在重新连接模型… 3/5", { exact: true }).waitFor({ state: "hidden" });
  recoveryEvent = emit({
    type: "notice",
    source: "warning",
    params: { threadId, message: "Falling back from WebSockets to HTTPS transport. fixture" },
  });
  const fallback = page.getByText("已切换到 HTTPS，正在连接模型…", { exact: true });
  await fallback.waitFor();
  recoveryEvent = null;
  emit({
    type: "timeline.item.delta",
    turnId,
    itemId: "answer",
    channel: "agentMessage",
    delta: "部分回复",
  });
  await page.getByText("部分回复", { exact: true }).waitFor();
  await fallback.waitFor({ state: "hidden" });
  turn.items.push({ id: "answer", type: "agentMessage", text: "部分回复" });
  turn.status = "failed";
  turn.error = timedOut;
  emit({ type: "turn.completed", turn });
  const failed = page.getByText("模型连接超时，回复未完成。你可以重新发送消息。", { exact: true });
  await failed.waitFor();
  await page.reload();
  await failed.waitFor();
  await page.getByText("部分回复", { exact: true }).waitFor();

  const hostFailure = page.getByText("SSH 主机 Test Mac 连接失败。", { exact: true });
  sendHost("failed", 2);
  sendHost("connecting");
  await page.getByText("正在连接 SSH 主机 Test Mac…", { exact: true }).waitFor();
  await hostFailure.waitFor({ state: "hidden" });
  sendHost("failed");
  await hostFailure.waitFor();
  sendHost("connected", 2);
  sendHost("failed");
  await hostFailure.waitFor();
  sendHost("connected");
  await hostFailure.waitFor({ state: "hidden" });

  holdReady = true;
  losePong = true;
  pendingReady = undefined;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await webNotice.waitFor({ timeout: 10000 });
  await waitForReadyRequest();
  holdReady = false;
  losePong = false;
  pendingReady();
  await webNotice.waitFor({ state: "hidden" });
  await failed.waitFor();
  assert.equal(commands.filter((call) => call.type === "turn.start").length, 0);
  assert.deepEqual(errors, []);

  async function waitForReadyRequest() {
    const deadline = Date.now() + 10000;
    while (!pendingReady && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    assert(pendingReady, "Expected the browser to reconnect");
  }
}

try {
  await vite?.listen();
  const origin = target ?? vite.resolvedUrls.local[0];
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    for (const width of [1480, 390]) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        isMobile: width < 600,
        hasTouch: width < 600,
      });
      try {
        await verifyNetworkStatus(page, origin);
        console.log(`${width}px model, WebSocket and SSH connection status passed`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
} finally {
  await vite?.close();
}
