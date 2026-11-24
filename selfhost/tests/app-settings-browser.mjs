import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { build, preview } from "vite";

const cwd = "/app-fixture",
  hostId = 4;
const workspace = { hostId, remotePath: cwd, name: "Fixture" };
const model = { id: "model", model: "model", displayName: "Model", isDefault: true };
async function verify(page, origin) {
  let enabled = true,
    toolEnabled = true;
  const writes = [];
  const app = (id, name, accessible = true) => ({
    id,
    name,
    description: name + " description",
    installUrl: "https://chatgpt.com/apps/example",
    accessible,
    enabled,
    installed: accessible,
    callable: accessible && enabled,
    plugins: ["Native pack"],
  });
  await page.addInitScript(() => {
    localStorage.setItem("selfhost.auth", "fixture");
    localStorage.setItem("zcode-locale-preference", "zh-CN");
  });
  await page.route(new URL("/api/**", origin).href, async (route) => {
    const req = route.request(),
      p = new URL(req.url()).pathname,
      body = req.postDataJSON();
    if (p === "/api/selfhost/apps") {
      assert.equal(body.hostId, hostId);
      if (body.operation === "list") {
        const continuation = Boolean(body.cursor);
        return route.fulfill({
          json: {
            apps: continuation
              ? [app("late", "Late search match", false)]
              : [app("drive", "Drive"), app("new", "New app", false)],
            nextCursor: continuation ? null : "page2",
            runtimeKnown: !continuation,
            directoryIssue: null,
            runtimeIssue: null,
          },
        });
      }
      if (body.operation === "detail")
        return route.fulfill({
          json: {
            tools: [
              {
                name: "list",
                title: "List files",
                description: "Read files",
                enabled: toolEnabled,
                readOnly: true,
                disabledReason: null,
              },
            ],
            plugins: ["Native pack"],
            installUrl: "https://chatgpt.com/apps/example",
          },
        });
      assert.equal(body.operation, "setEnabled");
      writes.push(body);
      if (body.tool) toolEnabled = body.enabled;
      else enabled = body.enabled;
      return route.fulfill({ json: { overridden: false, message: null } });
    }
    const values = {
      "/api/hosts": [
        { id: hostId, name: "QA", sshHost: "fixture", username: "qa", port: 22, authMode: "agent" },
      ],
      "/api/selfhost/projects": new URL(req.url()).searchParams.has("organization")
        ? { items: [workspace], memberships: {} }
        : [workspace],
      "/api/projects": [workspace],
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
      "/api/selfhost/capability": { value: { data: [], marketplaces: [] } },
    };
    return route.fulfill({ json: values[p] ?? {} });
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
            defaults: { model: "model" },
          }),
        );
    }),
  );
  await page.goto(new URL("/?" + new URLSearchParams({ host: String(hostId), cwd }), origin).href);
  await page.getByTestId("task-settings-button").click();
  const appNav = page.locator('[data-settings-section-nav="codexApps"]');
  await appNav.click();
  const row = page.getByTestId("codex-app-drive");
  await row.getByRole("button", { name: "Drive", exact: true }).click();
  await page.getByText("List files", { exact: true }).waitFor();
  await page.getByRole("switch", { name: "List files", exact: true }).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[role="switch"][aria-label="List files"]')
        ?.getAttribute("aria-checked") === "false",
  );
  await page.getByRole("button", { name: "返回", exact: true }).last().click();
  await row.getByRole("switch").click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="codex-app-drive"] [role="switch"]')
        ?.getAttribute("aria-checked") === "false",
  );
  assert.equal(
    new URL(await page.getByTestId("codex-app-new").getByRole("link").getAttribute("href"))
      .protocol,
    "https:",
  );
  const search = page.getByLabel("搜索应用", { exact: true });
  await search.fill("Late search");
  await page.getByTestId("codex-app-late").waitFor();
  assert.deepEqual(
    writes.map((w) => [w.id, w.tool, w.enabled]),
    [
      ["drive", "list", false],
      ["drive", undefined, false],
    ],
  );
}
const target = process.env.SELFHOST_APP_SETTINGS_TEST_URL;
const out = target ? null : await mkdtemp(join(tmpdir(), "app-settings-browser-"));
let server, browser;
try {
  if (out) {
    const web = resolve(import.meta.dirname, "../../packages/web"),
      cfg = {
        root: web,
        configFile: join(web, "vite.config.ts"),
        mode: "selfhost",
        logLevel: "error",
        build: { outDir: out },
      };
    await build(cfg);
    server = await preview({ ...cfg, preview: { port: 0, host: "127.0.0.1" } });
  }
  const origin = target ?? server.resolvedUrls.local[0];
  browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const width of [1480, 390]) {
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      isMobile: width === 390,
      hasTouch: width === 390,
    });
    try {
      await verify(page, origin);
      console.log("PASS SSH App settings " + width + "px");
    } finally {
      await page.close();
    }
  }
} finally {
  await browser?.close();
  await server?.close();
  if (out) await rm(out, { recursive: true, force: true });
}
