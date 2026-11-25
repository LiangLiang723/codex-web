import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { build, preview } from "vite";
import { repositorySummary } from "./fixtures/workspace-git.mjs";
import { nativeUserInputItems } from "../../packages/web/src/selfhost/nativeTurnInput.ts";
import { revealPickerItem, revealPickerOption } from "./fixtures/composer-picker.mjs";

const web = resolve(import.meta.dirname, "../../packages/web");
const hostId = 2;
const cwd = "/picker-fixture";
const threadId = "11111111-1111-4111-8111-111111111111";
const draftThreadId = "22222222-2222-4222-8222-222222222222";
const thread = {
  id: threadId,
  cwd,
  name: "引用测试",
  status: { type: "idle" },
  createdAt: 1,
  updatedAt: 2,
};
const model = {
  id: "fixture-model",
  model: "fixture-model",
  displayName: "Fixture Model",
  isDefault: true,
  defaultReasoningEffort: "low",
  supportedReasoningEfforts: [{ reasoningEffort: "low" }],
};
const app = {
  id: "connector_docs_42",
  name: "Fixture Docs",
  description: "Find fixture documents",
  installUrl: null,
  accessible: true,
  enabled: true,
  installed: true,
  callable: true,
  plugins: [],
};

const plugin = (marketplace, name, displayName, enabled = true) => ({
  id: name + "@" + marketplace,
  name,
  installed: true,
  enabled,
  interface: displayName ? { displayName } : null,
});
const marketplaces = [
  {
    name: "local",
    path: "/plugins/local/.codex-plugin/marketplace.json",
    plugins: [
      plugin("local", "review", "Review"),
      ...Array.from({ length: 24 }, (_, index) => plugin("local", "plugin-" + index)),
    ],
  },
  {
    name: "bundled",
    path: null,
    plugins: [
      plugin("bundled", "codex-app-tools", "Codex App Tools"),
      plugin("bundled", "review", "Review"),
      plugin("bundled", "disabled", "Disabled", false),
      { ...plugin("bundled", "available", "Available"), installed: false },
    ],
  },
];
const repoSkill = {
  name: "review",
  path: cwd + "/.agents/skills/review (repo)/SKILL.md",
  scope: "repo",
};
const userSkill = {
  name: "review",
  path: "/fixtures/user/.agents/skills/review/SKILL.md",
  scope: "user",
};
const pluginSkill = {
  name: "review:review",
  interface: { displayName: "review" },
  path: "/fixtures/plugins/review/SKILL.md",
  scope: "user",
  pluginId: "review@local",
};
const systemSkill = {
  name: "internal-review",
  path: "/fixtures/codex/internal-review/SKILL.md",
  scope: "system",
};
const pickerButton = (page) => page.getByTestId("chat-attachment-button");
const noApps = "可在「扩展 → 应用」中连接或启用应用";
const unloadedApps = "Fixture thread is not loaded";
const legacyMention = "旧消息 [@Legacy](plugin://legacy@local)";

async function verify(page, origin) {
  let failSkills = true;
  let appDirectory = "unloaded";
  const { width } = page.viewportSize();
  const mobile = width === 390;
  const petPlacement = mobile ? "composer" : "rail";
  const screenshots = process.env.SELFHOST_BRAND_SCREENSHOTS;
  const snapshot = async (name) => {
    if (!screenshots) return;
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, `${name}-${width}.png`) });
  };
  const activate = (locator) => (mobile ? locator.tap() : locator.click());
  const showTaskList = async () => {
    if (mobile) await activate(page.getByRole("button", { name: "返回任务首页", exact: true }));
  };
  const appQueries = [];
  const detailQueries = [];
  const pageErrors = [];
  const submissions = [];
  const creations = [];
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
  await page.addInitScript(() => {
    localStorage.setItem("selfhost.auth", "picker-test-fixture");
    localStorage.setItem("zcode-locale-preference", "zh-CN");
  });
  await page.route(new URL("/api/**", origin).href, async (route) => {
    const url = new URL(route.request().url());
    const request = route.request().postDataJSON();
    const project = { hostId, remotePath: cwd, name: "引用测试项目" };
    if (url.pathname === "/api/selfhost/apps" && request?.operation === "available") {
      assert.equal(request.hostId, hostId);
      appQueries.push(request);
      if (appDirectory === "unloaded" && request.threadId) {
        return route.fulfill({ status: 404, json: { message: unloadedApps } });
      }
      return route.fulfill({ json: { apps: appDirectory === "empty" ? [] : [app] } });
    }
    if (url.pathname === "/api/selfhost/apps") {
      assert.equal(request.hostId, hostId);
      assert(["installed", "list"].includes(request.operation));
      return route.fulfill({
        json: {
          apps: [app],
          nextCursor: null,
          runtimeKnown: true,
          directoryIssue: null,
          runtimeIssue: null,
        },
      });
    }
    if (url.pathname === "/api/selfhost/workspace" && request?.method === "searchWorkspaceFiles") {
      return route.fulfill({
        json: {
          value: [
            {
              name: "fixture.md",
              path: cwd + "/fixture.md",
              relativePath: "fixture.md",
              type: "file",
            },
          ],
        },
      });
    }
    if (url.pathname === "/api/selfhost/plugins") {
      assert.equal(request.operation, "catalog");
      assert.equal(request.hostId, hostId);
      assert.equal(request.cwd, cwd);
      return route.fulfill({ json: { value: { entries: [], markets: [], issues: [] } } });
    }
    if (url.pathname === "/api/selfhost/capability") {
      if (request?.method === "plugin/read") {
        detailQueries.push(request);
        return route.fulfill({ status: 503, json: { message: "Fixture marketplace offline" } });
      }
      if (request?.method === "plugin/installed") {
        assert.equal(request.hostId, hostId);
        assert.deepEqual(request.params.cwds, [cwd]);
        return route.fulfill({ json: { value: { marketplaces } } });
      }
      if (request?.method === "skills/list") {
        assert.equal(request.hostId, hostId);
        assert.deepEqual(request.params.cwds, [cwd]);
        if (failSkills)
          return route.fulfill({ status: 503, json: { message: "Fixture skills unavailable" } });
        const skills = [repoSkill, userSkill, pluginSkill, systemSkill].map((skill) => ({
          ...skill,
          description: "",
          enabled: true,
        }));
        return route.fulfill({ json: { value: { data: [{ cwd, skills, errors: [] }] } } });
      }
    }
    if (request?.channel === "git" && request.method === "refresh") {
      return route.fulfill({
        json: {
          value: {
            summary: repositorySummary(cwd, "main"),
            stagedChanges: [],
            unstagedChanges: [],
          },
        },
      });
    }
    if (request?.channel === "git" && request.method === "getLocalBranches") {
      return route.fulfill({
        json: {
          value: {
            headRefType: "branch",
            currentBranchName: "main",
            branches: [{
              name: "main",
              isCurrent: true,
              upstreamName: null,
              commitHash: null,
              commitTimestampMs: null,
            }],
          },
        },
      });
    }
    const values = {
      "/api/hosts": [
        {
          id: hostId,
          name: "Fixture",
          sshHost: "fixture",
          username: null,
          port: null,
          authMode: "agent",
        },
      ],
      "/api/selfhost/projects": url.searchParams.get("organization")
        ? { items: [project], memberships: { [threadId]: cwd } }
        : [project],
      "/api/selfhost/thread-summary": {
        thread: { ...thread, id: url.searchParams.get("threadId") ?? threadId },
      },
      "/api/threads": {
        data: url.searchParams.get("archived") === "true" ? [] : [thread],
        nextCursor: null,
      },
      "/api/models": { data: [model], nextCursor: null },
      "/api/selfhost/settings": { locale: "zh-CN" },
      "/api/selfhost/organization": {
        value:
          request?.channel === "task-groups"
            ? { revision: 0, members: [], groups: [], order: [] }
            : [],
      },
      "/api/selfhost/capability": { value: [] },
      "/api/selfhost/workspace": {
        value: request?.channel === "system" ? { homedir: cwd, platform: "darwin" } : [],
      },
    };
    return route.fulfill({ json: values[url.pathname] ?? {} });
  });
  await page.routeWebSocket("**/api/realtime", (ws) => {
    ws.onMessage((data) => {
      const call = JSON.parse(data);
      const reply = (message) => ws.send(JSON.stringify({ ...message, requestId: call.requestId }));
      switch (call.type) {
        case "auth.authenticate":
          return reply({ type: "ready" });
        case "thread.activate": {
          const activeThread = { ...thread, id: call.threadId };
          const turns =
            call.threadId === threadId
              ? ["验收引用目录", legacyMention].map((text, index) => ({
                  id: `turn-${index + 1}`,
                  status: "completed",
                  items: [
                    {
                      id: `input-${index}`,
                      type: "userMessage",
                      content: [{ type: "text", text }],
                    },
                  ],
                }))
              : [];
          for (const submission of submissions) {
            if (submission.command.threadId === call.threadId) turns.push(submission.turn);
          }
          return reply({
            type: "thread.snapshot",
            thread: activeThread,
            history: { thread: { ...activeThread, turns } },
            lastEventId: submissions.length,
            eventEpoch: "picker-fixture",
          });
        }
        case "project.defaults.read":
          return reply({ defaults: { model: model.model } });
        case "thread.goal.get":
          return reply({ goal: null });
        case "thread.native.controls":
          return reply({ queue: false });
        case "thread.start":
          creations.push(call);
          return reply({
            type: "thread.delivery.state",
            state: "created",
            threadId: draftThreadId,
          });
        case "turn.start": {
          const input = nativeUserInputItems(call);
          const turn = {
            id: call.deliveryId,
            status: "completed",
            items: [
              {
                type: "userMessage",
                id: call.deliveryId,
                clientId: call.deliveryId,
                content: input,
              },
            ],
          };
          submissions.push({ command: call, input, turn });
          reply({
            type: "thread.delivery.state",
            state: "accepted",
            threadId: call.threadId,
            delivery: "startNow",
            turnId: call.deliveryId,
          });
          // 宽布局切换任务时会保留订阅，必须通过原生完成事件更新它的历史。
          return ws.send(
            JSON.stringify({
              type: "thread.event",
              eventEpoch: "picker-fixture",
              event: {
                id: submissions.length,
                hostId,
                threadId: call.threadId,
                createdAt: new Date().toISOString(),
                event: { type: "turn.completed", turn },
              },
            }),
          );
        }
        case "ping":
          return reply({ type: "pong", nonce: call.nonce });
        default:
          if (call.requestId) return reply({ type: "fixture.result" });
      }
    });
  });
  const url = new URL("/", origin);
  url.search = new URLSearchParams({ host: String(hostId), cwd, thread: threadId });
  await page.goto(url.href, { waitUntil: "commit" });
  await page.getByText("验收引用目录", { exact: true }).waitFor({ timeout: 45000 });
  assert.equal(await page.title(), "Codex Web");
  const pet = page.locator("[data-codex-pet]");
  const waitForPetAtRest = () => pet.evaluate(async (node) => {
    await Promise.allSettled(node.getAnimations().map((animation) => animation.finished));
  });
  const dockedPet = pet.and(page.locator(`[data-pet-placement="${petPlacement}"]`));
  await dockedPet.waitFor();
  const canvas = pet.locator("svg");
  const favicon = page.locator('link[rel="icon"]');
  await page.waitForFunction(() => {
    const href = document.querySelector('link[rel="icon"]')?.getAttribute("href");
    return href?.endsWith("codex-bot-dark.svg");
  });
  assert.equal(await canvas.evaluate((node) => getComputedStyle(node).color), "rgb(255, 255, 255)");
  await page.locator('[data-plugin-mention-id="legacy@local"]').waitFor();
  const add = page.getByTestId("prompt-suggestion-panel").and(page.locator('[data-trigger="+"]'));
  const assertComposerWidth = async (panel) => {
    const [composer, popup] = await Promise.all([
      page.locator("form [data-composer-layout]").boundingBox(),
      panel.boundingBox(),
    ]);
    assert(composer && popup);
    assert(Math.abs(composer.x - popup.x) < 1 && Math.abs(composer.width - popup.width) < 1);
    assert(popup.y + popup.height <= composer.y);
  };
  const at = page.getByTestId("prompt-suggestion-panel").and(page.locator('[data-trigger="@"]'));
  const slash = page.getByTestId("prompt-suggestion-panel").and(page.locator('[data-trigger="/"]'));
  const dollar = page
    .getByTestId("prompt-suggestion-panel")
    .and(page.locator('[data-trigger="$"]'));
  const editor = page.getByTestId("v4-composer-input");
  const send = page.getByTestId("v4-composer-send");
  await editor.focus();
  await page.keyboard.insertText("保留附件草稿");
  await activate(pickerButton(page));
  await add.waitFor();
  await assertComposerWidth(add);
  const checkContextMenu = async (panel) => {
    await panel.getByTestId("prompt-suggestion-section-add").waitFor();
    await panel.getByTestId("prompt-suggestion-option-add-attachment").waitFor();
    await panel.getByTestId("prompt-suggestion-option-add-plan").waitFor();
    await revealPickerOption(panel, "plugin:review@local");
  };
  await checkContextMenu(add);
  const remoteFile = add.getByTestId("prompt-suggestion-option-file:" + cwd + "/fixture.md");
  await activate(await revealPickerOption(add, "add-files"));
  await remoteFile.and(page.locator('[aria-selected="true"]')).waitFor();
  await activate(remoteFile);
  await add.waitFor({ state: "detached" });
  assert((await editor.innerText()).includes("保留附件草稿"));
  await editor.locator('[data-mention-id="file:' + cwd + '/fixture.md"]').waitFor();
  await editor.press("ControlOrMeta+a");
  await editor.press("Backspace");
  await page.keyboard.insertText("保留附件草稿");
  await activate(pickerButton(page));
  const fileChooser = page.waitForEvent("filechooser");
  await activate(await revealPickerOption(add, "add-attachment"));
  await (await fileChooser).setFiles([]);
  await add.waitFor({ state: "detached" });
  assert.equal(await editor.innerText(), "保留附件草稿");
  await editor.press("ControlOrMeta+a");
  await editor.press("Backspace");

  const open = async (optionKind = "plugin", query = "") => {
    await editor.focus();
    await page.keyboard.insertText("@" + query);
    await at.waitFor();
    await at
      .locator(`[role="option"][data-option-id^="${optionKind}:"]`)
      .first()
      .waitFor({ state: "attached" });
  };
  const closePicker = async (query = "") => {
    await page.keyboard.press("Escape");
    await at.waitFor({ state: "detached" });
    for (const _ of query) await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
  };
  const select = async (optionId, description) => {
    const kind = optionId.split(":", 1)[0];
    await open(kind, kind === "app" ? "fixture-docs" : "review");
    const option = await revealPickerOption(at, optionId);
    assert(await option.isEnabled(), optionId + " should be selectable");
    if (description) assert((await option.innerText()).includes(description));
    await activate(option);
    await at.waitFor({ state: "detached" });
  };

  await open();
  await assertComposerWidth(at);
  await checkContextMenu(at);
  const appStatus = await revealPickerItem(at, "prompt-suggestion-status-apps");
  await appStatus.and(page.locator('[data-status="error"]')).waitFor();
  assert.equal(await appStatus.textContent(), unloadedApps);
  assert(appQueries.length > 0 && appQueries.every((query) => query.threadId === threadId));
  const skillStatus = await revealPickerItem(at, "prompt-suggestion-status-skills");
  await skillStatus.and(page.locator('[data-status="error"]')).waitFor();
  await closePicker();
  await editor.focus();
  await page.keyboard.insertText("@codex-app-tools");
  const appTools = at.getByTestId("prompt-suggestion-option-plugin:codex-app-tools@bundled");
  await appTools.waitFor();
  assert.equal(await appTools.innerText(), "Codex App Tools");
  await editor.press("ControlOrMeta+a");
  await editor.press("Backspace");
  for (const plugin of ["disabled", "available"]) {
    await page.keyboard.insertText("@" + plugin);
    await at.waitFor();
    assert.equal(await at.locator('[data-option-id="plugin:' + plugin + '@bundled"]').count(), 0);
    await editor.press("ControlOrMeta+a");
    await editor.press("Backspace");
  }

  appDirectory = "empty";
  await open();
  await (await revealPickerItem(at, "prompt-suggestion-status-apps")).getByText(noApps).waitFor();
  await closePicker();
  await editor.focus();
  await page.keyboard.insertText("$");
  await dollar.getByText(noApps, { exact: true }).waitFor();
  await page.keyboard.press("Backspace");
  await dollar.waitFor({ state: "hidden" });
  await page.keyboard.insertText("验收🧪 ");

  appDirectory = "loaded";
  await select("app:" + app.id, app.description);
  assert.equal(appQueries.at(-1).threadId, threadId);

  // Native plugin IDs remain distinct when the configured manifest names and display labels match.
  await select("plugin:review@local", "local");
  await select("plugin:review@bundled", "bundled");

  failSkills = false;
  // All three native skill paths remain selectable with the same display name.
  await open("skill", systemSkill.name);
  const builtIn = await revealPickerOption(at, "skill:" + systemSkill.path);
  assert.match(await builtIn.textContent(), /Codex 内置/u);
  await closePicker(systemSkill.name);
  await select("skill:" + repoSkill.path, repoSkill.path);
  await select("skill:" + userSkill.path, userSkill.path);
  await select("skill:" + pluginSkill.path, `${pluginSkill.pluginId} · ${pluginSkill.path}`);

  const chosen = [
    "app:" + app.id,
    "plugin:review@local",
    "plugin:review@bundled",
    ...[repoSkill, userSkill, pluginSkill].map((skill) => "skill:" + skill.path),
  ];
  const chip = (id) => editor.locator('[data-mention-id="' + id + '"]');
  for (const id of chosen) await chip(id).waitFor();
  await page.reload({ waitUntil: "commit" });
  for (const id of chosen) await chip(id).waitFor({ timeout: 45000 });
  assert.match(await editor.innerText(), /^验收🧪 /u);
  assert.equal(submissions.length, 0, "restoring the draft must not submit it");

  await activate(send);
  await editor.locator('[data-mention-category="apps"]').waitFor({ state: "detached" });
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].command.threadId, threadId);
  assert.equal(
    submissions[0].input[0].text,
    "验收🧪 $fixture-docs @review @review $review $review $review:review",
  );
  assert.equal(
    submissions[0].input[0].text_elements[0].byteRange.start,
    Buffer.byteLength("验收🧪 "),
  );
  assert.deepEqual(submissions[0].input.slice(1), [
    { type: "mention", name: app.name, path: "app://" + app.id },
    { type: "mention", name: "review", path: "plugin://review@local" },
    { type: "mention", name: "review", path: "plugin://review@bundled" },
    ...[repoSkill, userSkill, pluginSkill].map(({ name, path }) => ({ type: "skill", name, path })),
  ]);
  const historyApp = page.locator('[data-app-mention-id="' + app.id + '"]');
  await showTaskList();
  await activate(page.getByTestId("task-new-button"));
  await page.waitForURL((windowUrl) => !windowUrl.searchParams.has("thread"));
  await editor.waitFor();
  await pet.and(page.locator('[data-pet-placement="draft"]')).waitFor();
  await waitForPetAtRest();
  const draftPet = await pet.elementHandle();
  const greeting = page.locator("[data-v4-draft-greeting]");
  await greeting.waitFor();
  assert((await pet.boundingBox()).y < (await greeting.boundingBox()).y);
  assert.equal(await page.locator("[data-v4-draft-logo]").count(), 0);
  await snapshot("bot-draft-dark");
  await editor.focus();
  await activate(pickerButton(page));
  await activate(await revealPickerOption(add, "add-project"));
  await page.getByTestId("composer-project-menu").waitFor();
  await page.keyboard.press("Escape");
  await page.getByTestId("composer-project-menu").waitFor({ state: "detached" });
  await editor.focus();
  await page.keyboard.insertText("/review");
  await activate(await revealPickerOption(slash, "draft-slash:review"));
  assert.match(await editor.innerText(), /审查当前工作区中未提交的更改/u);
  assert.equal(submissions.length, 1, "Review only fills the draft");
  await editor.press("ControlOrMeta+a");
  await editor.press("Backspace");

  await activate(pickerButton(page));
  await add.waitFor();
  await page.keyboard.insertText("/model");
  await add.waitFor({ state: "detached" });
  await activate(await revealPickerOption(slash, "app-slash:model"));
  const modelPicker = page.getByTestId("composer-model-panel");
  await modelPicker.waitFor();
  await page.keyboard.press("Escape");
  await modelPicker.waitFor({ state: "detached" });

  await editor.focus();
  await page.keyboard.insertText("保留正文 /plan");
  await assertComposerWidth(slash);
  await activate(await revealPickerOption(slash, "app-slash:plan"));
  const planMarker = page.getByTestId("v4-composer-plan-marker");
  await planMarker.waitFor();
  assert.equal((await editor.innerText()).trim(), "保留正文");
  await activate(planMarker.getByRole("button"));
  await editor.press("ControlOrMeta+a");
  await editor.press("Backspace");
  await page.keyboard.insertText("/goal");
  await activate(await revealPickerOption(slash, "slash:goal"));
  await editor.locator('[data-mention-id="slash:goal"]').waitFor();
  assert.equal(submissions.length, 1, "Choosing a goal only fills the input");
  await editor.press("ControlOrMeta+a");
  await editor.press("Backspace");
  await page.keyboard.insertText("$fixture-docs");
  const appOption = dollar.getByTestId("prompt-suggestion-option-app:" + app.id);
  await appOption.waitFor();
  assert.equal(appQueries.at(-1).threadId, undefined);
  if (mobile) await activate(appOption);
  else {
    await appOption.and(page.locator('[aria-selected="true"]')).waitFor();
    await page.keyboard.press("Enter");
  }
  await chip("app:" + app.id).waitFor();
  await page.keyboard.insertText("$review");
  await activate(dollar.getByTestId("prompt-suggestion-option-skill:" + repoSkill.path));
  await chip("skill:" + repoSkill.path).waitFor();
  await page.keyboard.insertText("@plugin-23");
  await activate(at.getByTestId("prompt-suggestion-option-plugin:plugin-23@local"));
  await activate(send);
  await page.waitForURL((windowUrl) => windowUrl.searchParams.get("thread") === draftThreadId);
  await dockedPet.waitFor();
  assert.equal(
    await pet.evaluate((node, fromDraft) => node === fromDraft, draftPet),
    true,
    "The draft Bot and docked Bot share one mounted element",
  );
  await waitForPetAtRest();
  const dock = page.locator("[data-v4-composer-dock-content]");
  const [petRect, dockRect] = await Promise.all([pet.boundingBox(), dock.boundingBox()]);
  if (mobile) {
    assert(petRect.x + petRect.width <= dockRect.x + dockRect.width);
    assert(petRect.y + petRect.height < (await editor.boundingBox()).y);
  } else {
    assert(petRect.x >= dockRect.x + dockRect.width);
    const panel = await page.getByTestId("selfhost-status-panel").boundingBox();
    assert(petRect.y > panel.y + panel.height);
  }
  await snapshot("bot-docked-dark");
  assert.equal(creations.length, 1);
  assert.equal(submissions.length, 2);
  assert.equal(submissions[1].command.threadId, draftThreadId);
  assert.equal(submissions[1].command.deliveryId, creations[0].deliveryId);
  assert.deepEqual(submissions[1].input.slice(1), [
    { type: "mention", name: app.name, path: "app://" + app.id },
    { type: "skill", name: repoSkill.name, path: repoSkill.path },
    { type: "mention", name: "plugin-23", path: "plugin://plugin-23@local" },
  ]);
  await historyApp.waitFor();
  await showTaskList();
  await activate(page.getByTestId(`task-item-${threadId}`));
  await page.waitForURL((windowUrl) => windowUrl.searchParams.get("thread") === threadId);
  await historyApp.waitFor();
  for (const pluginId of ["review@local", "review@bundled", "legacy@local"]) {
    assert.equal(await page.locator('[data-plugin-mention-id="' + pluginId + '"]').count(), 1);
  }
  assert.equal(submissions.length, 2, "replaying history must not send another turn");
  await editor.focus();
  await page.keyboard.insertText("管理页往返草稿");
  await showTaskList();
  await activate(page.getByTestId("plugin-store-sidebar-open"));
  const extensions = page.getByTestId("workspace-extensions");
  for (const section of ["plugins", "apps", "skills"]) {
    await activate(extensions.getByTestId(`workspace-extensions-${section}`));
    await extensions
      .getByTestId(`workspace-extensions-${section}`)
      .and(page.locator('[aria-pressed="true"]'))
      .waitFor();
  }
  await activate(extensions.getByRole("button", { name: "返回", exact: true }));
  if (mobile) await activate(page.getByTestId(`task-item-${threadId}`));
  await editor.getByText("管理页往返草稿", { exact: true }).waitFor();
  assert.equal(submissions.length, 2, "extension management must leave the draft unsent");
  await showTaskList();
  await activate(page.getByTestId("task-settings-button"));
  await activate(page.getByTestId("settings-search-open"));
  await page.getByTestId("settings-search-input").fill("桌宠");
  await activate(page.locator('[data-settings-search-result="settings.conversationPet"]'));
  await page.locator('[data-settings-search-id="settings.conversationPet"][data-settings-search-highlighted]').waitFor();
  const petToggle = page.getByRole("switch", { name: "桌宠", exact: true });
  assert.equal(await petToggle.getAttribute("aria-checked"), "true");
  await activate(petToggle);
  assert.equal(await petToggle.getAttribute("aria-checked"), "false");
  const themeSelect = page.locator('[data-settings-search-id="settings.themeMode"]').getByRole("combobox");
  await activate(themeSelect);
  await activate(page.getByRole("option", { name: "浅色", exact: true }));
  await page.waitForFunction(() =>
    document.querySelector('link[rel="icon"]')?.getAttribute("href")?.endsWith("codex-bot-light.svg"),
  );
  const lightIcon = await favicon.getAttribute("href");
  assert.match(await (await page.request.get(new URL(lightIcon, origin).href)).text(), /fill="#161616"/);
  await page.reload();
  await editor.waitFor();
  assert.equal(await pet.count(), 0);
  await showTaskList();
  await activate(page.getByTestId("task-settings-button"));
  await activate(page.locator('[data-settings-section-nav="appearance"]'));
  assert.equal(await petToggle.getAttribute("aria-checked"), "false");
  await activate(petToggle);
  assert.equal(await petToggle.getAttribute("aria-checked"), "true");
  await activate(page.getByTestId("settings-back-button"));
  if (mobile) {
    const targetTask = page.getByTestId(`task-item-${threadId}`);
    await activate(targetTask);
  }
  await dockedPet.waitFor();
  assert.equal(await canvas.evaluate((node) => getComputedStyle(node).color), "rgb(22, 22, 22)");
  await showTaskList();
  await activate(page.getByTestId("task-new-button"));
  await pet.and(page.locator('[data-pet-placement="draft"]')).waitFor();
  await waitForPetAtRest();
  await snapshot("bot-draft-light");
  if (!mobile) {
    await activate(page.getByTestId("task-settings-button"));
    await activate(page.locator('[data-settings-section-nav="appearance"]'));
    await activate(themeSelect);
    await activate(page.getByRole("option", { name: "系统", exact: true }));
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(() =>
      document.querySelector('link[rel="icon"]')?.getAttribute("href")?.endsWith("codex-bot-dark.svg"),
    );
  }
  assert.deepEqual(detailQueries, [], "Loading references must make no per-plugin detail calls");
  assert.deepEqual(pageErrors, []);
}

const target = process.env.SELFHOST_PLUGIN_PICKER_TEST_URL;
const outDir = target ? null : await mkdtemp(join(tmpdir(), "selfhost-plugin-picker-"));
let server;
try {
  if (outDir) {
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
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const failures = [];
    for (const width of [1236, 390]) {
      const page = await browser.newPage({
        viewport: { width, height: 820 },
        isMobile: width === 390,
        hasTouch: width === 390,
      });
      page.setDefaultTimeout(10000);
      try {
        await verify(page, origin);
        console.log(
          "PASS self-hosted App, Skill and plugin picker, first and later turns, replay (" +
            width +
            "px)",
        );
      } catch (error) {
        console.error(
          `Composer browser acceptance failed at ${width}px.`,
          await page.locator("[data-codex-pet], [data-codex-pet-anchor]").evaluateAll((nodes) =>
            nodes.map((node) => ({
              anchor: node.dataset.codexPetAnchor,
              placement: node.dataset.petPlacement,
              display: getComputedStyle(node).display,
              visibility: getComputedStyle(node).visibility,
              top: node.getBoundingClientRect().top,
              height: node.getBoundingClientRect().height,
            })),
          ),
          await page
            .locator("body")
            .innerText({ timeout: 3000 })
            .catch(() => ""),
        );
        failures.push(error);
      } finally {
        await page.close();
      }
    }
    if (failures.length) throw new AggregateError(failures, "Composer browser acceptance failed");
  } finally {
    await browser.close();
  }
} finally {
  await server?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
}
