import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { build, preview } from "vite";

const cwd = "/state-fixture";
const hostId = 4;
const host = { id: hostId, name: "State fixture", sshHost: "fixture", port: 22, username: "test", authMode: "agent" };
const project = { hostId, name: "State fixture", remotePath: cwd };
const model = { id: "fixture", model: "fixture", displayName: "Fixture", isDefault: true };
const route = "/?host=4&cwd=%2Fstate-fixture";
const themeKey = "zcode-theme";
const petKey = "codex-web:conversation-pet-preferences";
const localState = { "zcode-interface-mode": "office", [themeKey]: "zai-dark" };
const firstAccount = { [themeKey]: "zai-light" };
const otherAccount = {};
let rejectImport = true;
let rejectSave = false;

async function install(page, origin, token, legacy = {}, restore = true) {
  await page.addInitScript(({ token, legacy, restore }) => {
    if (restore) localStorage.setItem("selfhost.auth", token);
    for (const [key, value] of Object.entries(legacy)) localStorage.setItem(key, value);
    if (Object.keys(legacy).length) {
      sessionStorage.setItem("zcode-settings-section-intent", "appearance");
      sessionStorage.setItem("zcode-automations-page-tab", "workflow");
    }
  }, { token, legacy, restore });
  await page.route(new URL("/api/**", origin).href, async (request) => {
    const req = request.request();
    const url = new URL(req.url());
    const input = req.postDataJSON();
    const account = req.headers().authorization === "Bearer other" ? otherAccount : firstAccount;
    if (url.pathname === "/api/selfhost/browser-state") {
      if (req.method() === "PATCH") {
        if (input.importLegacy ? rejectImport : rejectSave) {
          return request.fulfill({ status: 503, json: { message: "Fixture simulated offline" } });
        }
        for (const [key, value] of input.changes) {
          if (input.importLegacy && Object.hasOwn(account, key)) continue;
          if (value === null) delete account[key];
          else account[key] = value;
        }
      }
      return request.fulfill({ json: account });
    }
    const values = {
      "/api/auth/login": { token },
      "/api/auth/me": { user: { username: token, avatar: null } },
      "/api/hosts": [host],
      "/api/projects": [project],
      "/api/selfhost/projects": url.searchParams.has("organization")
        ? { items: [project], memberships: {} } : [project],
      "/api/models": { data: [model], nextCursor: null },
      "/api/selfhost/settings": { locale: "zh-CN", localePreference: "zh-CN" },
      "/api/threads": { data: [], nextCursor: null },
      "/api/selfhost/workspace": { value: input?.method === "resolveDirectory" ? cwd : { homedir: cwd, platform: "linux" } },
      "/api/selfhost/organization": { value: input?.channel === "task-groups" ? { revision: 0, members: [], groups: [], order: [] } : [] },
    };
    return request.fulfill({ json: values[url.pathname] ?? {} });
  });
  await page.routeWebSocket("**/api/realtime", socket => socket.onMessage(raw => {
    const message = JSON.parse(raw);
    if (message.type === "auth.authenticate") socket.send(JSON.stringify({ type: "ready" }));
    else if (message.requestId) socket.send(JSON.stringify({
      type: "fixture.result", requestId: message.requestId, defaults: { model: "fixture" },
    }));
  }));
}

async function assertBrowserStorage(page, token) {
  assert.deepEqual(await page.evaluate(async () => ({
    local: Object.fromEntries(Object.entries(localStorage)),
    sessionKeys: Object.keys(sessionStorage),
    databases: await indexedDB.databases(),
    caches: await globalThis.caches?.keys() ?? [],
    cookies: document.cookie,
  })), { local: { "selfhost.auth": token }, sessionKeys: [], databases: [], caches: [], cookies: "" });
}

async function openSettings(page, section) {
  await page.getByTestId("task-settings-button").click();
  await page.locator(`[data-settings-section-nav="${section}"]`).click();
}

async function verify(browser, origin) {
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const mobile = await browser.newPage({ viewport: { width: 390, height: 900 }, isMobile: true, hasTouch: true });
  const other = await browser.newPage();
  try {
    await install(desktop, origin, "primary", localState);
    await desktop.goto(origin + route);
    const retry = desktop.getByTestId("selfhost-browser-state-retry");
    await retry.waitFor();
    assert.equal(await desktop.evaluate(() => localStorage.getItem("zcode-interface-mode")), "office");
    rejectImport = false;
    await retry.click();
    await openSettings(desktop, "conversationPet");
    assert.equal(firstAccount["zcode-interface-mode"], "office");
    assert.equal(firstAccount[themeKey], "zai-light");
    assert.equal(firstAccount["zcode-automations-page-tab"], "workflow");
    assert.equal(firstAccount["zcode-settings-section-intent"], undefined);
    rejectSave = true;
    await desktop.locator('[data-pet-size-option="large"]').click();
    await retry.waitFor();
    assert.equal(firstAccount[petKey], undefined);
    rejectSave = false;
    await retry.click();
    await retry.waitFor({ state: "hidden" });
    assert.equal(JSON.parse(firstAccount[petKey]).size, "large");
    await assertBrowserStorage(desktop, "primary");
    await desktop.reload({ waitUntil: "commit" });
    await openSettings(desktop, "conversationPet");
    await desktop.locator('[data-pet-size-option="large"][aria-pressed="true"]').waitFor();
    await assertBrowserStorage(desktop, "primary");

    await install(mobile, origin, "second-session-same-account");
    await mobile.goto(origin + route);
    await openSettings(mobile, "conversationPet");
    await mobile.locator('[data-pet-size-option="large"][aria-pressed="true"]').waitFor();
    assert.equal(await mobile.locator("html").getAttribute("data-zcode-browser-theme-surface"), "light");
    await assertBrowserStorage(mobile, "second-session-same-account");

    await install(other, origin, "other", localState, false);
    await other.goto(origin + route);
    await other.locator("input[name=username]").fill("other");
    await other.locator("input[name=password]").fill("fixture-password");
    await other.getByRole("button", { name: "登录" }).click();
    await openSettings(other, "conversationPet");
    await other.locator('[data-pet-size-option="regular"][aria-pressed="true"]').waitFor();
    assert.equal(otherAccount[petKey], undefined);
    assert.equal(otherAccount["zcode-interface-mode"], undefined);
    await assertBrowserStorage(other, "other");
    console.log("Browser account state migration, retry, reload, mobile, isolation and storage passed");
  } finally {
    await Promise.all([desktop.close(), mobile.close(), other.close()]);
  }
}

const target = process.env.SELFHOST_BROWSER_STATE_TEST_URL;
const dir = target ? null : await mkdtemp(join(tmpdir(), "selfhost-account-state-"));
let server;
let browser;
try {
  if (dir) {
    const root = resolve(import.meta.dirname, "../../packages/web");
    const config = { root, configFile: join(root, "vite.config.ts"), mode: "selfhost", logLevel: "error", build: { outDir: dir } };
    await build(config);
    server = await preview({ ...config, preview: { port: 0, host: "127.0.0.1" } });
  }
  browser = await chromium.launch({ channel: "chrome", headless: true });
  await verify(browser, target ?? server.resolvedUrls.local[0].replace(/\/$/u, ""));
} finally {
  await browser?.close();
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
}
