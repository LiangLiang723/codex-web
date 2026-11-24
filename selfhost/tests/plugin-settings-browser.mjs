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
  const entries = [first, second, account];
  let failUninstall = true;
  const skills = [first, second].map((plugin) => ({
    name: "Review skill",
    description: "Fixture skill",
    enabled: true,
    scope: "user",
    path: `/fixtures/${plugin.marketplaceName}/Review/SKILL.md`,
  }));
  const writes = [];
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
      if (body.operation === "catalog")
        return value({
          entries,
          markets: [first, second].map((entry) => ({
            name: entry.marketplaceName,
            root: entry.marketplaceSource.source,
            marketplaceSource: entry.marketplaceSource,
          })),
          issues: [],
        });
      const entry = entries.find((item) => item.pluginId === body.pluginId);
      assert(entry, "Use the full native plugin ID for management");
      if (body.operation === "describe")
        return value({
          entry,
          manifest: {
            description: "Manifest for " + entry.marketplaceName,
            interface: { displayName: "Review" },
          },
        });
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
          marketplaces: entries.map((entry) => ({
            name: entry.marketplaceName,
            path: entry.marketplaceSource
              ? entry.marketplaceSource.source + "/.agents/plugins/marketplace.json"
              : null,
            plugins: entry.installed
              ? [
                  {
                    id: entry.pluginId,
                    name: entry.name,
                    installed: true,
                    enabled: entry.enabled,
                    source: entry.source,
                    interface: { displayName: "Review" },
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
  await page.goto(new URL("/?" + new URLSearchParams({ host: String(hostId), cwd }), origin).href);
  await page.getByTestId("task-settings-button").click();
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
  await accountRow.waitFor();
  assert.equal(await accountRow.getByRole("switch").count(), 0);
  await page.getByTestId("plugin-store-browse").click();
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
  assert.deepEqual(writes, [
    ["skills/config/write", skills[1].path, false],
    ["setEnabled", first.pluginId, false],
    ["install", second.pluginId, undefined],
    ["uninstall", second.pluginId, undefined],
    ["uninstall", second.pluginId, undefined],
  ]);
  assert(first.installed && !first.enabled);
  await page.reload();
  await page.getByTestId("plugin-store-sidebar-open").click();
  await page.getByTestId("plugin-store-title").waitFor();
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
    page.setDefaultTimeout(15000);
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
