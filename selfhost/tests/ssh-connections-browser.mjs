import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const web = resolve(import.meta.dirname, "../../packages/web");
const target = process.env.SELFHOST_SSH_TEST_URL;
const vite = target
  ? null
  : await createServer({
      root: web,
      configFile: resolve(web, "vite.config.ts"),
      mode: "selfhost",
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, hmr: false },
    });
const hosts = [
  {
    id: 1,
    name: "原工作区 · 用于验收侧栏顶部长名称的远程开发主机",
    sshHost: "source",
    authMode: "agent",
  },
  { id: 2, name: "待切换主机", sshHost: "target", authMode: "agent" },
].map((host) => ({ ...host, username: "fixture", port: 22 }));
const projects = hosts.map(({ id }) => ({
  hostId: id,
  remotePath: "/fixture",
  name: `项目 ${id}`,
}));
const thread = {
  id: "ssh-test-thread",
  cwd: "/fixture",
  name: "原对话",
  createdAt: 1,
  updatedAt: 2,
  status: { type: "idle" },
};
const otherThread = { ...thread, id: "ssh-test-other-thread", name: "另一个对话", updatedAt: 3 };
const threads = [thread, otherThread];
const model = {
  id: "fixture-model",
  model: "fixture-model",
  displayName: "Fixture Model",
  isDefault: true,
  defaultReasoningEffort: "low",
  supportedReasoningEfforts: [{ reasoningEffort: "low" }],
};
const button = (scope, name) => scope.getByRole("button", { name, exact: true });

async function verifyDesktopHeader(page, open, previousChat) {
  const separator = page.getByRole("separator", { name: "调整侧边栏宽度" });
  await separator.press("Home");
  await page.waitForFunction(() => {
    const sidebar = document.getElementById("sidebar");
    const separator = document.querySelector('[role="separator"][aria-controls="sidebar"]');
    return (
      Math.round(sidebar?.getBoundingClientRect().width) ===
      Number(separator?.getAttribute("aria-valuemin"))
    );
  });
  const back = button(page, "后退");
  const forward = button(page, "前进");
  await open.waitFor();
  const [workspace, left, right, sidebar] = await Promise.all([
    open.boundingBox(),
    back.boundingBox(),
    forward.boundingBox(),
    page.locator("#sidebar").boundingBox(),
  ]);
  assert.ok(workspace && left && right && sidebar);
  assert.ok(workspace.x + workspace.width <= left.x && left.x + left.width <= right.x);
  assert.ok(workspace.y <= left.y && left.y === right.y && left.y < workspace.y + workspace.height);
  assert.ok(right.x + right.width <= sidebar.x + sidebar.width);
  assert.ok((await open.getAttribute("aria-label")).includes(hosts[0].name));
  assert.ok(
    await open
      .getByText(hosts[0].name, { exact: true })
      .evaluate((label) => label.scrollWidth > label.clientWidth),
  );
  const otherChat = page.getByText("另一对话的历史", { exact: true });
  await page.getByTestId("sidebar").getByText(otherThread.name, { exact: true }).click();
  await otherChat.waitFor();
  await back.click();
  await previousChat.waitFor();
  await forward.click();
  await otherChat.waitFor();
  await back.click();
  await previousChat.waitFor();
}

async function verify(page, origin) {
  page.setDefaultTimeout(20000);
  const drafts = [];
  const commands = [];
  const errors = [];
  const released = Promise.withResolvers();
  let saveCount = 0;
  let socket;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("selfhost.auth", "ssh-test-fixture");
    localStorage.setItem("zcode-locale-preference", "zh-CN");
  });
  await page.route(new URL("/api/**", origin).href, async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/selfhost/ssh-test") {
      const draft = route.request().postDataJSON();
      drafts.push(draft);
      if (draft.host.sshHost === "pending") await released.promise;
      return route
        .fulfill({
          json: {
            status:
              draft.host.sshHost === "denied"
                ? "authentication"
                : draft.host.sshHost === "mfa"
                  ? "mfaRequired"
                  : "connected",
          },
        })
        .catch(() => {});
    }
    if (url.pathname.startsWith("/api/hosts") && route.request().method() !== "GET") saveCount++;
    const hostId = Number(url.searchParams.get("hostId"));
    const request = route.request().postDataJSON();
    const items = projects.filter((p) => !hostId || p.hostId === hostId);
    const values = {
      "/api/hosts": hosts,
      "/api/selfhost/settings": { locale: "zh-CN" },
      "/api/selfhost/thread-summary": {
        thread: threads.find((item) => item.id === url.searchParams.get("threadId")),
      },
      "/api/selfhost/projects": url.searchParams.get("organization")
        ? { items, memberships: Object.fromEntries(threads.map(({ id, cwd }) => [id, cwd])) }
        : items,
      "/api/threads": {
        data: hostId === 2 || url.searchParams.get("archived") === "true" ? [] : threads,
        nextCursor: null,
      },
      "/api/models": { data: [model], nextCursor: null },
      "/api/selfhost/organization": {
        value:
          request?.channel === "task-groups"
            ? { revision: 0, members: [], groups: [], order: [] }
            : [],
      },
      "/api/selfhost/capability": { value: [] },
      "/api/selfhost/workspace": {
        value: request?.channel === "system" ? { homedir: thread.cwd, platform: "darwin" } : [],
      },
    };
    return route.fulfill({ json: values[url.pathname] ?? {} });
  });
  const emitHost = (status, hostId = 2, message) =>
    socket.send(JSON.stringify({ type: "host.lifecycle", event: { hostId, status, message } }));
  await page.routeWebSocket("**/api/realtime", (ws) => {
    socket = ws;
    ws.onMessage((data) => {
      const command = JSON.parse(data);
      const reply = (message) =>
        ws.send(JSON.stringify({ ...message, requestId: command.requestId }));
      if (command.type === "auth.authenticate") return reply({ type: "ready" });
      if (command.type === "ping") return reply({ type: "pong", nonce: command.nonce });
      if (command.type === "host.mfa.connect") {
        commands.push(command.type);
        emitHost("connecting");
        return;
      }
      if (command.type === "host.mfa.cancel") {
        commands.push(command.type);
        emitHost("canceled");
        return;
      }
      if (command.type === "thread.activate") {
        const selected = threads.find((item) => item.id === command.threadId);
        assert.ok(selected);
        return reply({
          type: "thread.snapshot",
          thread: selected,
          history: {
            thread: {
              id: selected.id,
              turns: [
                {
                  id: "turn",
                  status: "completed",
                  items: [
                    {
                      type: "userMessage",
                      id: "prompt",
                      content: [{ type: "text", text: "测试 SSH 工作区切换" }],
                    },
                    {
                      type: "agentMessage",
                      id: "answer",
                      text: selected === thread ? "切换前的对话" : "另一对话的历史",
                    },
                  ],
                },
              ],
            },
          },
          lastEventId: 0,
          eventEpoch: "ssh-fixture",
        });
      }
      if (command.type === "project.defaults.read")
        return reply({ defaults: { model: model.model } });
      if (command.requestId) reply({ type: "fixture.result" });
    });
  });
  await page.goto(new URL("/?host=1&cwd=%2Ffixture&thread=ssh-test-thread", origin).href);
  const previousChat = page.getByText("切换前的对话", { exact: true });
  await previousChat.waitFor({ timeout: 30000 }).catch(async (cause) => {
    throw Error(
      (await page.locator("body").innerText()).slice(0, 1500) + "\n" + errors.join("\n"),
      { cause },
    );
  });
  const open = page.getByTestId("selfhost-workspaces-open");
  if (page.viewportSize().width >= 768) {
    await verifyDesktopHeader(page, open, previousChat);
  } else {
    await button(page, "返回任务首页").click();
    await page
      .getByTestId("sidebar-primary-navigation")
      .getByTestId("selfhost-workspaces-open")
      .waitFor();
    assert.equal(await button(page, "后退").count(), 0);
    assert.equal(await button(page, "前进").count(), 0);
  }
  assert.equal(await open.count(), 1);
  await open.click();
  const catalog = page.getByTestId("selfhost-ssh-catalog");
  await catalog.waitFor();
  assert.equal(new URL(page.url()).searchParams.get("thread"), thread.id);
  await button(catalog, "添加主机").click();
  const form = page.getByTestId("selfhost-ssh-host-form");
  const address = form.locator("[name=address]");
  const test = button(form, "测试连接");
  await address.fill("ssh -p 2201 example@fixture");
  await test.click();
  await form.getByText("SSH 认证成功", { exact: true }).waitFor();
  assert.equal(await address.inputValue(), "fixture");
  assert.equal(await form.locator("[name=user]").inputValue(), "example");
  assert.equal(await form.locator("[name=port]").inputValue(), "2201");
  assert.equal(drafts[0].host.port, 2201);
  assert.equal(await form.locator("[name=fingerprint]").isVisible(), false);
  await button(form, "高级选项").click();
  await form.locator("[name=fingerprint]").waitFor();
  await address.fill("denied");
  await test.click();
  await form.getByText("SSH 认证失败，请检查用户名和认证方式。", { exact: true }).waitFor();
  await address.fill("mfa");
  await test.click();
  await form
    .getByText("主机要求交互验证。请保存后连接，在验证窗口继续。", { exact: true })
    .waitFor();
  await address.fill("pending");
  const testStarted = page.waitForRequest(
    (request) =>
      request.url().endsWith("/api/selfhost/ssh-test") &&
      request.postDataJSON()?.host?.sshHost === "pending",
  );
  try {
    await test.click();
    await testStarted;
    await button(form, "取消测试").click();
    await form.getByText("已取消测试", { exact: true }).waitFor();
  } finally {
    released.resolve();
  }
  await test.waitFor();
  assert.equal(drafts.length, 4, "Clicking Cancel must not submit the same draft again");
  assert.equal(saveCount, 0);
  await button(form, "取消").click();
  await form.waitFor({ state: "hidden" });

  const targetCard = catalog.locator("section").filter({ hasText: hosts[1].name });
  const enter = button(targetCard, "进入工作区");
  await enter.click();
  await button(targetCard, "取消连接").click();
  await catalog.getByText("已取消连接", { exact: true }).waitFor();
  emitHost("connected");
  assert.equal(new URL(page.url()).searchParams.get("host"), "1");
  await button(catalog, "完成").click();
  await catalog.waitFor({ state: "hidden" });
  if (!(await previousChat.isVisible()))
    await page.getByText(thread.name, { exact: true }).first().click();
  await previousChat.waitFor();
  if (!(await open.isVisible())) await button(page, "返回任务首页").click();
  await open.click();
  await enter.click();
  await button(targetCard, "取消连接").waitFor();
  emitHost("failed", 2, "Fixture connection refused");
  await catalog.getByText("Fixture connection refused", { exact: true }).waitFor();
  await enter.click();
  await button(targetCard, "取消连接").waitFor();
  emitHost("connected", 1);
  assert.equal(new URL(page.url()).searchParams.get("host"), "1");
  emitHost("connected");
  await page.waitForURL("**/?host=2&cwd=%2Ffixture");
  assert.deepEqual(commands, [
    "host.mfa.connect",
    "host.mfa.cancel",
    "host.mfa.connect",
    "host.mfa.connect",
  ]);
  assert.deepEqual(errors, []);
}

try {
  await vite?.listen();
  const origin = target ?? vite.resolvedUrls.local[0];
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    for (const width of [1480, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 880 },
        isMobile: width < 768,
        hasTouch: width < 768,
      });
      try {
        await verify(await context.newPage(), origin);
        process.stdout.write(
          `PASS SSH header, draft test, host switch and cancellation at ${width}px\n`,
        );
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
} finally {
  await vite?.close();
}
