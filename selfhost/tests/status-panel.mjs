import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { build, preview } from "vite";

const web = resolve(import.meta.dirname, "../../packages/web");
const hostId = 1;
const cwd = "/status-fixture";
const threadId = "status-parent";
const otherId = "status-other";
const childId = "status-child";
const makeThread = (id, name) => ({
  id,
  cwd,
  name,
  createdAt: 10,
  updatedAt: 20,
  status: { type: "idle" },
});
const parent = makeThread(threadId, "工作区状态栏测试");
const other = makeThread(otherId, "第二个任务");
const child = {
  ...makeThread(childId, "子智能体详情"),
  parentThreadId: threadId,
};
const model = {
  id: "fixture-model",
  model: "fixture-model",
  displayName: "Fixture Model",
  isDefault: true,
  defaultReasoningEffort: "low",
  supportedReasoningEfforts: [{ reasoningEffort: "low" }],
};
const typedLink = "https://docs.example.com/user";
const assistantLink = "https://chat.example.com/invented";
const resultLink = "https://docs.example.com/result";
const visitLink = "https://docs.example.com/visit";
const queryLink = "https://docs.example.com/query-only";
const userItem = (id, text) => ({ id, type: "userMessage", content: [{ type: "text", text }] });
const activity = {
  id: "activity",
  type: "subAgentActivity",
  kind: "started",
  agentThreadId: childId,
  agentPath: "项目审阅",
};
const collab = {
  id: "collab",
  type: "collabAgentToolCall",
  tool: "spawnAgent",
  status: "completed",
  senderThreadId: threadId,
  receiverThreadIds: [childId],
  agentsStates: { [childId]: { status: "running", message: null } },
};
const plan = {
  id: "plan",
  type: "turnPlan",
  plan: [
    { step: "清点工作树", status: "completed" },
    { step: "核查原生事件", status: "inProgress" },
    { step: "完成发布验收", status: "pending" },
  ],
};
const sourceItems = [
  {
    id: "search",
    type: "webSearch",
    query: queryLink,
    action: { type: "search" },
    results: [
      { url: resultLink, title: "原生响应说明" },
      { url: resultLink },
      { url: "javascript:alert(1)" },
    ],
  },
  { id: "visit", type: "webSearch", query: "open", action: { type: "openPage", url: visitLink } },
  {
    id: "tool",
    type: "mcpToolCall",
    tool: "read_thread",
    server: "chatgpt",
    status: "completed",
    appContext: { connectorId: "chatgpt", appName: "ChatGPT App Tools" },
  },
];
const threadItems = [
  userItem("prompt", "请检查工作区状态。 " + typedLink + " " + typedLink),
  { id: "response", type: "agentMessage", text: "需要核查提交与计划。 " + assistantLink },
  { id: "written-plan", type: "plan", text: "# 工作区发布方案\n\n核对原生事件后验证发布。" },
  plan,
  activity,
  collab,
  ...sourceItems,
];
const git = {
  workspacePath: cwd,
  repoRoot: cwd,
  workspaceInRepoPath: ".",
  autoRefreshWatchPaths: [],
  branchName: "feature/status",
  trackingBranchName: null,
  headRefType: "branch",
  ahead: 0,
  behind: 0,
  isDirty: true,
  isGitAvailable: true,
  isRepository: true,
};
const change = {
  path: cwd + "/example.txt",
  repoRelativePath: "example.txt",
  workspaceRelativePath: "example.txt",
  section: "unstaged",
  kind: "modified",
  added: 7,
  removed: 2,
  isStaged: false,
  isUntracked: false,
  isConflicted: false,
};
const turnId = "turn-1";
const objective = "校验原生投影和右侧会话状态";
const initialGoal = { objective, status: "budgetLimited", createdAt: 10, timeUsedSeconds: 93 };
const panel = (page) => page.getByTestId("selfhost-status-panel");
const sessionPane = (page, id) =>
  page.locator(`[data-v4-conversation-drop-target][data-session-id="${id}"]`);
const statusTrigger = (page, id = threadId) =>
  sessionPane(page, id).getByRole("button", { name: "打开会话状态", exact: true });

async function installFixture(page, origin) {
  let goal = initialGoal;
  let socket;
  let cursor = 0;
  let gitReviewed = false;
  let branchListed = false;
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    const text = message.text();
    if (text.includes("当前远程服务不支持 subagents.list") || text.includes("same key"))
      errors.push(text);
  });
  await page.addInitScript(() => {
    localStorage.setItem("selfhost.auth", "status-test-fixture");
    localStorage.setItem("zcode-locale-preference", "zh-CN");
  });
  await page.route(new URL("/api/**", origin).href, (route) => {
    const url = new URL(route.request().url());
    const request = route.request().postDataJSON();
    const project = { hostId, remotePath: cwd, name: "状态栏测试项目" };
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
        ? { items: [project], memberships: { [threadId]: cwd, [otherId]: cwd } }
        : [project],
      "/api/selfhost/thread-summary": {
        thread: [parent, child, other].find((item) => item.id === url.searchParams.get("threadId")),
      },
      "/api/threads": {
        data: url.searchParams.get("archived") === "true" ? [] : [parent, other],
        nextCursor: null,
      },
      "/api/models": { data: [model], nextCursor: null },
      "/api/selfhost/settings": { locale: "zh-CN", theme: "dark" },
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
    if (request?.channel === "git") {
      assert.equal(request.hostId, hostId);
      assert.equal(request.args[0].workspacePath, cwd);
      if (request.method === "refresh") {
        gitReviewed ||= request.args[0].includeBranchComparison === true;
        values[url.pathname] = {
          value: { summary: git, unstagedChanges: [change], stagedChanges: [] },
        };
      } else if (request.method === "getLocalBranches") {
        branchListed = true;
        values[url.pathname] = {
          value: {
            headRefType: "branch",
            currentBranchName: git.branchName,
            branches: [git.branchName, "main"].map((name) => ({
              name,
              isCurrent: name === git.branchName,
              upstreamName: null,
              commitHash: null,
              commitTimestampMs: null,
            })),
          },
        };
      }
    }
    return route.fulfill({ json: values[url.pathname] ?? {} });
  });
  await page.routeWebSocket("**/api/realtime", (ws) => {
    socket = ws;
    ws.onMessage((data) => {
      const call = JSON.parse(data);
      const reply = (message) => ws.send(JSON.stringify({ ...message, requestId: call.requestId }));
      switch (call.type) {
        case "auth.authenticate":
          return reply({ type: "ready" });
        case "thread.activate": {
          const selected = [parent, child, other].find((item) => item.id === call.threadId);
          const items =
            selected === parent
              ? threadItems
              : selected === other
                ? [userItem("other-prompt", "另一会话内容")]
                : [{ id: "child-answer", type: "agentMessage", text: "子智能体的原生结果" }];
          return reply({
            type: "thread.snapshot",
            thread: selected,
            history: {
              thread: { ...selected, turns: [{ id: turnId, status: "completed", items }] },
            },
            lastEventId: cursor,
            eventEpoch: "status-fixture",
          });
        }
        case "thread.goal.get":
          return reply({
            type: "thread.goal.snapshot",
            goal: call.threadId === threadId ? goal : null,
          });
        case "project.defaults.read":
          return reply({ defaults: { model: model.model } });
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
  await page
    .getByText(/请检查工作区状态/)
    .waitFor({ timeout: 25000 })
    .catch(async (error) => {
      throw new Error(
        `${error.message}\n${(await page.locator("body").innerText()).slice(0, 800)}\n${errors.join("\n")}`,
        { cause: error },
      );
    });
  return {
    emit(event) {
      if (event.type === "thread.goal.updated") goal = event.goal;
      socket.send(
        JSON.stringify({
          type: "thread.event",
          event: { id: ++cursor, hostId, threadId, event },
        }),
      );
    },
    verifyClean() {
      assert.deepEqual(errors, []);
    },
    gitReviewed: () => gitReviewed,
    branchListed: () => branchListed,
  };
}

async function verifySections(status) {
  await status.getByText("feature/status", { exact: true }).waitFor();
  await status.getByText("+7", { exact: true }).waitFor();
  await status.getByText("-2", { exact: true }).waitFor();
  await status.getByText(objective, { exact: true }).waitFor();
  await status.getByText("预算受限", { exact: true }).waitFor();
  assert.deepEqual(await status.locator("[data-plan-status]").allTextContents(), [
    "清点工作树",
    "核查原生事件",
    "完成发布验收",
  ]);
  await status.getByRole("button", { name: /项目审阅/ }).waitFor();
  await status.getByText("运行中", { exact: true }).waitFor();
  for (const [href, label] of [
    [typedLink, "用户链接"],
    [resultLink, "搜索结果"],
    [visitLink, "网页访问"],
  ]) {
    const link = status.locator(`a[href="${href}"]`);
    assert.equal(await link.count(), 1);
    await link.getByText(label, { exact: true }).waitFor();
  }
  await status.getByText("ChatGPT App Tools", { exact: true }).waitFor();
  await status.getByText("工具调用", { exact: true }).waitFor();
  for (const href of [assistantLink, queryLink, "javascript:alert(1)"])
    assert.equal(await status.locator(`a[href="${href}"]`).count(), 0);
}

async function verifyDesktop(page, origin, width, screenshots) {
  const fixture = await installFixture(page, origin);
  const status = panel(page);
  await verifySections(status);
  const sidebar = page.locator('[data-workspace-sidebar-panel="true"]');
  await sidebar.waitFor();
  assert(
    (await sidebar.boundingBox()).width > 160,
    "Keep the project sidebar in the reference layout",
  );
  const composer = page.locator("[data-v4-composer-dock-content]").first();
  const editorBox = await composer.boundingBox();
  const panelBox = await status.boundingBox();
  assert(
    editorBox.x + editorBox.width <= panelBox.x,
    "The panel must have its own right-side space",
  );
  if (screenshots)
    await page.screenshot({
      path: join(screenshots, `status-${width}.png`),
      animations: "disabled",
    });
  const collapse = status.getByRole("button", { name: "收起会话状态", exact: true });
  await collapse.focus();
  await collapse.press("Enter");
  await status.waitFor({ state: "hidden" });
  assert(await statusTrigger(page).evaluate((button) => button === document.activeElement));
  await statusTrigger(page).click();
  await status.waitFor();
  await status.getByRole("button", { name: "切换 Git 分支", exact: true }).click();
  await page.getByText("main", { exact: true }).waitFor();
  assert(fixture.branchListed(), "Git branch menu reads the real workspace branch service");
  await page.keyboard.press("Escape");

  await status.getByTestId("status-git-view-all").click();
  await page.getByTestId("git-pane").getByText("example.txt", { exact: true }).waitFor();
  assert(fixture.gitReviewed(), "Git review reads the real workspace datasets");
  await page.getByRole("button", { name: "收起侧边面板", exact: true }).click();
  await status.waitFor();

  await status.getByRole("button", { name: "查看完整计划", exact: true }).click();
  await page
    .locator('[data-plan-detail-tool-call-id="written-plan"]')
    .getByText("核对原生事件后验证发布。", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "收起侧边面板", exact: true }).click();
  await status.waitFor();

  if (width === 1236) {
    await page.setViewportSize({ width: 950, height: 820 });
    await status.waitFor({ state: "hidden" });
    await statusTrigger(page).click();
    await status.waitFor();
    await page.keyboard.press("Escape");
    await status.waitFor({ state: "hidden" });
    await page.setViewportSize({ width, height: 820 });
    await status.waitFor();
  }

  fixture.emit({
    type: "timeline.item.upsert",
    item: {
      ...collab,
      id: "paused",
      turnId,
      agentsStates: { [childId]: { status: "paused" } },
    },
  });
  await status.getByText("等待中", { exact: true }).waitFor();
  assert.equal(await status.getByText("已完成", { exact: true }).count(), 0);
  fixture.emit({
    type: "timeline.item.upsert",
    item: {
      ...activity,
      id: "ended",
      turnId,
      kind: "completed",
    },
  });
  await status.getByText("已完成", { exact: true }).waitFor();
  fixture.emit({ type: "thread.goal.updated", goal: { ...initialGoal, status: "complete" } });
  await status
    .locator('[data-status-section="goal"]')
    .getByText("已完成", { exact: true })
    .waitFor();
  fixture.emit({
    type: "turn.plan.updated",
    turnId,
    plan: [{ step: "实时计划已更新", status: "completed" }],
  });
  await status.locator('[data-plan-status="completed"]').getByText("实时计划已更新").waitFor();

  await status.getByRole("button", { name: "子智能体目录", exact: true }).click();
  const directory = page.getByRole("button", { name: /项目审阅/ }).last();
  await directory.waitFor();
  await directory.click();
  await page.getByText("子智能体的原生结果", { exact: true }).waitFor();
  const childPane = sessionPane(page, childId);
  await childPane.waitFor();
  assert.equal(await childPane.locator('[contenteditable="true"]').count(), 0);
  const otherTask = sidebar.getByText("第二个任务", { exact: true });
  await otherTask.click();
  await page.getByText("另一会话内容", { exact: true }).waitFor();
  assert.equal(await status.getByText(objective, { exact: true }).count(), 0);
  assert.equal(await status.locator(`a[href="${typedLink}"]`).count(), 0);
  const otherStatus = sessionPane(page, otherId).getByRole("complementary", { name: "会话状态" });
  await otherStatus.waitFor();
  assert.equal(await otherStatus.locator('[data-status-section="sources"]').count(), 0);
  fixture.verifyClean();
}

async function verifyMobile(page, origin, screenshots) {
  const fixture = await installFixture(page, origin);
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.waitFor();
  await panel(page).waitFor({ state: "hidden" });
  if (screenshots)
    await page.screenshot({
      path: join(screenshots, "status-390-closed.png"),
      animations: "disabled",
    });
  const editorBox = await editor.boundingBox();
  const triggerBox = await statusTrigger(page).boundingBox();
  assert(triggerBox.y + triggerBox.height < editorBox.y);
  await statusTrigger(page).click();
  const sheet = page.getByRole("dialog", { name: "会话状态", exact: true });
  await sheet.waitFor();
  await verifySections(sheet);
  if (screenshots)
    await page.screenshot({
      path: join(screenshots, "status-390-drawer.png"),
      animations: "disabled",
    });
  await sheet.getByRole("button", { name: "关闭会话状态", exact: true }).click();
  await sheet.waitFor({ state: "hidden" });
  await editor.click();
  await editor.pressSequentially("draft");
  assert((await editor.innerText()).includes("draft"));
  await statusTrigger(page).click();
  await sheet.getByRole("button", { name: /项目审阅/ }).click();
  await sheet.waitFor({ state: "hidden" });
  await page.getByText("子智能体的原生结果", { exact: true }).waitFor();
  fixture.verifyClean();
}

const target = process.env.SELFHOST_STATUS_TEST_URL;
const screenshots = process.env.SELFHOST_STATUS_SCREENSHOTS;
if (screenshots) await mkdir(screenshots, { recursive: true });
const outDir = target ? null : await mkdtemp(join(tmpdir(), "selfhost-status-panel-"));
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
    for (const width of [390, 1236, 1480]) {
      const page = await browser.newPage({
        viewport: { width, height: 820 },
        isMobile: width < 600,
        hasTouch: width < 600,
      });
      page.setDefaultTimeout(10000);
      try {
        if (width === 390) await verifyMobile(page, origin, screenshots);
        else await verifyDesktop(page, origin, width, screenshots);
        console.log(`PASS self-hosted session status (${width}px)`);
      } catch (error) {
        if (screenshots)
          await page.screenshot({
            path: join(screenshots, `status-${width}-failure.png`),
            animations: "disabled",
          });
        throw error;
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
