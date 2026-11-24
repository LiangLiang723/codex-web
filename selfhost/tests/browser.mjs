import { verifyElicitation } from "./elicitation.mjs";
import { verifyWorkspaceIdentity } from "./workspace-identity.mjs";
import { verifyAccount } from "./account.mjs";
import { verifyNativeRecovery } from "./native-history.mjs";
import { composerPicker, revealPickerOption } from "./fixtures/composer-picker.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { randomInt, randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import { setTimeout as delay } from "node:timers/promises";

const base = new URL(process.env.SELFHOST_TEST_URL).origin;
const username = process.env.SELFHOST_TEST_USER || "admin";
const qaPassword = (await readFile(process.env.SELFHOST_TEST_PASSWORD_FILE, "utf8")).trim();
const thread = process.env.SELFHOST_TEST_THREAD,
  hostId = Number(process.env.SELFHOST_TEST_HOST || 1),
  cwd = process.env.SELFHOST_TEST_CWD;
const server = await chromium.launchServer({
  channel: process.env.SELFHOST_TEST_BROWSER || "chrome",
  headless: true,
});
const browser = await chromium.connect(server.wsEndpoint());
const faults = (page) =>
  page.getByText(/^(这块界面出了点问题|应用界面出了点问题|useZCodeIntl 必须在)/);
const button = (page, name) => page.getByRole("button", { name, exact: true });
async function verify(page) {
  assert.equal(await faults(page).count(), 0, "ZCode error boundary appeared");
}
async function login(page) {
  await page.goto(base + "/?manage=1");
  await page.locator("[name=username]").fill(username);
  await page.locator("[name=password]").fill(qaPassword);
  await button(page, "登录").click();
  await button(page, "添加主机").waitFor();
}
async function api(page, path, body) {
  return page.evaluate(
    async ({ path, body }) => {
      const r = await fetch(path, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: "Bearer " + localStorage.getItem("selfhost.auth"),
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!r.ok) throw Error(path + " " + r.status);
      return r.json();
    },
    { path, body },
  );
}
async function dismiss(page) {
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await verify(page);
}
async function catalog(page, mutation) {
  const hosts = await api(page, "/api/hosts");
  const host = hosts.find((h) => h.id === hostId);
  assert(host, "Select an existing real test host");
  const card = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: host.name, exact: true }) });
  await button(page, "添加主机").click();
  let dialog = page.getByRole("dialog");
  await dialog.getByRole("heading", { name: "添加 SSH 主机" }).waitFor();
  const mode = dialog.locator("select").first();
  await mode.selectOption("privateKey");
  assert(await dialog.locator("textarea").isVisible());
  await mode.selectOption("password");
  assert(await dialog.locator("input[name=password]").isVisible());
  await mode.selectOption("agent");
  await button(dialog, "保存").click();
  assert.equal(
    await dialog.locator("input[name=name]").evaluate((e) => e.validity.valueMissing),
    true,
  );
  await dismiss(page);
  await button(card, "编辑").click();
  dialog = page.getByRole("dialog");
  assert.equal(await dialog.locator("[name=name]").inputValue(), host.name);
  await dismiss(page);
  await button(card, "删除").click();
  await page
    .getByRole("dialog")
    .getByRole("heading", { name: "删除 " + host.name + "？" })
    .waitFor();
  await dismiss(page);
  await button(card, "打开目录").click();
  await page.getByRole("dialog").locator("[name=path]").fill("not-absolute");
  await button(page.getByRole("dialog"), "打开").click();
  assert(
    await page
      .getByRole("dialog")
      .locator("[name=path]")
      .evaluate((e) => e.validity.patternMismatch),
  );
  await dismiss(page);
  const roots = await api(page, "/api/selfhost/projects?hostId=" + hostId);
  await button(card, "进入工作区").waitFor();
  for (const project of roots)
    assert.equal(await card.getByText(project.remotePath, { exact: true }).count(), 0);
  await button(page, "账号设置").click();
  await page.getByRole("dialog").getByLabel("当前密码").waitFor();
  await dismiss(page);
  if (mutation) {
    const name = "ui-check-" + randomUUID(),
      renamed = name + "-renamed";
    try {
      await button(page, "添加主机").click();
      dialog = page.getByRole("dialog");
      await dialog.locator("[name=name]").fill(name);
      await dialog.getByRole("radio", { name: "终端", exact: true }).locator("..").click();
      await dialog.locator("[name=address]").fill(host.sshHost);
      await dialog.locator("[name=user]").fill(host.username);
      await dialog.locator("[name=port]").fill(String(host.port));
      if (host.hostKeyFingerprint)
        await dialog.locator("[name=fingerprint]").fill(host.hostKeyFingerprint);
      await button(dialog, "保存").click();
      const newCard = page
        .locator("section")
        .filter({ has: page.getByRole("heading", { name, exact: true }) });
      await button(newCard, "编辑").click();
      dialog = page.getByRole("dialog");
      assert.equal(await dialog.getByRole("radio", { name: "终端" }).isChecked(), true);
      await dialog.locator("[name=name]").fill(renamed);
      await button(dialog, "保存").click();
      const changed = page
        .locator("section")
        .filter({ has: page.getByRole("heading", { name: renamed, exact: true }) });
      await changed.locator('[data-workspace-avatar="terminal"]').waitFor();
      await button(changed, "删除").click();
      await button(page.getByRole("dialog"), "删除主机").click();
      await changed.waitFor({ state: "hidden" });
    } finally {
      for (const h of await api(page, "/api/hosts"))
        if (h.name === name || h.name === renamed)
          await page.evaluate(
            async (id) =>
              fetch("/api/hosts/" + id, {
                method: "DELETE",
                headers: { Authorization: "Bearer " + localStorage.getItem("selfhost.auth") },
              }).then((r) => r.ok),
            h.id,
          );
    }
  }
  await verify(page);
  return roots;
}
async function workspace(page, width, projects) {
  if (!cwd || !thread) return;
  const query = new URLSearchParams({ host: String(hostId), cwd, thread });
  let terminalId;
  const detailReads = [];
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname !== "/api/selfhost/capability" ||
      request.method() !== "POST"
    )
      return;
    const call = request.postDataJSON();
    if (call?.method === "plugin/read") detailReads.push(call.params?.pluginName);
  });
  const watchedPaths = new Set();
  if (width >= 1300) {
    page.on("websocket", (socket) =>
      socket.on("framereceived", ({ payload }) => {
        if (typeof payload !== "string") return;
        const event = JSON.parse(payload);
        if (event.type === "terminal.opened") terminalId = event.session.sessionId;
        if (event.type === "file.watch.ready") watchedPaths.add(event.cwd);
      }),
    );
  }
  const [pluginResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/selfhost/capability" &&
        response.request().method() === "POST" &&
        response.request().postDataJSON()?.method === "plugin/installed",
      { timeout: 75000 },
    ),
    (async () => {
      await page.goto(base + "/?" + query);
      const plus = button(page, "添加上下文");
      await plus.waitFor({ timeout: 75000 });
      await plus.click();
    })(),
  ]);
  assert(
    pluginResponse.ok(),
    "Remote installed plugin catalog returned " + pluginResponse.status(),
  );
  const pluginLabels = await pluginResponse.json();
  const installed = pluginLabels.value.marketplaces.flatMap((market) => {
    const first = market.plugins.find((plugin) => plugin.enabled && plugin.installed && plugin.id);
    return first ? [first] : [];
  });
  const picker = composerPicker(page);
  await picker.waitFor();
  if (installed.length) {
    await picker.locator('[role="option"][data-section-id="plugins"]').first().waitFor();
  }
  // The visible label is localized, and the picker mounts only the current scroll window.
  for (const plugin of installed) {
    const option = await revealPickerOption(picker, "plugin:" + plugin.id);
    assert(await option.isEnabled(), "Installed plugin is selectable: " + plugin.id);
  }
  assert.deepEqual(detailReads, [], "Composer references requested per-plugin details");
  await verify(page);
  await page.keyboard.press("Escape");
  const model = page.locator('button[aria-label^="OpenAI Codex/"]').first();
  await model.click();
  await page.getByRole("dialog", { name: "选择模型" }).waitFor();
  assert((await page.getByRole("option").count()) > 0);
  await page.keyboard.press("Escape");
  if (process.env.SELFHOST_TEST_PANEL === "1") {
    const status = page.getByRole("complementary", { name: "会话状态", exact: true });
    await status.waitFor();
    const needsOpen = (await status.getAttribute("data-status-placement")) === "trigger";
    if (needsOpen) await status.getByRole("button", { name: "打开会话状态" }).click();
    await page.getByTestId("status-git-view-all").waitFor();
    if (needsOpen) await page.keyboard.press("Escape");
  }
  if (width >= 1300) {
    const watchPrefix =
      process.env.SELFHOST_TEST_FILE_WATCH === "1" ? "zcode-watch-" + randomUUID() : undefined;
    if (watchPrefix) {
      const project = projects.find((project) => project.remotePath === cwd);
      assert(project, "File watch verification needs a registered project directory");
      const row = page
        .getByTestId("virtual-project-row")
        .filter({ has: page.getByText(project.name, { exact: true }) });
      await row.hover();
      await row.getByTestId("virtual-project-files").click();
      await button(page, "刷新文件树").waitFor();
      const deadline = Date.now() + 20000;
      while (!watchedPaths.has(cwd) && Date.now() < deadline) await delay(50);
      assert(watchedPaths.has(cwd), "No Codex fs/watch lease for the expanded project");
    }
    await button(page, "切换终端").click();
    const deadline = Date.now() + 20000;
    while (!terminalId && Date.now() < deadline) await delay(50);
    assert(terminalId, "SSH terminal did not open");
    const input = page.locator(".xterm-helper-textarea").last();
    await input.focus();
    const factor = randomInt(2, 200);
    const expected = "zcode_pty_" + 211 * factor;
    // Only a remote shell evaluating the expression can produce the expected line.
    await page.keyboard.type("printf 'zcode_pty_%d\\n' $(( 211 * " + factor + " ))");
    await page.keyboard.press("Enter");
    try {
      await page.waitForFunction(
        (text) =>
          [...document.querySelectorAll(".xterm-rows")].some((rows) =>
            rows.textContent.includes(text),
          ),
        expected,
        { timeout: 15000 },
      );
      if (watchPrefix) {
        await page.keyboard.type("zcode_watch_file=$(mktemp ./" + watchPrefix + "-XXXXXX)");
        await page.keyboard.press("Enter");
        await page
          .getByRole("treeitem")
          .filter({ hasText: watchPrefix })
          .waitFor({ timeout: 15000 });
      }
    } finally {
      await input.focus();
      if (watchPrefix) {
        await page.keyboard.type(
          'if [ -n "$zcode_watch_file" ]; then rm -f -- "$zcode_watch_file"; fi',
        );
        await page.keyboard.press("Enter");
        await page
          .getByRole("treeitem")
          .filter({ hasText: watchPrefix })
          .waitFor({ state: "hidden", timeout: 15000 });
      }
      await page.keyboard.type("exit");
      await page.keyboard.press("Enter");
    }
  }
  if (width < 600)
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
  await verify(page);
}
async function writerHistory(page, threadId) {
  const params = new URLSearchParams({ host: String(hostId), cwd, thread: threadId });
  let firstPaint = false;
  const deferred = [];
  await page.routeWebSocket("**/api/realtime", (browserSocket) => {
    const upstream = browserSocket.connectToServer();
    browserSocket.onMessage((message) => {
      if (
        !firstPaint &&
        typeof message === "string" &&
        JSON.parse(message).type === "thread.timeline.load"
      ) {
        deferred.push(() => upstream.send(message));
        return;
      }
      upstream.send(message);
    });
  });
  await page.goto(base + "/?" + params);
  await page.getByTestId("v4-workspace-readonly-notice").waitFor({ timeout: 45000 });
  assert.equal(await page.getByText(/already has an active writer/).count(), 0);
  assert.equal(await page.locator('[contenteditable="true"]').count(), 0);
  // The pane painted with all earlier-page requests held by the test.
  firstPaint = true;
  for (const release of deferred) release();
  await verifyNativeRecovery(page, hostId, threadId, true);
}

async function newThreadTitle(page, projects) {
  const params = new URLSearchParams({ host: String(hostId), cwd });
  const prompt = "请为压扁的纸盒写一句分类提示，回答只需一句话。";
  const timing = {};
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      if (typeof payload === "string" && JSON.parse(payload).type === "turn.start")
        timing.sent = performance.now();
    });
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      const message = JSON.parse(payload);
      if (
        message.type === "turn.start.accepted" ||
        (message.type === "thread.delivery.state" &&
          message.state === "accepted" &&
          message.delivery === "startNow")
      )
        timing.accepted = performance.now();
      if (
        message.event?.event?.type === "timeline.item.delta" &&
        message.event.event.channel === "agentMessage"
      )
        timing.firstText ??= performance.now();
    });
  });
  await page.goto(base + "/?" + params);
  const project = projects.find((entry) => entry.remotePath === cwd && entry.nativeId);
  if (project) {
    await page.getByTestId("composer-workspace-trigger").click();
    await page
      .getByTestId("composer-project-menu")
      .locator('[data-project-id="' + project.nativeId + '"]')
      .click();
  }
  const composer = page.locator('[contenteditable="true"]').first();
  await composer.fill(prompt);
  await composer.press("Enter");
  await page.waitForURL((url) => Boolean(url.searchParams.get("thread")), { timeout: 45000 });
  const id = new URL(page.url()).searchParams.get("thread");
  await page.waitForFunction(
    async ({ hostId, id, prompt, projectId }) => {
      const r = await fetch("/api/threads?" + new URLSearchParams({ hostId, limit: 25 }), {
        headers: { Authorization: "Bearer " + localStorage.getItem("selfhost.auth") },
      });
      if (!r.ok) return false;
      const { data } = await r.json();
      const thread = data.find((entry) => entry.id === id);
      const fallback = Array.from(prompt).slice(0, 36).join("");
      return Boolean(
        thread?.name &&
        thread.name !== fallback &&
        Array.from(thread.name).length <= 36 &&
        (!projectId || thread.projectId === projectId),
      );
    },
    { hostId, id, prompt, projectId: project?.nativeId },
    { timeout: 90000, polling: 1500 },
  );
  assert(timing.accepted >= timing.sent);
  console.log("Web send accepted in " + Math.round(timing.accepted - timing.sent) + "ms");
  if (timing.firstText !== undefined)
    console.log("Web first text in " + Math.round(timing.firstText - timing.sent) + "ms");
  await api(page, "/api/selfhost/capability", {
    hostId,
    method: "thread/archive",
    params: { threadId: id },
  });
}

try {
  if (process.env.SELFHOST_TEST_ROTATE_ACCOUNT === "1")
    await verifyAccount(browser, base, username, qaPassword);
  else
    for (const width of [1480, 390]) {
      const ctx = await browser.newContext({
        viewport: { width, height: 900 },
        isMobile: width < 600,
        hasTouch: width < 600,
      });
      try {
        const page = await ctx.newPage();
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await login(page);
        const roots = await catalog(page, width > 1000 && process.env.SELFHOST_TEST_MUTATE === "1");
        if (width === 1480 && process.env.SELFHOST_TEST_COMPAT_HOST) {
          const id = Number(process.env.SELFHOST_TEST_COMPAT_HOST);
          const projects = await api(page, "/api/selfhost/projects?hostId=" + id + "&refresh=1");
          assert(Array.isArray(projects), "Newer Codex project discovery");
          const list = await api(page, "/api/threads?hostId=" + id + "&limit=10");
          assert(
            list.data.some((row) => typeof row.id === "string"),
            "Newer Codex thread listing",
          );
        }
        if (width === 1480 && process.env.SELFHOST_TEST_IDENTITY === "1") {
          assert(username.startsWith("qa-"));
          await verifyWorkspaceIdentity({ page, browser, base, hostId, cwd, login, api });
        }
        if (process.env.SELFHOST_TEST_SESSION_FOCUS !== "1") await workspace(page, width, roots);
        if (width === 390 && process.env.SELFHOST_TEST_MCP_THREAD)
          await verifyElicitation(page, {
            base,
            hostId,
            cwd,
            thread: process.env.SELFHOST_TEST_MCP_THREAD,
            action: process.env.SELFHOST_TEST_MCP_ACTION || "accept",
            mode: process.env.SELFHOST_TEST_MCP_MODE || "form",
          });
        if (width >= 1300 && thread) await verifyNativeRecovery(page, hostId, thread);
        if (process.env.SELFHOST_TEST_WRITER_THREAD)
          await writerHistory(page, process.env.SELFHOST_TEST_WRITER_THREAD);
        if (width >= 1300 && process.env.SELFHOST_TEST_AUTO_TITLE === "1")
          await newThreadTitle(page, roots);
        assert.deepEqual(errors, []);
        console.log(width + "px passed (" + roots.length + " remote projects)");
      } finally {
        await ctx.close();
      }
    }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  const chrome = server.process();
  if (chrome.exitCode === null && chrome.signalCode === null) {
    const exited = once(chrome, "exit");
    const timer = setTimeout(() => chrome.kill("SIGKILL"), 5000);
    try {
      void server.close().catch(() => chrome.kill("SIGKILL"));
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
}
// launchServer's WebSocket listener can outlive its Chrome child on macOS.
process.exit(process.exitCode ?? 0);
