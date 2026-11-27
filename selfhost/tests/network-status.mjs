import assert from "node:assert/strict";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
  let failCatalog = false;
  let restoreMfaGate = false;
  let skipNextPrompt = false;
  const anotherToken = "another-network-test-fixture";
  const anotherHost = { ...host, name: "Second Account SSH" };
  const anotherCatalogRequested = Promise.withResolvers();
  const anotherCatalogRelease = Promise.withResolvers();
  const anotherStateRelease = Promise.withResolvers();
  const anotherChallengeSent = Promise.withResolvers();
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
  const sendMfa = (id, prompt, instructions) =>
    socket.send(
      JSON.stringify({
        type: "host.mfa.request",
        hostId: id,
        name: id === hostId ? host.name : "Other Host",
        prompts: [{ prompt, echo: false }],
        instructions,
      }),
    );
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    if (!localStorage.getItem("selfhost.auth"))
      localStorage.setItem("selfhost.auth", "network-test-fixture");
  });
  // Vite 的源模块也可能含有 /api/ 目录，只模拟网关的根 API。
  await page.route(new URL("/api/**", origin).href, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/selfhost/browser-state") {
      const locale = { "zcode-locale-preference": "zh-CN" };
      return route.request().headers().authorization === `Bearer ${anotherToken}`
        ? anotherStateRelease.promise.then(() => route.fulfill({ json: locale }))
        : route.fulfill({ json: locale });
    }
    if (
      url.pathname === "/api/hosts" &&
      route.request().headers().authorization === `Bearer ${anotherToken}`
    ) {
      anotherCatalogRequested.resolve();
      return anotherCatalogRelease.promise.then(() => route.fulfill({ json: [anotherHost] }));
    }
    if (failCatalog && url.pathname === "/api/hosts")
      return route.fulfill({ status: 503, json: { message: "fixture catalog offline" } });
    const request = route.request().postDataJSON();
    const responses = {
      "/api/hosts": [host],
      "/api/selfhost/projects": url.searchParams.get("organization")
        ? { items: [project], memberships: { [threadId]: cwd } }
        : [project],
      "/api/threads": {
        data: url.searchParams.get("archived") === "true" ? [] : [thread],
        nextCursor: null,
      },
      "/api/selfhost/thread-summary": { thread },
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
          if (call.token === anotherToken) {
            reply({ type: "ready" });
            sendMfa(
              hostId,
              "Second account verification code",
              "Challenge for the second account.",
            );
            anotherChallengeSent.resolve();
          } else if (holdReady) pendingReady = () => reply({ type: "ready" });
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
          if (restoreMfaGate) sendHost("mfaRequired");
          break;
        case "host.mfa.connect":
          assert.deepEqual(call, { type: "host.mfa.connect", hostId });
          sendHost("connecting");
          if (skipNextPrompt) sendHost("connected");
          else
            sendMfa(
              hostId,
              "Fixture SSH verification code",
              "Authentication is required by this SSH host.",
            );
          break;
        case "host.mfa.cancel":
          assert.deepEqual(call, { type: "host.mfa.cancel", hostId });
          sendHost("mfaRequired");
          break;
        case "host.mfa.submit":
          assert.deepEqual(call, { type: "host.mfa.submit", hostId, code: "fixture-auth-answer" });
          sendHost("connected");
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
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  await page
    .getByText("测试模型连线", { exact: true })
    .waitFor({ timeout: 60000 })
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
  await page.reload({ waitUntil: "domcontentloaded" });
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
  await page.reload({ waitUntil: "domcontentloaded" });
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

  sendMfa(2, "Foreign host code", "Foreign host instructions");
  restoreMfaGate = true;
  await page.reload({ waitUntil: "domcontentloaded" });
  const mfaConnect = page.getByTestId("selfhost-ssh-connect");
  const mfaDialog = page.getByTestId("selfhost-ssh-mfa-dialog");
  const mfaAnswer = mfaDialog.getByLabel("Fixture SSH verification code", { exact: true });
  await mfaConnect.waitFor();
  assert.equal(commands.filter(({ type }) => type === "host.mfa.connect").length, 0);
  sendMfa(2, "Foreign host code", "Foreign host instructions");
  await mfaConnect.click();
  await mfaDialog
    .getByText("Authentication is required by this SSH host.", { exact: true })
    .waitFor();
  await mfaAnswer.waitFor();
  assert.equal(await mfaAnswer.getAttribute("type"), "password");
  await mfaAnswer.fill("discarded-fixture-answer");
  await mfaDialog.getByRole("button", { name: "取消", exact: true }).click();
  await mfaDialog.waitFor({ state: "hidden" });
  await mfaConnect.click();
  await mfaAnswer.waitFor();
  assert.equal(await mfaAnswer.inputValue(), "");
  await mfaAnswer.fill("fixture-auth-answer");
  await mfaDialog.getByRole("button", { name: "确认", exact: true }).click();
  await mfaDialog.waitFor({ state: "hidden" });
  await page.getByText("正在连接 SSH 主机 Test Mac…", { exact: true }).waitFor({ state: "hidden" });
  assert.deepEqual(
    commands.filter(({ type }) => type.startsWith("host.mfa.")).map(({ type }) => type),
    ["host.mfa.connect", "host.mfa.cancel", "host.mfa.connect", "host.mfa.submit"],
  );
  assert.equal(
    await page.evaluate(() => JSON.stringify(localStorage).includes("fixture-auth-answer")),
    false,
  );
  skipNextPrompt = true;
  sendHost("mfaRequired");
  await mfaConnect.click();
  await mfaConnect.waitFor({ state: "hidden" });
  await mfaDialog.waitFor({ state: "hidden" });
  restoreMfaGate = false;

  failCatalog = true;
  const failedRefresh = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/hosts" && response.status() === 503,
  );
  socket.send(JSON.stringify({ type: "config.catalog.changed" }));
  await failedRefresh;
  await page.getByText("fixture catalog offline", { exact: false }).first().waitFor();
  await page.getByText("部分回复", { exact: true }).waitFor();
  failCatalog = false;
  socket.send(JSON.stringify({ type: "config.catalog.changed" }));
  await page
    .getByText("fixture catalog offline", { exact: false })
    .first()
    .waitFor({ state: "hidden" });

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

  sendMfa(hostId, "Fixture SSH verification code", "Switching accounts clears this form.");
  await mfaAnswer.fill("unsent-fixture-answer");
  const repliesBeforeSwitch = commands.filter(
    ({ type }) => type === "host.mfa.submit" || type === "host.mfa.cancel",
  ).length;
  await page.evaluate((newValue) => {
    const key = "selfhost.auth";
    const oldValue = localStorage.getItem(key);
    localStorage.setItem(key, newValue);
    window.dispatchEvent(new StorageEvent("storage", { key, oldValue, newValue }));
  }, anotherToken);
  try {
    await Promise.race([
      Promise.all([anotherCatalogRequested.promise, anotherChallengeSent.promise]),
      delay(30000, undefined, { ref: false }).then(() => {
        throw Error("The second account did not request its host catalog and receive a challenge");
      }),
    ]);
    anotherStateRelease.resolve();
    await page.getByText("正在读取服务器配置…", { exact: true }).waitFor();
    assert.equal(await mfaDialog.count(), 0);
  } finally {
    anotherStateRelease.resolve();
    anotherCatalogRelease.resolve();
  }
  await mfaDialog
    .getByText(`SSH 主机 ${anotherHost.name} 需要多因素验证。`, { exact: true })
    .waitFor();
  assert.equal(await mfaDialog.getByLabel("Second account verification code").inputValue(), "");
  assert.equal(
    commands.filter(({ type }) => type === "host.mfa.submit" || type === "host.mfa.cancel").length,
    repliesBeforeSwitch,
  );
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
      page.setDefaultTimeout(30000);
      page.setDefaultNavigationTimeout(60000);
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
