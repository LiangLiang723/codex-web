import {
  prepareStatusBrowserPage,
  verifyBotStatus,
  verifyBrowserStartup,
  verifyCompactPet,
  verifyReadOnlyPet,
} from "./fixtures/brand-status.mjs";
import {
  statusTrigger,
  verifyHeaderStatusTrigger,
  verifyTableInset,
} from "./fixtures/status-panel-layout.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { build, preview } from "vite";
import { repositorySummary } from "./fixtures/workspace-git.mjs";
import { verifyChildDetails, verifySubagentDirectory } from "./fixtures/subagent-details.mjs";

const web = resolve(import.meta.dirname, "../../packages/web");
const viewportHeight = 720;
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
const parent = makeThread(threadId, "/workspaces/project-alpha/documentation/release-planning/2026-11-26/session-title-responsive-ui-verification.md");
const other = makeThread(otherId, "第二个任务");
const child = {
  ...makeThread(childId, "子智能体详情"),
  parentThreadId: threadId,
  model: "fixture-child-model",
  reasoningEffort: "high",
};
const archivedChildren = Array.from({ length: 22 }, (_, index) => ({
  ...makeThread(`archived-child-${index + 1}`, `历史子智能体 ${index + 1}`),
  parentThreadId: threadId,
  model: null,
  reasoningEffort: null,
}));
const threads = [parent, other, child, ...archivedChildren];
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
  agentPath: "/root/parent_agent/项目审阅",
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
const planSteps = [
  { step: "清点工作树", status: "completed" },
  { step: "核查原生事件", status: "inProgress" },
  { step: "完成发布验收", status: "pending" },
  ...Array.from({ length: 12 }, (_, index) => ({
    step: `验收检查 ${index + 1}`,
    status: "pending",
  })),
];
const plan = {
  id: "plan",
  type: "turnPlan",
  plan: planSteps,
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
      ...Array.from({ length: 12 }, (_, index) => ({
        url: `https://docs.example.com/reference-${index + 1}`,
        title: `原生参考 ${index + 1}`,
      })),
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
const tableColumns = Array.from({ length: 10 }, (_, index) => `工作目录字段 ${index + 1}`);
const wideTable = [
  tableColumns,
  tableColumns.map(() => "---"),
  tableColumns.map((_, index) => `workspace/view-${index + 1}/component.tsx`),
]
  .map((cells) => `| ${cells.join(" | ")} |`)
  .join("\n");
const threadItems = [
  userItem("prompt", "请检查工作区状态。 " + typedLink + " " + typedLink),
  { id: "response", type: "agentMessage", text: "需要核查提交与计划。 " + assistantLink },
  { id: "written-plan", type: "plan", text: "# 工作区发布方案\n\n核对原生事件后验证发布。" },
  plan,
  activity,
  collab,
  ...sourceItems,
  { id: "table-response", type: "agentMessage", text: wideTable },
];
const git = repositorySummary(cwd, "feature/status", true);
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
const earlierTurns = Array.from({ length: 16 }, (_, index) => ({
  id: `historical-turn-${index + 1}`,
  status: "completed",
  items: [
    userItem(`historical-prompt-${index + 1}`, `请查看记录 ${index + 1}`),
    {
      id: `historical-reply-${index + 1}`,
      type: "agentMessage",
      text: "已读取工作记录。\n\n已核对历史内容。\n\n本轮检查完毕。",
    },
  ],
}));
const archiveTurnId = "archived-subagent-turn";
const archiveTurnText = "已读取更早的子智能体历史";
const archivedActivity = archivedChildren.map(({ id, name }, index) => ({
  type: "item",
  position: index + 1,
  turnId: archiveTurnId,
  item: {
    id: `archive-activity-${id}`,
    type: "subAgentActivity",
    kind: "completed",
    agentThreadId: id,
    agentNickname: name,
    completedAtMs: 10_000 + index,
  },
}));
const objective = "校验原生投影和右侧会话状态";
const initialGoal = { objective, status: "budgetLimited", createdAt: 10, timeUsedSeconds: 93 };
const panel = (page) => page.getByTestId("selfhost-status-panel");
const sessionPane = (page, id) =>
  page.locator(`[data-v4-conversation-drop-target][data-session-id="${id}"]`);
const timelineSelector = `[data-session-id="${threadId}"] [data-v4-timeline-scroll]`;
const desktopStatusScroller = '[data-testid="selfhost-status-panel"]';
const mobileStatusScroller =
  '[data-slot="bottom-sheet-content"] > div:has(> [data-status-section])';

async function installFixture(page, origin) {
  const browserState = await prepareStatusBrowserPage(page);
  let goal = initialGoal;
  let socket;
  let cursor = 0;
  let gitReviewed = false;
  let branchListed = false;
  const olderHistory = Promise.withResolvers();
  let archivePageDelivered = false;
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  page.on("console", (message) => {
    const text = message.text();
    if (text.includes("当前远程服务不支持 subagents.list") || text.includes("same key"))
      errors.push(text);
  });
  await page.route(new URL("/api/**", origin).href, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/selfhost/browser-state") return browserState(route);
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
        thread: threads.find((item) => item.id === url.searchParams.get("threadId")),
      },
      "/api/threads": {
        data: url.searchParams.get("archived") === "true" ? [] : [parent, other],
        nextCursor: null,
      },
      "/api/models": { data: [model], nextCursor: null },
      "/api/selfhost/settings": {
        locale: "zh-CN",
        theme: page.viewportSize().width === 1480 ? "light" : "dark",
      },
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
          const selected = threads.find((item) => item.id === call.threadId);
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
              thread: {
                ...selected,
                turns: [
                  ...(selected === parent ? earlierTurns : []),
                  { id: turnId, status: "completed", items },
                  ...(selected === child
                    ? [
                        {
                          id: "child-followup-turn",
                          status: "completed",
                          items: [
                            {
                              id: "child-followup",
                              type: "agentMessage",
                              text: "子智能体的后续结果",
                            },
                          ],
                        },
                      ]
                    : []),
                ],
              },
            },
            lastEventId: cursor,
            eventEpoch: "status-fixture",
            ...(selected === other ? { readOnly: true, readOnlyReason: "activeWriter" } : {}),
            ...(selected?.parentThreadId ? { readOnly: true, readOnlyReason: "subagent" } : {}),
            ...(selected === parent && page.viewportSize().width >= 768
              ? { oldestTimelineCursor: "archived-agent-history" }
              : {}),
          });
        }
        case "thread.timeline.load":
          assert.equal(call.cursor, "archived-agent-history");
          void olderHistory.promise.then(() => {
            archivePageDelivered = true;
            reply({
              type: "thread.timeline.page",
              data: [
                ...archivedActivity,
                {
                  type: "item",
                  position: 23,
                  turnId: archiveTurnId,
                  item: {
                    id: "archive-note",
                    type: "agentMessage",
                    text: archiveTurnText,
                  },
                },
                { type: "turnCompleted", position: 24, turnId: archiveTurnId, status: "completed" },
              ],
              nextCursor: null,
            });
          });
          return;
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
  await page.goto(url.href, { waitUntil: "commit" });
  await page
    .getByText(/请检查工作区状态/)
    .waitFor({ timeout: 45000 })
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
    releaseOlderHistory: olderHistory.resolve,
    archivePageDelivered: () => archivePageDelivered,
  };
}

async function verifySections(status) {
  await status.getByText("feature/status", { exact: true }).waitFor();
  await status.getByText("+7", { exact: true }).waitFor();
  await status.getByText("-2", { exact: true }).waitFor();
  await status.getByText(objective, { exact: true }).waitFor();
  await status.getByText("预算受限", { exact: true }).waitFor();
  assert.deepEqual(
    await status.locator("[data-plan-status]").allTextContents(),
    planSteps.map(({ step }) => step),
  );
  await status.getByRole("button", { name: /项目审阅/ }).waitFor();
  assert.equal(await status.getByText("/root/parent_agent/项目审阅", { exact: true }).count(), 0);
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

async function verifyMainTrack(page, { status, label } = {}) {
  const geometry = await page.locator(timelineSelector).evaluate((scroll) => {
    const pane = scroll.closest("[data-session-pane-root]");
    const bounds = scroll.getBoundingClientRect();
    const composer = scroll
      .querySelector("[data-v4-composer-dock-content]")
      .getBoundingClientRect();
    const messages = scroll
      .querySelector("[data-v4-timeline-virtual-history]")
      .getBoundingClientRect();
    return {
      paneRight: pane.getBoundingClientRect().right,
      trackRight: bounds.right,
      trackWidth: scroll.offsetWidth - scroll.clientWidth - scroll.clientLeft,
      top: bounds.top,
      height: bounds.height,
      overflow: scroll.scrollHeight - scroll.clientHeight,
      composerLeft: composer.left,
      composerRight: composer.right,
      messagesLeft: messages.left,
      messagesRight: messages.right,
    };
  });
  assert(
    Math.abs(geometry.trackRight - geometry.paneRight) <= 1,
    `The native timeline track must reach the pane edge: ${JSON.stringify(geometry)}`,
  );
  assert(geometry.overflow > geometry.height, "The fixture needs a long timeline");
  assert.equal(geometry.messagesLeft, geometry.composerLeft);
  assert.equal(geometry.messagesRight, geometry.composerRight);
  let statusRight;
  if (status) {
    const box = await status.boundingBox();
    statusRight = box.x + box.width;
    assert(
      statusRight < geometry.trackRight - geometry.trackWidth,
      `Status right ${statusRight} overlaps the main track at ${geometry.trackRight - geometry.trackWidth}`,
    );
  }
  if (label) {
    const trackLeft = geometry.trackRight - geometry.trackWidth;
    console.log(
      `${label}: timeline track ${trackLeft}–${geometry.trackRight}, conversation edge ${geometry.paneRight}` +
        (statusRight === undefined ? "" : `, status edge ${statusRight}`),
    );
  }
  return geometry;
}

async function timelineScrollTop(page) {
  return page.locator(timelineSelector).evaluate(async (element) => {
    // A native drag can mount virtual rows. Read after their measurements settle.
    let top = element.scrollTop;
    let height = element.scrollHeight;
    let stableFrames = 0;
    for (let frame = 0; frame < 20 && stableFrames < 4; frame += 1) {
      await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
      stableFrames =
        top === element.scrollTop && height === element.scrollHeight ? stableFrames + 1 : 0;
      top = element.scrollTop;
      height = element.scrollHeight;
    }
    return top;
  });
}

async function waitForTimelineBottom(page) {
  await page
    .waitForFunction((selector) => {
      const scroll = document.querySelector(selector);
      return (
        scroll?.dataset.following === "true" &&
        scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 2
      );
    }, timelineSelector)
    .catch(async (error) => {
      const state = await page.locator(timelineSelector).evaluate((scroll) => ({
        following: scroll.dataset.following,
        top: scroll.scrollTop,
        bottom: scroll.scrollHeight - scroll.clientHeight,
      }));
      throw new Error(`The timeline did not reach the bottom: ${JSON.stringify(state)}`, {
        cause: error,
      });
    });
}

async function verifyIndependentStatusScroll(page, selector) {
  const before = await timelineScrollTop(page);
  const scroller = page.locator(selector);
  const { x, y, range } = await scroller.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      x: bounds.left + 5,
      y: bounds.top + 60,
      range: element.scrollHeight - element.clientHeight,
    };
  });
  assert(range > 0, "The fixture needs a long status panel");
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, range + 120);
  await page.waitForFunction((area) => document.querySelector(area)?.scrollTop > 0, selector);
  assert.equal(await timelineScrollTop(page), before);
  await scroller.evaluate((element) => (element.scrollTop = 0));
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
  const geometry = await verifyMainTrack(page, { status, label: `${width}px inline` });
  const panelBox = await status.boundingBox();
  assert(geometry.composerRight <= panelBox.x, "The panel must have its own right-side space");
  const pet = page.locator('[data-codex-pet]');
  const railPet = pet.and(page.locator('[data-pet-placement="rail"]'));
  await railPet.waitFor();
  const petBox = await railPet.boundingBox();
  assert(Math.abs(petBox.x + petBox.width / 2 - (panelBox.x + panelBox.width / 2)) < 2);
  assert(petBox.y >= panelBox.y + panelBox.height);
  if (screenshots)
    await page.screenshot({
      path: join(screenshots, `status-${width}.png`),
      animations: "disabled",
    });
  await waitForTimelineBottom(page);
  assert(geometry.trackWidth > 0, "Desktop Chrome must expose a native scrollbar gutter");
  const previousBottom = await timelineScrollTop(page);
  const trackX = geometry.trackRight - geometry.trackWidth / 2;
  const thumbLength = Math.max(32, geometry.height ** 2 / (geometry.height + geometry.overflow));
  const thumbY = geometry.top + geometry.height - thumbLength / 2;
  await page.mouse.move(trackX, thumbY);
  await page.mouse.down();
  await page.mouse.move(trackX, thumbY - 65, { steps: 8 });
  await page.mouse.up();
  await page
    .waitForFunction(
      ({ selector, bottom }) => {
        const scroll = document.querySelector(selector);
        return scroll.scrollTop < bottom && scroll.dataset.following === "false";
      },
      { selector: timelineSelector, bottom: previousBottom },
    )
    .catch(async (error) => {
      const state = await page.locator(timelineSelector).evaluate(
        (scroll, point) => ({
          target: document.elementFromPoint(point.x, point.y)?.outerHTML.slice(0, 240),
          following: scroll.dataset.following,
          top: scroll.scrollTop,
          bottom: scroll.scrollHeight - scroll.clientHeight,
        }),
        { x: trackX, y: thumbY },
      );
      throw new Error(`The native scrollbar did not move: ${JSON.stringify(state)}`, {
        cause: error,
      });
    });
  await verifyIndependentStatusScroll(page, desktopStatusScroller);
  const reading = await timelineScrollTop(page);
  const collapse = status.getByRole("button", { name: "收起会话状态", exact: true });
  await collapse.focus();
  await collapse.press("Enter");
  await status.waitFor({ state: "hidden" });
  await verifyHeaderStatusTrigger(page, parent.name);
  await verifyCompactPet(sessionPane(page, threadId));
  await verifyMainTrack(page);
  assert.equal(await timelineScrollTop(page), reading);
  assert(await statusTrigger(page).evaluate((button) => button === document.activeElement));
  await statusTrigger(page).click();
  await status.waitFor();
  await verifyMainTrack(page, { status });
  assert.equal(await timelineScrollTop(page), reading);
  await page.getByRole("button", { name: "滚动到底部" }).click();
  await waitForTimelineBottom(page);
  await collapse.click();
  await waitForTimelineBottom(page);
  await statusTrigger(page).click();
  await waitForTimelineBottom(page);
  await verifyTableInset(page, panelBox.x);
  await status.getByRole("button", { name: "切换 Git 分支", exact: true }).click();
  await page.getByText("main", { exact: true }).waitFor();
  assert(fixture.branchListed(), "Git branch menu reads the real workspace branch service");
  await page.keyboard.press("Escape");

  await status.getByTestId("status-git-view-all").click();
  await page.getByTestId("git-pane").getByText("example.txt", { exact: true }).waitFor();
  assert(fixture.gitReviewed(), "Git review reads the real workspace datasets");
  await page.getByRole("button", { name: "收起侧边面板", exact: true }).click();
  await status.waitFor();

  await status.getByRole("button", { name: "工作区发布方案", exact: true }).click();
  await page
    .locator('[data-plan-detail-tool-call-id="written-plan"]')
    .getByText("核对原生事件后验证发布。", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "收起侧边面板", exact: true }).click();
  await status.waitFor();

  if (width === 1236) {
    await page.setViewportSize({ width: 950, height: viewportHeight });
    await status.waitFor({ state: "hidden" });
    await verifyHeaderStatusTrigger(page, parent.name);
    await verifyCompactPet(sessionPane(page, threadId));
    await verifyMainTrack(page);
    await statusTrigger(page).click();
    await status.waitFor();
    await verifyMainTrack(page, { status, label: "950px popover" });
    await verifyIndependentStatusScroll(page, desktopStatusScroller);
    const narrowReading = await timelineScrollTop(page);
    await page.keyboard.press("Escape");
    await status.waitFor({ state: "hidden" });
    assert.equal(await timelineScrollTop(page), narrowReading);
    await page.setViewportSize({ width, height: viewportHeight });
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
      completedAtMs: 30_000,
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

  await verifySubagentDirectory({
    page,
    status,
    timeline: page.locator(timelineSelector),
    child,
    archive: {
      children: archivedChildren,
      text: archiveTurnText,
      release: fixture.releaseOlderHistory,
      delivered: fixture.archivePageDelivered,
    },
    screenshotPath: screenshots ? join(screenshots, `subagent-${width}.png`) : undefined,
  });
  await verifyBotStatus(page, pet, fixture.emit);
  const otherTask = sidebar.getByText("第二个任务", { exact: true });
  await otherTask.click();
  const otherPane = sessionPane(page, otherId);
  await otherPane.getByTestId("v4-workspace-readonly-notice").waitFor();
  const closeSidePane = page.getByRole("button", { name: "收起侧边面板", exact: true });
  if (await closeSidePane.isVisible()) await closeSidePane.click();
  await verifyReadOnlyPet(otherPane, "rail");
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
  await verifyMainTrack(page, { label: "390px mobile" });
  await verifyHeaderStatusTrigger(page, parent.name);
  await verifyCompactPet(sessionPane(page, threadId));
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
  await sheet.getByRole("button", { name: "工作区发布方案", exact: true }).waitFor();
  await verifySections(sheet);
  await verifyMainTrack(page);
  await verifyIndependentStatusScroll(page, mobileStatusScroller);
  const reading = await timelineScrollTop(page);
  if (screenshots)
    await page.screenshot({
      path: join(screenshots, "status-390-drawer.png"),
      animations: "disabled",
    });
  await sheet.getByRole("button", { name: "关闭会话状态", exact: true }).click();
  await sheet.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.hasAttribute("data-session-status-toggle"));
  assert.equal(await timelineScrollTop(page), reading);
  await verifyBotStatus(page, sessionPane(page, threadId).locator("[data-codex-pet]"), fixture.emit);
  await editor.click();
  await editor.pressSequentially("draft");
  assert((await editor.innerText()).includes("draft"));
  await statusTrigger(page).click();
  await sheet.getByRole("button", { name: /项目审阅/ }).click();
  await sheet.waitFor({ state: "hidden" });
  await verifyChildDetails(page, child);
  assert.equal(await sessionPane(page, childId).locator("[data-codex-pet]").count(), 0);
  if (screenshots)
    await page.screenshot({ path: join(screenshots, "subagent-390.png"), animations: "disabled" });
  await page.getByRole("button", { name: "返回任务首页", exact: true }).click();
  await page.getByTestId(`task-item-${otherId}`).click();
  await verifyReadOnlyPet(sessionPane(page, otherId), "composer");
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
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    ignoreDefaultArgs: ["--hide-scrollbars"],
    args: process.env.SELFHOST_BOT_MATERIALS_TEST
      ? ["--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"]
      : [],
  });
  try {
    await verifyBrowserStartup(browser, origin);
    for (const width of [1236, 1480, 390]) {
      const page = await browser.newPage({
        viewport: { width, height: viewportHeight },
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
