import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { build, preview } from "vite";

const cwd = "/plugin-settings-fixture";
const hostId = 9;
const model = { id: "fixture", model: "fixture", displayName: "Fixture", isDefault: true };
const project = { hostId, remotePath: cwd, name: "Fixture" };
const makePlugin = (marketplaceName, installed) => ({
  pluginId: `review@${marketplaceName}`,
  name: "review",
  marketplaceName,
  version: "1.0.0",
  installed,
  enabled: installed,
  source: { source: "local", path: `/fixtures/${marketplaceName}/review` },
  marketplaceSource: { source: `/fixtures/${marketplaceName}`, sourceType: "local" },
});

async function verify(page, origin) {
  const first = makePlugin("fixture-first", true);
  const second = makePlugin("fixture-second", false);
  const account = {
    ...makePlugin("openai-curated-remote", true),
    source: { source: "remote", id: "fixture-account" },
    marketplaceSource: undefined,
  };
  const personal = {
    ...account,
    pluginId: "review@created-by-me-remote",
    marketplaceName: "created-by-me-remote",
  };
  const restricted = {
    ...account,
    pluginId: "restricted@openai-curated-remote",
    name: "restricted",
    installed: false,
    enabled: false,
    installPolicy: "NOT_AVAILABLE",
  };
  const managed = {
    ...personal,
    pluginId: "policy@workspace-remote",
    name: "policy",
    marketplaceName: "workspace-remote",
    enabled: false,
    availability: "DISABLED_BY_ADMIN",
  };
  const entries = [first, second, account, personal, restricted, managed];
  const accountCatalog = Promise.withResolvers();
  const configuredCatalog = Promise.withResolvers();
  let accountCatalogAvailable = false;
  let accountCatalogCalls = 0;
  let configuredMarketFailed = false;
  let failUninstall = true;
  const skills = [first, second].map((plugin) => ({
    name: "Review skill",
    description: "Fixture skill",
    enabled: true,
    scope: "user",
    path: `/fixtures/${plugin.marketplaceName}/Review/SKILL.md`,
  }));
  const writes = [];
  const turnStarts = [];
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("selfhost.auth", "fixture");
    localStorage.setItem("zcode-locale-preference", "zh-CN");
  });
  await page.route(new URL("/api/**", origin).href, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postDataJSON();
    const value = (data) => route.fulfill({ json: { value: data } });
    if (url.pathname === "/api/selfhost/plugins") {
      assert.equal(body.hostId, hostId);
      assert.equal(body.cwd, cwd);
      if (body.operation === "catalog" && body.source === "configured") {
        await configuredCatalog.promise;
        return value({
          entries: configuredMarketFailed ? [first] : [first, second],
          markets: [first, second].map((entry) => ({
            name: entry.marketplaceName,
            root: entry.marketplaceSource.source,
            marketplaceSource: entry.marketplaceSource,
            ...(configuredMarketFailed && entry === second
              ? {
                  refreshFailure: {
                    code: "marketplace_load_failed",
                    failedAt: "2026-11-24T00:00:00Z",
                    message: "Fixture host marketplace timed out",
                  },
                }
              : {}),
          })),
          issues: configuredMarketFailed ? ["Fixture host marketplace timed out"] : [],
        });
      }
      if (body.operation === "catalog") {
        assert.equal(body.source, "account");
        accountCatalogCalls++;
        await accountCatalog.promise;
        if (!accountCatalogAvailable)
          return route.fulfill({
            status: 504,
            json: { message: "Fixture account catalog timed out" },
          });
        return value({ entries: [account, restricted], markets: [], issues: [] });
      }
      const entry = entries.find((item) => item.pluginId === body.pluginId);
      assert(entry, "Use the full native plugin ID for management");
      if (body.operation === "describe") {
        if (entry.source.source === "remote") return value(entry.installed ? { entry } : {});
        return value({
          entry,
          manifest: {
            description: "Manifest for " + entry.marketplaceName,
            interface: { displayName: "Review" },
          },
        });
      }
      writes.push([body.operation, body.pluginId, body.enabled]);
      if (body.operation === "setEnabled") {
        entry.enabled = body.enabled;
        return value(entry);
      }
      assert(body.operation === "install" || body.operation === "uninstall");
      if (body.operation === "uninstall" && failUninstall) {
        failUninstall = false;
        return route.fulfill({ status: 409, json: { message: "Fixture uninstall failed" } });
      }
      entry.installed = entry.enabled = body.operation === "install";
      return value({ ...entry, installedPath: entry.source.path });
    }
    if (url.pathname === "/api/selfhost/capability") {
      assert(
        !["plugin/read", "plugin/list", "plugin/install", "plugin/uninstall"].includes(body.method),
      );
      if (body.method === "plugin/installed")
        return value({
          marketplaces: entries
            .filter((entry) => entry.installed)
            .map((entry) => ({
              name: entry.marketplaceName,
              path: entry.marketplaceSource
                ? entry.marketplaceSource.source + "/.agents/plugins/marketplace.json"
                : null,
              interface: {
                displayName: entry === personal ? "My account marketplace" : entry.marketplaceName,
              },
              plugins: entry.installed
                ? [
                    {
                      id: entry.pluginId,
                      name: entry.name,
                      installed: true,
                      enabled: entry.enabled,
                      availability: entry.availability ?? "AVAILABLE",
                      source: { type: entry.source.source, path: entry.source.path },
                      interface: {
                        displayName: entry === personal ? "My account review" : "Review",
                      },
                    },
                  ]
                : [],
            })),
        });
      if (body.method === "skills/list") {
        assert.deepEqual(body.params.cwds, [cwd]);
        return value({ data: [{ cwd, skills, errors: [] }] });
      }
      if (body.method === "skills/config/write") {
        assert.deepEqual(body.params, { path: skills[1].path, enabled: false });
        skills[1].enabled = false;
        writes.push([body.method, body.params.path, body.params.enabled]);
        return value({ effectiveEnabled: false });
      }
      return value({ data: [] });
    }
    const routes = {
      "/api/hosts": [
        {
          id: hostId,
          name: "Fixture",
          sshHost: "fixture",
          username: "qa",
          port: 22,
          authMode: "agent",
        },
      ],
      "/api/selfhost/projects": url.searchParams.has("organization")
        ? { items: [project], memberships: {} }
        : [project],
      "/api/projects": [project],
      "/api/threads": { data: [], nextCursor: null },
      "/api/models": { data: [model], nextCursor: null },
      "/api/selfhost/settings": { locale: "zh-CN" },
      "/api/selfhost/workspace": {
        value: body?.method === "resolveDirectory" ? cwd : { homedir: cwd, platform: "linux" },
      },
      "/api/selfhost/organization": {
        value:
          body?.channel === "task-groups"
            ? { revision: 0, members: [], groups: [], order: [] }
            : [],
      },
    };
    return route.fulfill({ json: routes[url.pathname] ?? {} });
  });
  await page.routeWebSocket("**/api/realtime", (socket) =>
    socket.onMessage((raw) => {
      const call = JSON.parse(raw);
      if (call.type === "turn.start") turnStarts.push(call);
      if (call.type === "auth.authenticate") socket.send(JSON.stringify({ type: "ready" }));
      else if (call.requestId)
        socket.send(
          JSON.stringify({
            type: "fixture.result",
            requestId: call.requestId,
            defaults: { model: "fixture" },
          }),
        );
    }),
  );
  await page.goto(new URL("/?" + new URLSearchParams({ host: String(hostId), cwd }), origin).href, {
    waitUntil: "domcontentloaded",
  });
  const settingsButton = page.getByTestId("task-settings-button");
  await settingsButton.waitFor({ timeout: 60000 }).catch(async (cause) => {
    const startupText = (await page.locator("body").innerText()).slice(0, 500);
    throw new Error(
      `The settings entry did not mount. Page: ${startupText}\n${pageErrors.join("\n")}`,
      { cause },
    );
  });
  await settingsButton.click();
  await page.locator('[data-settings-section-nav="skill"]').click();
  const rightSkill = page.locator(`[data-skill-path="${skills[1].path}"]`).getByRole("switch");
  await rightSkill.click();
  await rightSkill.and(page.locator('[aria-checked="false"]')).waitFor();
  assert.equal(
    await page
      .locator(`[data-skill-path="${skills[0].path}"]`)
      .getByRole("switch")
      .getAttribute("aria-checked"),
    "true",
  );

  await page.locator('[data-settings-section-nav="plugin"]').click();
  const row = page.locator(
    `[data-testid="plugin-settings-plugin-row"][data-plugin-id="${first.pluginId}"]`,
  );
  const toggle = row.locator('[role="switch"]');
  await toggle.click();
  await toggle.and(page.locator('[aria-checked="false"]')).waitFor();
  const accountRow = page.locator(
    `[data-testid="plugin-settings-plugin-row"][data-plugin-id="${account.pluginId}"]`,
  );
  const accountToggle = accountRow.getByRole("switch");
  await accountToggle.click();
  await accountToggle.and(page.locator('[aria-checked="false"]')).waitFor();
  await accountToggle.click();
  await accountToggle.and(page.locator('[aria-checked="true"]')).waitFor();
  const managedRow = page.locator(
    `[data-testid="plugin-settings-plugin-row"][data-plugin-id="${managed.pluginId}"]`,
  );
  await managedRow.getByRole("switch").and(page.locator(":disabled")).waitFor();
  await page.getByTestId("plugin-store-browse").click();
  await page.getByTestId("plugin-store-sources-open").click();
  await page.getByTestId("plugin-store-source-add").click();
  const sourceInput = page.getByTestId("plugin-store-add-source-input");
  await sourceInput.waitFor();
  await page.getByTestId("plugin-store-sources-dialog").waitFor({ state: "hidden" });
  await page.keyboard.press("Escape");
  await sourceInput.waitFor({ state: "hidden" });
  const accountStatus = page.getByTestId("plugin-store-account-catalog");
  await accountStatus.and(page.locator('[data-status="loading"]')).waitFor();
  assert.equal(
    await accountStatus.getByTestId("plugin-store-codex-directory").getAttribute("href"),
    "https://chatgpt.com/plugins",
  );
  const marketplaceList = page.getByTestId("plugin-store-list");
  await marketplaceList.getByRole("heading", { name: "My account marketplace", exact: true }).waitFor();
  await marketplaceList.getByText("My account review", { exact: true }).waitFor();
  await page
    .locator(`[data-testid="plugin-store-card"][data-plugin-id="${personal.pluginId}"]`)
    .click();
  const detail = page.getByTestId("plugin-store-detail");
  const detailMenu = detail.getByTestId("plugin-store-item-menu");
  await detailMenu.click();
  await page.getByRole("menu").getByTestId("plugin-store-codex-directory").waitFor();
  assert.equal(await page.getByTestId("plugin-store-menu-uninstall").count(), 0);
  await page.keyboard.press("Escape");
  await page.getByTestId("plugin-store-detail-back").click();
  await page
    .locator(`[data-testid="plugin-store-card"][data-plugin-id="${managed.pluginId}"]`)
    .click();
  await detail.getByTestId("plugin-store-codex-policy-blocked").waitFor();
  await detail.getByTestId("plugin-store-try-now").and(page.locator(":disabled")).waitFor();
  await page.getByTestId("plugin-store-detail-back").click();
  configuredCatalog.resolve();
  const secondCard = page.locator(
    `[data-testid="plugin-store-card"][data-plugin-id="${second.pluginId}"]`,
  );
  await secondCard.click();
  await page.getByText("Manifest for fixture-second", { exact: true }).waitFor();
  await page.getByTestId("plugin-store-detail").getByTestId("plugin-store-install").click();
  const menu = page.getByTestId("plugin-store-detail").getByTestId("plugin-store-item-menu");
  await menu.click();
  await page.getByTestId("plugin-store-menu-uninstall").click();
  await page.getByTestId("plugin-store-uninstall-confirm").click();
  await page
    .getByTestId("plugin-store-uninstall-dialog")
    .getByText("Fixture uninstall failed")
    .waitFor();
  assert(second.installed);
  await page.getByTestId("plugin-store-uninstall-confirm").click();
  await page.getByTestId("plugin-store-detail").getByTestId("plugin-store-install").waitFor();
  await page.getByTestId("plugin-store-detail-back").click();
  accountCatalog.resolve();
  await accountStatus.and(page.locator('[data-status="error"]')).waitFor();
  await accountStatus.getByText("Fixture account catalog timed out", { exact: true }).waitFor();
  const accountAttempts = accountCatalogCalls;
  accountCatalogAvailable = true;
  configuredMarketFailed = true;
  await accountStatus.getByTestId("plugin-store-account-retry").click();
  const restrictedCard = page.locator(
    `[data-testid="plugin-store-card"][data-plugin-id="${restricted.pluginId}"]`,
  );
  await restrictedCard.getByTestId("plugin-store-install").and(page.locator(":disabled")).waitFor();
  await page.getByRole("status").getByText("Fixture host marketplace timed out").waitFor();
  await secondCard.getByTestId("plugin-store-install").waitFor();
  assert(accountCatalogCalls > accountAttempts);
  await restrictedCard.click();
  await detail.getByTestId("plugin-store-install").and(page.locator(":disabled")).waitFor();
  await detail.getByTestId("plugin-store-codex-install-policy").waitFor();
  assert.deepEqual(writes, [
    ["skills/config/write", skills[1].path, false],
    ["setEnabled", first.pluginId, false],
    ["setEnabled", account.pluginId, false],
    ["setEnabled", account.pluginId, true],
    ["install", second.pluginId, undefined],
    ["uninstall", second.pluginId, undefined],
    ["uninstall", second.pluginId, undefined],
  ]);
  assert(first.installed && !first.enabled);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("plugin-store-sidebar-open").click();
  await row.waitFor();
  assert.equal(await row.getByTestId("plugin-settings-use").count(), 0);
  assert.equal(await managedRow.getByTestId("plugin-settings-use").count(), 0);
  await accountRow.getByTestId("plugin-settings-use").waitFor();
  await page.getByTestId("plugin-store-browse").click();
  await page.getByTestId("plugin-store-title").waitFor();
  await restrictedCard.getByTestId("plugin-store-install").and(page.locator(":disabled")).waitFor();
  await page.getByTestId("plugin-store-manage-open").click();
  await accountRow.getByTestId("plugin-settings-use").click();
  await page
    .locator(`[contenteditable="true"] [data-mention-id="plugin:${account.pluginId}"]`)
    .waitFor();
  assert.deepEqual(turnStarts, []);
  assert.deepEqual(pageErrors, []);
}

const target = process.env.SELFHOST_PLUGIN_SETTINGS_TEST_URL;
const outDir = target ? null : await mkdtemp(join(tmpdir(), "selfhost-plugin-settings-browser-"));
let server, browser;
try {
  if (outDir) {
    const web = resolve(import.meta.dirname, "../../packages/web");
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
  const origin = target ?? server.resolvedUrls.local[0];
  browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const width of [1480, 390]) {
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      isMobile: width === 390,
      hasTouch: width === 390,
    });
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(60000);
    try {
      await verify(page, origin);
      console.log(`PASS native SSH plugin and skill settings ${width}px`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser?.close();
  await server?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
}
