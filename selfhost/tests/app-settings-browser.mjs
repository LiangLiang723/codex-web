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
  const taskId = "01b8577c-40dd-756a-beec-02952bbfc1a1";
  const task = {
    id: taskId,
    cwd,
    name: "Deletion fixture",
    createdAt: 1,
    updatedAt: 1,
    status: { type: "idle" },
    path: `${cwd}/test-rollout.jsonl`,
  };
  let deleted = false,
    rejectDelete = true;
  const deletionRequests = [];
  let instructions = "Original Codex instructions";
  const instructionsPath = `${cwd}/.codex/AGENTS.md`;
  const writes = [];
  const directoryReads = [];
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
    if (p === "/api/selfhost/thread-state" && body?.operation === "delete") {
      deletionRequests.push(body);
      assert.equal(body.hostId, hostId);
      assert.equal(body.threadId, taskId);
      if (rejectDelete)
        return route.fulfill({ status: 409, json: { message: "Fixture deletion denied" } });
      deleted = true;
      return route.fulfill({ json: { deleted: true } });
    }
    if (p === "/api/selfhost/workspace" && body?.channel === "user-instructions") {
      assert.equal(body.hostId, hostId);
      if (body.method === "get")
        return route.fulfill({
          json: { value: { content: instructions, filePath: instructionsPath } },
        });
      assert.deepEqual(body.args[1], { content: instructions, filePath: instructionsPath });
      instructions = body.args[0];
      return route.fulfill({ json: { value: { filePath: instructionsPath } } });
    }
    if (p === "/api/selfhost/capability" && body?.method === "hooks/list") {
      assert.deepEqual(body.params, { cwds: [cwd] });
      return route.fulfill({
        json: {
          value: {
            data: [
              {
                hooks: [
                  {
                    key: "fixture-hook",
                    eventName: "SessionStart",
                    sourcePath: `${cwd}/.codex/hooks.json`,
                    enabled: true,
                  },
                ],
                warnings: [],
                errors: [],
              },
            ],
          },
        },
      });
    }
    if (p === "/api/selfhost/capability" && body?.method === "mcpServerStatus/list")
      return route.fulfill({
        json: {
          value: {
            data: [
              {
                name: "fixture-mcp",
                runtimeStatus: "connected",
                tools: { find: {} },
              },
            ],
            nextCursor: null,
          },
        },
      });
    if (p === "/api/selfhost/apps") {
      assert.equal(body.hostId, hostId);
      if (body.operation === "installed")
        return route.fulfill({
          json: {
            apps: [app("drive", "Drive")],
            nextCursor: null,
            runtimeKnown: true,
            directoryIssue: null,
            runtimeIssue: null,
          },
        });
      if (body.operation === "list") {
        directoryReads.push(body.cursor ?? null);
        const continuation = Boolean(body.cursor);
        return route.fulfill({
          json: {
            apps: continuation
              ? [app("late", "Late search match", false)]
              : [
                  app("drive", "Drive"),
                  app("new", "New app", false),
                  {
                    ...app("directory-only", "Directory only"),
                    installed: false,
                    enabled: true,
                    callable: null,
                  },
                ],
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
      "/api/threads": {
        data: !deleted && new URL(req.url()).searchParams.get("archived") !== "true" ? [task] : [],
        nextCursor: null,
      },
      "/api/selfhost/thread-summary": { thread: deleted ? null : task },
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
  await page.goto(new URL("/?" + new URLSearchParams({ host: String(hostId), cwd }), origin).href, {
    waitUntil: "domcontentloaded",
  });
  const taskRow = page.getByTestId(`task-item-${taskId}`).first();
  const deleteItem = page.getByTestId("task-permanent-delete");
  if (page.viewportSize().width < 600) {
    await taskRow.scrollIntoViewIfNeeded();
    const rowBox = await taskRow.boundingBox();
    assert(rowBox);
    const touch = await page.context().newCDPSession(page);
    try {
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: rowBox.x + 24, y: rowBox.y + rowBox.height / 2 }],
      });
      await deleteItem.waitFor({ timeout: 5000 });
    } finally {
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await touch.detach();
    }
  } else await taskRow.click({ button: "right" });
  await deleteItem.waitFor();
  for (const label of ["反馈问题", "查看模型调用轨迹"])
    assert.equal(await page.getByRole("menuitem", { name: label, exact: true }).count(), 0);
  await deleteItem.click();
  const deletion = page.getByTestId("selfhost-task-delete-confirmation");
  await deletion.getByText(/Deletion fixture/).waitFor();
  assert.equal(deletionRequests.length, 0);
  await deletion.getByRole("button", { name: /^取消/ }).click();
  await deletion.waitFor({ state: "hidden" });
  assert.equal(deletionRequests.length, 0);
  await taskRow.click({ button: "right" });
  await deleteItem.click();
  await deletion.getByTestId("confirm-dialog-confirm").click();
  await page.getByText(/Fixture deletion denied/).waitFor();
  assert(await taskRow.isVisible());
  assert.equal(deletionRequests.length, 1);
  rejectDelete = false;
  await taskRow.click({ button: "right" });
  await deleteItem.click();
  await deletion.getByTestId("confirm-dialog-confirm").click();
  await taskRow.waitFor({ state: "detached" });
  assert.equal(deletionRequests.length, 2);
  const entry = page.getByTestId("plugin-store-sidebar-open");
  await entry.waitFor();
  assert.equal((await entry.innerText()).trim(), "扩展");
  await entry.click();
  const extensions = page.getByTestId("workspace-extensions");
  const categories = extensions.getByRole("navigation", { name: "扩展", exact: true });
  const selectedCategory = categories.getByRole("button", { pressed: true });
  await extensions.getByTestId("plugin-store-browse").waitFor();
  assert.equal(await selectedCategory.getAttribute("data-testid"), "workspace-extensions-plugins");
  assert.equal(await extensions.getByRole("tablist").count(), 0);
  await extensions.getByTestId("plugin-store-browse").click();
  const market = extensions.getByTestId("plugin-store-root");
  await market.getByTestId("plugin-store-title").waitFor();
  assert.equal(await selectedCategory.getAttribute("data-testid"), "workspace-extensions-plugins");
  await market.getByRole("button", { name: "返回", exact: true }).click();
  await extensions.getByTestId("plugin-store-browse").waitFor();
  assert.equal(await extensions.getByRole("tablist").count(), 0);
  await extensions.getByTestId("workspace-extensions-skills").click();
  await extensions.getByTestId("plugin-settings-scope-trigger").waitFor();
  assert.equal(await selectedCategory.getAttribute("data-testid"), "workspace-extensions-skills");
  assert.equal(await extensions.getByRole("tablist").count(), 0);
  await extensions.getByTestId("workspace-extensions-apps").click();
  await extensions.getByTestId("codex-app-drive").waitFor();
  assert.equal(await selectedCategory.getAttribute("data-testid"), "workspace-extensions-apps");
  await extensions.getByRole("button", { name: "使用 Drive", exact: true }).click();
  await page.locator('[contenteditable="true"] [data-mention-id="app:drive"]').waitFor();
  if (page.viewportSize().width < 600) {
    await page
      .locator('[data-mobile-page="chat"]')
      .getByRole("button", { name: "返回任务首页", exact: true })
      .click();
  }
  await page.getByTestId("task-settings-button").click();
  for (const section of ["browser", "memory", "commands", "subagents", "projects"])
    assert.equal(await page.locator(`[data-settings-section-nav="${section}"]`).count(), 0);
  assert.equal(await page.locator('[data-settings-search-id="settings.httpProxy"]').count(), 0);
  await page.locator('[data-settings-section-nav="mcp"]').click();
  await page
    .getByTestId("selfhost-settings-mcp")
    .getByText("fixture-mcp", { exact: true })
    .waitFor();
  await page.locator('[data-settings-section-nav="hooks"]').click();
  await page
    .getByTestId("selfhost-settings-hooks")
    .getByText("SessionStart", { exact: true })
    .waitFor();
  await page.locator('[data-settings-section-nav="shares"]').click();
  await page.locator('[data-testid="share-management"][data-state="ready"]').waitFor();
  await page.locator('[data-settings-section-nav="personalization"]').click();
  const editor = page.getByTestId("settings-personalization-editor");
  await page.getByText(instructionsPath, { exact: true }).waitFor();
  assert.equal(await editor.inputValue(), "Original Codex instructions");
  await editor.fill("Updated Codex instructions");
  await page.getByTestId("settings-personalization-save").click();
  await page.getByText("已保存，新会话生效", { exact: true }).waitFor();
  assert.equal(instructions, "Updated Codex instructions");
  const appNav = page.locator('[data-settings-section-nav="codexApps"]');
  await appNav.click();
  const row = page.getByTestId("codex-app-drive");
  await row.getByRole("button", { name: "Drive", exact: true }).click();
  await page.getByRole("button", { name: "在新对话中使用" }).waitFor();
  assert.equal(directoryReads.length, 0);
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
  await row.getByRole("button", { name: "Drive", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "在新对话中使用" }).count(), 0);
  await page.getByRole("button", { name: "返回", exact: true }).last().click();
  await page.getByRole("button", { name: "浏览应用", exact: true }).click();
  await page.getByTestId("codex-app-directory-only").waitFor();
  assert.equal(
    await page.getByRole("button", { name: "使用 Directory only", exact: true }).count(),
    0,
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
  await page.getByTestId("codex-apps-installed").click();
  await row.getByRole("switch").click();
  await row.locator('[role="switch"][aria-checked="true"]').waitFor();
  await row.getByRole("button", { name: "Drive", exact: true }).click();
  await page.getByRole("button", { name: "在新对话中使用" }).click();
  await page.getByTestId("settings-page").waitFor({ state: "hidden" });
  await page
    .locator('[contenteditable="true"] [data-mention-id="app:drive"]')
    .waitFor()
    .catch(async (cause) => {
      const snapshot = await page.evaluate(() => ({
        editors: [...document.querySelectorAll('[contenteditable="true"]')].map(
          (el) => el.innerText,
        ),
        mentions: [...document.querySelectorAll("[data-mention-id]")].map(
          (el) => el.dataset.mentionId,
        ),
        alerts: [...document.querySelectorAll('[role="alert"],[role="status"]')].map(
          (el) => el.textContent,
        ),
        savedDraft: Object.entries(localStorage).filter(([key]) => /composer|draft/i.test(key)),
      }));
      throw Error("App draft after leaving settings: " + JSON.stringify(snapshot), { cause });
    });
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
    page.setDefaultTimeout(60000);
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
