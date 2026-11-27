import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { build, preview } from "vite";
import { browserStateFixture } from "./fixtures/browser-state.mjs";

const web = resolve(import.meta.dirname, "../../packages/web");
const cwd = "/work-history-fixture";
const hostId = 1;
const eventEpoch = "work-history-fixture";
const thread = { id: "work-history", cwd, name: "回合工作过程", status: { type: "idle" } };
const host = {
  id: hostId,
  name: "Fixture",
  sshHost: "fixture",
  username: null,
  port: null,
  authMode: "agent",
};
const project = { hostId, remotePath: cwd, name: "Fixture" };
const model = { id: "fixture", model: "fixture", displayName: "Fixture", isDefault: true };
const startedAt = 1780000000;
const user = (id, text) => ({ id, type: "userMessage", content: [{ type: "text", text }] });
const message = (id, text, phase = null) => ({ id, type: "agentMessage", text, phase });
const legacy = {
  id: "legacy-turn",
  status: "completed",
  startedAt: startedAt - 60,
  completedAt: startedAt - 40,
  items: [
    user("legacy-user", "查看旧回合"),
    message("legacy-progress", "旧回合的进度"),
    message("legacy-answer", "旧回合的最终答复"),
  ],
};
const replyOnly = {
  id: "reply-only-turn",
  status: "completed",
  startedAt: startedAt - 10,
  completedAt: startedAt - 7,
  items: [
    user("answer-only-user", "简单回答"),
    message("only-answer", "这一轮只有答复", "final_answer"),
  ],
};
const current = {
  id: "phased-turn",
  status: "inProgress",
  startedAt,
  items: [
    user("phased-user", "查看工作过程"),
    message("progress", "我会先检查当前设置", "commentary"),
    {
      id: "check-settings",
      type: "commandExecution",
      command: "printf fixture",
      status: "completed",
      exitCode: 0,
    },
    message("partial", "已核实设置的读取路径", "partial_answer"),
  ],
};
const answer = message("answer", "设置保存在浏览器和网关", "final_answer");
const lateProgress = message("late-progress", "已完成剩余检查", "commentary");
const completed = {
  ...current,
  status: "completed",
  completedAt: startedAt + 1066,
  items: [...current.items, answer, lateProgress],
};
const initialInput = { ...current.items[0], startsTurn: true, clientId: "phased-submit" };
const completedWithInput = { ...completed, items: [initialInput, ...completed.items.slice(1)] };
const historyTrigger = (page, turn) =>
  page.getByTestId(`chat-assistant-history-trigger-${turn.id}`);
const workLocators = (page, turn) => ({
  history: page.getByTestId(`chat-assistant-history-content-${turn.id}`),
  group: page.locator(`section[data-turn-id="${turn.id}"]`),
  trigger: historyTrigger(page, turn),
});

async function verifyFold(page, turn, finalText, progressTexts, timeLabel, touch) {
  const { history, group, trigger } = workLocators(page, turn);
  const final = group.getByText(finalText, { exact: true });
  await final.waitFor();
  await trigger.and(page.locator('[aria-expanded="false"]')).waitFor();
  assert.equal(await trigger.innerText(), timeLabel);
  await history.waitFor({ state: "hidden" });
  for (const text of progressTexts) {
    assert.equal(await group.getByText(text, { exact: true }).isVisible(), false, text);
  }

  if (touch) await trigger.tap();
  else await trigger.click();
  await history.waitFor();
  assert.equal(await trigger.getAttribute("aria-expanded"), "true");
  for (const text of progressTexts) await history.getByText(text, { exact: true }).waitFor();
  assert(await final.isVisible());
  assert(
    await final.evaluate((node) => {
      const history = node
        .closest("section[data-turn-id]")
        .querySelector('[data-testid^="chat-assistant-history-content-"]');
      return Boolean(history.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
    }),
  );
  if (turn.id === current.id) {
    await history.locator('[data-tool-call-id="check-settings"]').waitFor();
    const text = await history.innerText();
    assert(text.indexOf(progressTexts[0]) < text.indexOf(progressTexts[1]));
    assert(text.indexOf(progressTexts[1]) < text.indexOf(progressTexts[2]));
  }

  if (touch) await trigger.tap();
  else await trigger.press("Enter");
  await history.waitFor({ state: "hidden" });
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  assert(await final.isVisible());
}

async function verifyInputBeforeAnswer(page) {
  const turn = workLocators(page, current).group;
  const input = turn.getByText("查看工作过程", { exact: true });
  await input.waitFor();
  assert.equal(await input.count(), 1);
  assert(
    await input.evaluate((node, finalText) => {
      const turn = node.closest("section[data-turn-id]");
      const final = [...turn.querySelectorAll("[data-row-id]")].find(
        (row) => row.textContent.trim() === finalText,
      );
      return final !== undefined &&
        Boolean(node.compareDocumentPosition(final) & Node.DOCUMENT_POSITION_FOLLOWING);
    }, answer.text),
    "the late initial question must precede its final answer",
  );
}

async function verify(page, origin, touch) {
  let finished = false;
  let eventId = 0;
  let publish;
  const nativeControls = { queue: false, compact: false, fork: true, queued: [] };
  await page.addInitScript(
    (theme) => {
      localStorage.setItem("selfhost.auth", "work-history-fixture");
      localStorage.setItem("zcode-locale-preference", "zh-CN");
      localStorage.setItem("zcode-theme", theme);
    },
    touch ? "zai-light" : "zai-dark",
  );
  const browserState = browserStateFixture();
  await page.route(new URL("/api/**", origin).href, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/selfhost/browser-state") return browserState(route);
    const channel = route.request().postDataJSON()?.channel;
    const responses = {
      "/api/auth/me": { user: { username: "fixture", avatar: null } },
      "/api/hosts": [host],
      "/api/selfhost/projects": url.searchParams.has("organization")
        ? { items: [project], memberships: { [thread.id]: cwd } }
        : [project],
      "/api/threads": { data: [thread], nextCursor: null },
      "/api/models": { data: [model], nextCursor: null },
      "/api/selfhost/settings": { locale: "zh-CN" },
      "/api/selfhost/turn-files": { summaries: {} },
      "/api/selfhost/organization": {
        value: channel === "task-groups" ? { revision: 0, members: [], groups: [], order: [] } : [],
      },
      "/api/selfhost/workspace": {
        value: channel === "system" ? { homedir: cwd, platform: "linux" } : [],
      },
    };
    return route.fulfill({ json: responses[url.pathname] ?? { value: [] } });
  });
  await page.routeWebSocket("**/api/realtime", (socket) => {
    publish = (event) =>
      socket.send(
        JSON.stringify({
          type: "thread.event",
          eventEpoch,
          event: { id: ++eventId, threadId: thread.id, hostId, event },
        }),
      );
    socket.onMessage((data) => {
      const request = JSON.parse(data);
      const reply = (value) =>
        socket.send(JSON.stringify({ ...value, requestId: request.requestId }));
      switch (request.type) {
        case "auth.authenticate":
          return reply({ type: "ready" });
        case "thread.activate":
          return reply({
            type: "thread.snapshot",
            thread,
            eventEpoch,
            lastEventId: eventId,
            ...(finished ? { readOnly: true, readOnlyReason: "activeWriter" } : { nativeControls }),
            history: {
              thread: {
                ...thread,
                turns: [
                  legacy,
                  replyOnly,
                  finished ? completedWithInput : { ...current, items: current.items.slice(1) },
                ],
              },
            },
          });
        case "thread.native.controls":
          return reply({ type: "thread.native.controls.result", ...nativeControls });
        case "project.defaults.read":
          return reply({ defaults: { model: model.model } });
        case "ping":
          return reply({ type: "pong", nonce: request.nonce });
        default:
          if (request.requestId) reply({ type: "fixture.result" });
      }
    });
  });

  const query = new URLSearchParams({ host: String(hostId), cwd, thread: thread.id });
  await page.goto(new URL(`/?${query}`, origin).href);
  const active = workLocators(page, current).group;
  await active.getByText("我会先检查当前设置", { exact: true }).waitFor();
  assert.equal(await historyTrigger(page, current).count(), 0);
  await verifyFold(page, legacy, "旧回合的最终答复", ["旧回合的进度"], "已工作 20 秒", touch);

  publish({ type: "timeline.item.upsert", item: { ...answer, turnId: current.id } });
  publish({ type: "timeline.item.upsert", item: { ...lateProgress, turnId: current.id } });
  await active.getByText(answer.text, { exact: true }).waitFor();
  await active.getByText(lateProgress.text, { exact: true }).waitFor();
  finished = true;
  publish({ type: "timeline.item.upsert", item: { ...initialInput, turnId: current.id } });
  publish({ type: "turn.completed", turn: { ...completed, items: [] } });
  const progress = ["我会先检查当前设置", "已核实设置的读取路径", lateProgress.text];
  await verifyFold(page, completed, answer.text, progress, "已工作 17 分 46 秒", touch);
  await verifyInputBeforeAnswer(page);
  const only = workLocators(page, replyOnly).group;
  await only.getByText("已工作 3 秒", { exact: true }).waitFor();
  assert.equal(await only.getByRole("button", { name: "已工作 3 秒" }).count(), 0);

  await page.reload();
  await verifyFold(page, completed, answer.text, progress, "已工作 17 分 46 秒", touch);
  await verifyInputBeforeAnswer(page);
  assert.equal(await page.locator("html.theme-" + (touch ? "zai-light" : "zai-dark")).count(), 1);
}

const target = process.env.SELFHOST_TURN_WORK_TEST_URL;
const outDir = target ? null : await mkdtemp(join(tmpdir(), "selfhost-turn-work-"));
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
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    for (const width of [1480, 390]) {
      const touch = width < 600;
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        isMobile: touch,
        hasTouch: touch,
      });
      page.setDefaultTimeout(15000);
      try {
        await verify(page, target ?? server.resolvedUrls.local[0], touch);
      } catch (cause) {
        const sections = await page.locator("section[data-turn-id]").evaluateAll((turns) =>
          turns.map((turn) => [turn.getAttribute("data-turn-id"), turn.textContent]),
        );
        const body = await page.locator("body").innerText();
        throw new Error(`Turn fixture (${width}px) at ${page.url()}\n${JSON.stringify(sections)}\n${body}`, { cause });
      } finally {
        await page.close();
      }
      console.log(`PASS native turn work history and final answer (${width}px)`);
    }
  } finally {
    await browser.close();
  }
} finally {
  await server?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
}
