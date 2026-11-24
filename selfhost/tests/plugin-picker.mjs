import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { build, preview } from "vite";
import {
  composerPicker,
  revealPickerItem,
  revealPickerOption,
} from "./fixtures/composer-picker.mjs";

const web = resolve(import.meta.dirname, "../../packages/web");
const hostId = 2;
const cwd = "/picker-fixture";
const threadId = "picker-fixture";
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
const repoSkill = { name: "Review", path: cwd + "/.agents/skills/review/SKILL.md", scope: "repo" };
const userSkill = {
  name: "Review",
  path: "/fixtures/user/.agents/skills/review/SKILL.md",
  scope: "user",
};
const pluginSkill = {
  name: "Review",
  path: "/fixtures/plugins/review/SKILL.md",
  scope: "user",
  pluginId: "review@local",
};
const pickerButton = (page) => page.getByRole("button", { name: "添加上下文", exact: true });

async function verify(page, origin) {
  let failSkills = true;
  const detailQueries = [];
  const pageErrors = [];
  let captureSend;
  const submitted = new Promise((resolve) => (captureSend = resolve));
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("selfhost.auth", "picker-test-fixture");
    localStorage.setItem("zcode-locale-preference", "zh-CN");
  });
  await page.route(new URL("/api/**", origin).href, async (route) => {
    const url = new URL(route.request().url());
    const request = route.request().postDataJSON();
    const project = { hostId, remotePath: cwd, name: "引用测试项目" };
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
        const skills = [repoSkill, userSkill, pluginSkill].map((skill) => ({
          ...skill,
          description: "",
          enabled: true,
        }));
        return route.fulfill({ json: { value: { data: [{ cwd, skills, errors: [] }] } } });
      }
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
      "/api/selfhost/thread-summary": { thread },
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
          const items = [
            { id: "input", type: "userMessage", content: [{ type: "text", text: "验收引用目录" }] },
          ];
          return reply({
            type: "thread.snapshot",
            thread,
            history: {
              thread: { ...thread, turns: [{ id: "turn-1", status: "completed", items }] },
            },
            lastEventId: 0,
            eventEpoch: "picker-fixture",
          });
        }
        case "project.defaults.read":
          return reply({ defaults: { model: model.model } });
        case "thread.goal.get":
          return reply({ goal: null });
        case "thread.native.controls":
          return reply({ queue: false });
        case "turn.start":
          captureSend(call);
          return reply({ type: "turn.start.accepted", turnId: "turn-2" });
        case "ping":
          return reply({ type: "pong", nonce: call.nonce });
        default:
          if (call.requestId) return reply({ type: "fixture.result" });
      }
    });
  });
  const url = new URL("/", origin);
  url.search = new URLSearchParams({ host: String(hostId), cwd, thread: threadId });
  await page.goto(url.href);
  await page.getByText("验收引用目录", { exact: true }).waitFor({ timeout: 20000 });
  const picker = composerPicker(page);
  const editor = page.locator('[contenteditable="true"]').first();
  const open = async () => {
    await pickerButton(page).click();
    await picker.waitFor();
    await picker.locator('[role="option"][data-section-id="plugins"]').first().waitFor();
  };
  const select = async (optionId, description) => {
    await open();
    const option = await revealPickerOption(picker, optionId);
    assert(await option.isEnabled(), optionId + " should be selectable");
    if (description) assert((await option.innerText()).includes(description));
    await option.click();
    await picker.waitFor({ state: "hidden" });
  };

  await open();
  const skillStatus = await revealPickerItem(picker, "prompt-suggestion-status-skills");
  await skillStatus.and(page.locator('[data-status="error"]')).waitFor();
  const appTools = await revealPickerOption(picker, "plugin:codex-app-tools@bundled");
  assert.equal(await appTools.innerText(), "Codex App Tools");
  assert.equal(await picker.locator('[data-option-id="plugin:disabled@bundled"]').count(), 0);
  assert.equal(await picker.locator('[data-option-id="plugin:available@bundled"]').count(), 0);
  await page.keyboard.press("Escape");

  // Native plugin IDs remain distinct when the configured manifest names and display labels match.
  await select("plugin:review@local", "local");
  await select("plugin:review@bundled", "bundled");

  failSkills = false;
  const waitForSkills = page.waitForResponse(
    (response) => response.ok() && response.request().postDataJSON()?.method === "skills/list",
  );
  await open();
  await waitForSkills;
  await page.keyboard.press("Escape");
  // All three native skill paths remain selectable with the same display name.
  await select("skill:" + repoSkill.path, repoSkill.path);
  await select("skill:" + userSkill.path, userSkill.path);
  await select("skill:" + pluginSkill.path, pluginSkill.path);

  for (const id of [
    "plugin:review@local",
    "plugin:review@bundled",
    ...[repoSkill, userSkill, pluginSkill].map((skill) => "skill:" + skill.path),
  ]) {
    const chip = editor.locator('[data-mention-id="' + id + '"]');
    assert.equal(await chip.count(), 1);
  }
  await page.getByTestId("v4-composer-send").click();
  const signal = AbortSignal.timeout(5000);
  const sent = await Promise.race([
    submitted,
    new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
    ),
  ]);
  assert.equal(sent.threadId, threadId);
  for (const ref of [
    "plugin://review@local",
    "plugin://review@bundled",
    ...[repoSkill, userSkill, pluginSkill].map((x) => x.path),
  ])
    assert(
      JSON.stringify(sent).includes(ref),
      "Selected identities must be carried through delivery",
    );
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
    for (const width of [1236, 390]) {
      const page = await browser.newPage({
        viewport: { width, height: 820 },
        isMobile: width === 390,
        hasTouch: width === 390,
      });
      page.setDefaultTimeout(10000);
      try {
        await verify(page, origin);
        console.log("PASS self-hosted native plugin and Skill picker (" + width + "px)");
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
} finally {
  await server?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
}
