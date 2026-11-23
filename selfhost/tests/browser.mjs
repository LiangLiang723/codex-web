import { verifyNativeRecovery } from "./native-history.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { randomInt, randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import { setTimeout as delay } from "node:timers/promises";

const base = new URL(process.env.SELFHOST_TEST_URL).origin;
const username = process.env.SELFHOST_TEST_USER || "admin";
const password = (await readFile(process.env.SELFHOST_TEST_PASSWORD_FILE, "utf8")).trim();
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
  await page.locator("[name=password]").fill(password);
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
  await button(card, "同步项目").click();
  await button(card, "同步项目").waitFor({ timeout: 60000 });
  for (const project of roots) await card.getByText(project.remotePath, { exact: true }).waitFor();
  if (mutation) {
    const name = "ui-check-" + randomUUID(),
      renamed = name + "-renamed";
    try {
      await button(page, "添加主机").click();
      dialog = page.getByRole("dialog");
      await dialog.locator("[name=name]").fill(name);
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
      await dialog.locator("[name=name]").fill(renamed);
      await button(dialog, "保存").click();
      const changed = page
        .locator("section")
        .filter({ has: page.getByRole("heading", { name: renamed, exact: true }) });
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
  const remoteDetailReads = [];
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname !== "/api/selfhost/capability" ||
      request.method() !== "POST"
    )
      return;
    const call = request.postDataJSON();
    if (call?.method === "plugin/read" && call.params?.remoteMarketplaceName)
      remoteDetailReads.push(call.params.remoteMarketplaceName);
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
  // Check a real installed entry from each marketplace, including offline remote catalogs.
  for (const market of pluginLabels.value.marketplaces) {
    const first = market.plugins.find((plugin) => plugin.enabled);
    if (!first) continue;
    const name = first.interface?.displayName || first.name;
    await page.getByRole("option").filter({ hasText: name }).first().waitFor({ timeout: 75000 });
  }
  assert.deepEqual(remoteDetailReads, [], "Opening the composer contacted remote plugin catalogs");
  await verify(page);
  await page.keyboard.press("Escape");
  const model = page.locator('button[aria-label^="OpenAI Codex/"]').first();
  await model.click();
  await page.getByRole("dialog", { name: "选择模型" }).waitFor();
  assert((await page.getByRole("option").count()) > 0);
  await page.keyboard.press("Escape");
  if (process.env.SELFHOST_TEST_PANEL === "1") {
    const git = page.locator('[data-status-capsule="git"]');
    await git.waitFor();
    await git.click();
    await page.getByTestId("status-git-files").waitFor();
    await page.keyboard.press("Escape");
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
try {
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
      await workspace(page, width, roots);
      if (width >= 1300 && thread) await verifyNativeRecovery(page, hostId, thread);
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
