import { verifyNativeRecovery } from "./native-history.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";

const base = new URL(process.env.SELFHOST_TEST_URL).origin;
const username = process.env.SELFHOST_TEST_USER || "admin";
const password = (await readFile(process.env.SELFHOST_TEST_PASSWORD_FILE, "utf8")).trim();
const thread = process.env.SELFHOST_TEST_THREAD,
  hostId = Number(process.env.SELFHOST_TEST_HOST || 1),
  cwd = process.env.SELFHOST_TEST_CWD;
const browser = await chromium.launch({
  channel: process.env.SELFHOST_TEST_BROWSER || "chrome",
  headless: true,
});
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
async function workspace(page, width) {
  if (!cwd || !thread) return;
  const query = new URLSearchParams({ host: String(hostId), cwd, thread });
  await page.goto(base + "/?" + query);
  const plus = button(page, "添加上下文");
  await plus.waitFor({ timeout: 75000 });
  await plus.click();
  const pluginLabels = await api(page, "/api/selfhost/capability", {
    hostId,
    method: "plugin/list",
    params: { cwds: [cwd] },
  });
  const enabled = pluginLabels.value.marketplaces
    .flatMap((m) => m.plugins)
    .filter((p) => p.enabled);
  if (enabled.length) {
    const name = enabled[0].interface?.displayName || enabled[0].name;
    await page.getByRole("option").filter({ hasText: name }).first().waitFor({ timeout: 75000 });
  }
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
      await workspace(page, width);
      if (width >= 1300 && thread) await verifyNativeRecovery(page, hostId, thread);
      assert.deepEqual(errors, []);
      console.log(width + "px passed (" + roots.length + " remote projects)");
    } finally {
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
