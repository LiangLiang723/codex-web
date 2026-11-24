import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { posix } from "node:path";
import { chromium } from "playwright-core";

const base = new URL(process.env.SELFHOST_TEST_URL);
const username = process.env.SELFHOST_TEST_USER;
const hostId = Number(process.env.SELFHOST_TEST_HOST);
const cwd = process.env.SELFHOST_TEST_CWD;
const resultFile = process.env.SELFHOST_TEST_RESULT_FILE;
const threadFile = process.env.SELFHOST_TEST_THREAD_FILE;
const scenario = process.env.SELFHOST_TEST_SCENARIO ?? "latency";
const rewindPatch = process.env.SELFHOST_TEST_REWIND_PATCH === "1";
const timeout = 120_000;
const model = "gpt-6.2-sol";
const effort = "low";
const patchFile = `zcode-web-qa-${randomUUID()}.txt`;
const patchLine = "zcode SSH Web patch acceptance";
const expectedReply = scenario === "patch" ? "验收完成" : "你好";
const prompt =
  scenario === "patch"
    ? `在当前测试工作区根目录用 apply_patch 工具新建一个文件 ${patchFile}，只写一行 ${patchLine} 并以换行结尾。只使用 apply_patch，不要改动任何其他文件。成功后只回复：${expectedReply}`
    : "只回复：你好";
const sendSelector = 'button[aria-label="发送"]';
const replySelector = '[class~="group/assistant-row"] [data-conversation-selectable="true"]';

// The QA account and directory retain the synthetic Thread and any file created for this run.
assert(username, "Set SELFHOST_TEST_USER to the dedicated QA account");
assert(Number.isInteger(hostId) && hostId > 0, "Set SELFHOST_TEST_HOST to the QA host ID");
assert(cwd && posix.isAbsolute(cwd) && cwd !== "/", "Set SELFHOST_TEST_CWD to the QA directory");
assert(["latency", "patch"].includes(scenario), "Set SELFHOST_TEST_SCENARIO to latency or patch");
const qaPassword = (await readFile(process.env.SELFHOST_TEST_PASSWORD_FILE, "utf8")).trim();
const target = new URL("/", base);
target.search = new URLSearchParams({ host: String(hostId), cwd });

const now = () => performance.timeOrigin + performance.now();
const browser = await chromium.launch({
  channel: process.env.SELFHOST_TEST_BROWSER || "chrome",
  headless: true,
});
let page;
let phase = "launch";
const timing = {};
const frames = {};
let threadId;
let request;
let acceptedTurnId;
let completed;
let created;
const nativeErrors = { retrying: 0, final: 0, httpsFallback: 0 };
let nativePatch = false;
let nativeDiff = false;
let rewindAttempt;

const button = (surface, name) => surface.getByRole("button", { name, exact: true });
const countFrame = (type, state) => {
  const key = state ? `${type}.${state}` : type;
  frames[key] = (frames[key] ?? 0) + 1;
};
const elapsed = (start) =>
  Object.fromEntries(
    Object.entries(timing)
      .filter(([, at]) => at >= start)
      .map(([event, at]) => [event, Math.round(at - start)]),
  );

async function waitForNative(promise, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(message)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function observePage() {
  return page?.evaluate(
    ({ thread, prompt, reply }) => {
      const pane = document.querySelector("[data-v4-conversation-drop-target]");
      const viewport = { width: innerWidth, height: innerHeight };
      const routeMatchesThread = Boolean(
        thread && new URL(location.href).searchParams.get("thread") === thread,
      );
      const paneMatchesThread = Boolean(thread && pane?.dataset.sessionId === thread);
      const showsInput = Boolean(pane?.textContent.includes(prompt));
      const showsReply = [...document.querySelectorAll(reply)].some((node) =>
        node.textContent.trim(),
      );
      const rewindButton = pane?.querySelector('button[title="撤销"]');
      const deliveryPending = [...document.querySelectorAll('[role="status"]')].some((node) =>
        node.textContent.includes("Codex 尚未确认这条输入"),
      );
      return {
        viewport,
        routeMatchesThread,
        paneMatchesThread,
        showsInput,
        showsReply,
        rewindDisabled: rewindButton?.disabled ?? null,
        deliveryPending,
      };
    },
    { thread: threadId, prompt, reply: replySelector },
  );
}

async function approveFixtureIfRequested(page, completion) {
  const pane = page.locator("[data-v4-conversation-drop-target]");
  const option = pane.getByRole("option", { name: "允许本轮", exact: true });
  const approvalNeeded = await Promise.race([
    completion.then(() => false),
    option.waitFor({ timeout }).then(() => true),
  ]);
  if (!approvalNeeded) return false;

  const details = pane.locator("dl").filter({ hasText: "拟修改的文件" });
  await details.waitFor();
  const approvedPath = posix.join(cwd, patchFile);
  const paths = await details.locator("dd").allTextContents();
  assert(paths.length === 1 && paths[0] === approvedPath, "Unexpected path in QA file approval");
  assert.equal(await pane.getAttribute("data-session-id"), threadId);
  await option.focus();
  assert.equal(await option.getAttribute("aria-selected"), "true");
  await button(pane, "确认").click();
  return true;
}

async function readWorkspace(page, channel, method, args) {
  return page.evaluate(
    async (body) => {
      const response = await fetch("/api/selfhost/workspace", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${localStorage.getItem("selfhost.auth")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw Error(`QA workspace verification failed (${response.status})`);
      return (await response.json()).value;
    },
    { hostId, channel, method, args },
  );
}

async function verifyRewind(page, allowApply) {
  const fixture = posix.join(cwd, patchFile);
  const fixtureExists = async () => {
    const [item] = await readWorkspace(page, "file", "checkFilesExist", [{ paths: [fixture] }]);
    assert.equal(item.path, fixture);
    return item.exists;
  };
  const responseFor = (operation) =>
    page.waitForResponse((response) => {
      const request = response.request();
      if (
        new URL(request.url()).pathname !== "/api/selfhost/turn-files" ||
        request.method() !== "POST"
      )
        return false;
      const body = request.postDataJSON();
      return (
        body.operation === operation &&
        body.hostId === hostId &&
        body.threadId === threadId &&
        body.turnId === completed.id
      );
    });

  assert(await fixtureExists(), "The fixture should exist before rewind preview");
  const [previewResponse] = await Promise.all([
    responseFor("preview"),
    button(page, "撤销").click(),
  ]);
  assert(previewResponse.ok(), `Rewind preview failed (${previewResponse.status()})`);
  const { preview } = await previewResponse.json();
  const dialog = page.getByRole("dialog", { name: "撤销文件改动" });
  const confirm = button(dialog, "撤销文件");
  assert(await fixtureExists(), "The preview changed the fixture");
  if (!preview.canApply) {
    await dialog.getByText("存在不能安全撤销的文件，未写入任何文件。", { exact: true }).waitFor();
    assert(await confirm.isDisabled());
    const reasons = preview.unsafeFiles.map(({ reason }) => reason);
    await page.keyboard.press("Escape");
    return { applied: false, reasons };
  }

  const canonical = await readWorkspace(page, "system", "resolveDirectory", [{ path: cwd }]);
  assert.equal(preview.unsafeFiles.length + preview.ignoredFiles.length, 0);
  assert.equal(preview.safeFiles.length, 1);
  const [safe] = preview.safeFiles;
  assert.equal(
    safe.path,
    posix.join(canonical, patchFile),
    "Only the synthetic fixture may be reverted",
  );
  assert.equal(safe.action, "delete");
  await dialog.getByText(safe.path, { exact: true }).waitFor();
  if (!allowApply) {
    await page.keyboard.press("Escape");
    return { applied: false, safe: true };
  }

  const [applyResponse] = await Promise.all([responseFor("apply"), confirm.click()]);
  assert(applyResponse.ok(), `Rewind apply failed (${applyResponse.status()})`);
  const outcome = await applyResponse.json();
  rewindAttempt = {
    applied: outcome.applied,
    canApply: outcome.preview?.canApply,
    reasonCodes: outcome.preview?.unsafeFiles.map(({ reason }) => reason),
    response: outcome.response
      ?.replaceAll(patchFile, "[fixture]")
      .replaceAll(cwd, "[QA directory]"),
  };
  assert.equal(outcome.applied, true, "The SSH worktree rejected the rewind after preview");
  await dialog.waitFor({ state: "hidden" });
  await page.getByText("已撤销", { exact: true }).waitFor();
  assert.equal(await fixtureExists(), false, "The synthetic file should be absent after rewind");
  return { applied: true, safe: true, removedFixture: true };
}

async function verifyPatch(page) {
  const status = page.getByRole("complementary", { name: "会话状态", exact: true });
  const panel = page.getByTestId("selfhost-status-panel");
  const git = page.getByTestId("status-git-view-all");
  await page.setViewportSize({ width: 1236, height: 900 });
  await panel.waitFor();
  assert.equal(await status.getAttribute("data-status-placement"), "inline");
  await git.waitFor();
  await button(panel, "收起会话状态").click();
  await panel.waitFor({ state: "hidden" });
  await button(status, "打开会话状态").click();
  await git.waitFor();

  const expand = button(page, "展开已更改文件");
  await expand.waitFor();
  assert.match(await expand.innerText(), /1 个文件已更改\s*\+1\s*-0/u);
  await expand.click();
  const fileRow = page.locator(`[title$="/${patchFile}"]`).filter({ has: button(page, "审查") });
  await fileRow.waitFor();
  const review = button(fileRow, "审查");
  const reviewRendered = await review.isEnabled();
  if (reviewRendered) {
    await review.click();
    await page.getByText(patchLine, { exact: true }).waitFor();
  }
  const rewind = rewindPatch || !reviewRendered ? await verifyRewind(page, rewindPatch) : null;
  assert(
    reviewRendered || rewind?.reasons?.length,
    "Missing both the diff and an explicit rewind restriction",
  );

  await page.setViewportSize({ width: 390, height: 850 });
  await page.reload();
  await page.locator(replySelector).getByText(expectedReply, { exact: true }).waitFor();
  await button(page, "展开已更改文件").waitFor();
  if (rewind?.applied) await page.getByText("已撤销", { exact: true }).waitFor();
  await button(status, "打开会话状态").click();
  await page
    .getByRole("dialog", { name: "会话状态", exact: true })
    .getByTestId("status-git-view-all")
    .waitFor();
  return { nativePatch, nativeDiff, reviewRendered, rewind, widePanel: true, mobileSheet: true };
}

try {
  page = await browser.newPage({ viewport: { width: 1480, height: 900 }, locale: "zh-CN" });
  page.setDefaultTimeout(30_000);
  let resolveCreated;
  const waitForCreated = new Promise((resolve) => {
    resolveCreated = resolve;
  });
  let resolveCompleted;
  const waitForCompleted = new Promise((resolve) => {
    resolveCompleted = resolve;
  });
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname !== "/api/realtime") return;
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      const message = JSON.parse(payload);
      if (message.type === "thread.start" && message.hostId === hostId && message.cwd === cwd) {
        created = message;
        timing.threadSent = now();
        countFrame("send.thread.start");
      }
      if (
        message.type === "turn.start" &&
        message.hostId === hostId &&
        message.threadId === threadId
      ) {
        request = message;
        timing.turnSent = now();
        countFrame("send.turn.start");
      }
      if (threadId && message.threadId === threadId && message.type === "thread.activate")
        countFrame("send.thread.activate");
    });
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      const message = JSON.parse(payload);
      const received = now();
      const deliveryState = message.type === "thread.delivery.state" && message.state;
      if (
        message.requestId &&
        (message.requestId === created?.requestId || message.requestId === request?.requestId)
      )
        countFrame(`receive.${message.type}`, deliveryState);
      if (
        (message.type === "thread.started" || deliveryState === "created") &&
        created &&
        message.requestId === created.requestId
      ) {
        threadId = message.threadId ?? message.thread?.id;
        timing.threadAccepted = received;
        if (threadId) resolveCreated();
      }
      if (
        (message.type === "turn.start.accepted" || deliveryState === "accepted") &&
        request &&
        message.requestId === request.requestId
      ) {
        acceptedTurnId = message.turn?.id ?? message.turnId;
        timing.accepted = received;
      }
      if (
        !threadId ||
        message.type !== "thread.event" ||
        message.event.threadId !== threadId ||
        message.event.hostId !== hostId
      )
        return;
      const event = message.event.event;
      countFrame(`event.${event.type}`);
      if (event.type === "turn.started") timing.turnStarted ??= received;
      if (
        event.type === "timeline.item.delta" &&
        event.channel === "agentMessage" &&
        event.delta.trim()
      ) {
        timing.firstDelta ??= received;
      }
      if (
        event.type === "timeline.item.upsert" &&
        event.item.type === "agentMessage" &&
        event.item.status === "completed" &&
        event.item.text?.trim()
      ) {
        timing.firstCompleteItem ??= received;
      }
      if (
        event.type === "timeline.item.upsert" &&
        event.item.type === "fileChange" &&
        event.item.status === "completed"
      ) {
        nativePatch ||= Boolean(
          event.item.changes?.some(
            (change) =>
              typeof change.path === "string" &&
              posix.basename(change.path) === patchFile &&
              change.diff?.includes(patchLine),
          ),
        );
      }
      if (
        event.type === "turn.diff.updated" &&
        event.diff.includes(patchFile) &&
        event.diff.includes(patchLine)
      )
        nativeDiff = true;
      if (event.type === "error.reported")
        nativeErrors[event.params.willRetry === true ? "retrying" : "final"]++;
      if (
        event.type === "notice" &&
        event.source === "warning" &&
        event.params.message?.startsWith("Falling back from WebSockets to HTTPS transport")
      )
        nativeErrors.httpsFallback++;
      if (event.type === "turn.completed") {
        timing.completed ??= received;
        completed = event.turn;
        resolveCompleted();
      }
    });
  });
  await page.addInitScript(
    ({ button, reply }) => {
      const trace = (window.__sshWebAcceptance = {});
      const now = () => performance.timeOrigin + performance.now();
      document.addEventListener("click", (event) => {
        if (!event.target.closest(button)) return;
        trace.click = now();
        const observe = () => {
          const visible = Array.from(document.querySelectorAll(reply)).some((element) => {
            if (
              !element.textContent.trim() ||
              document.visibilityState !== "visible" ||
              !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
            )
              return false;
            const rect = element.getBoundingClientRect();
            return (
              rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight && rect.right > 0
            );
          });
          if (visible) trace.firstVisible = now();
          else requestAnimationFrame(observe);
        };
        requestAnimationFrame(observe);
      });
    },
    { button: sendSelector, reply: replySelector },
  );

  phase = "login";
  try {
    await page.goto(target.href);
    await page.locator('input[name="username"]').fill(username);
    await page.locator('input[name="password"]').fill(qaPassword);
    await button(page, "登录").click();
  } catch {
    throw Error("Could not submit the QA account login form");
  }

  phase = "select model and effort";
  const modelButton = page.locator('button[aria-label^="OpenAI Codex/"]');
  await modelButton.click({ timeout: timeout });
  const picker = page.getByRole("dialog", { name: "选择模型" });
  await picker
    .getByRole("option", { name: new RegExp(`^${model.replaceAll(".", "\\.")}\\b`) })
    .click();
  const effortSlider = picker.getByTestId("composer-thought-slider");
  await effortSlider.press("Home");
  assert.equal(JSON.parse(await effortSlider.getAttribute("data-levels"))[0], effort);
  assert.equal(await effortSlider.inputValue(), "0");
  await page.keyboard.press("Escape");
  assert.match(await modelButton.getAttribute("aria-label"), /gpt-6\.2-sol 低/u);
  const route = new URL(page.url());
  assert.equal(route.searchParams.get("host"), String(hostId));
  assert.equal(route.searchParams.get("cwd"), cwd);
  assert.equal(route.searchParams.get("thread"), null);

  phase = "send first turn";
  await page.locator('[contenteditable="true"]').first().fill(prompt);
  await page.locator(sendSelector).click();
  await waitForNative(waitForCreated, "Missing native thread creation result");
  assert(threadId, "Missing native thread creation result");
  if (threadFile) await writeFile(threadFile, `${threadId}\n`, { mode: 0o600 });
  phase = "open accepted thread";
  await page.waitForFunction(
    (id) => new URL(location.href).searchParams.get("thread") === id,
    threadId,
  );
  console.log("PASS new native Thread opened in the designated QA directory");

  phase = "check optional QA file approval";
  const approvedPatch =
    scenario === "patch" && (await approveFixtureIfRequested(page, waitForCompleted));
  phase = "wait for native completion";
  await waitForNative(waitForCompleted, "Missing native turn/completed");
  assert.equal(created?.model, model);
  assert.equal(created?.effort, effort);
  assert.equal(request?.model, model);
  assert.equal(request?.effort, effort);
  assert.equal(completed.status, "completed");
  assert.equal(acceptedTurnId, completed.id);
  assert(timing.firstDelta || timing.firstCompleteItem, "No native assistant content received");
  await page.locator(replySelector).getByText(expectedReply, { exact: true }).waitFor();
  await page.waitForFunction(() => Boolean(window.__sshWebAcceptance.firstVisible));
  Object.assign(timing, await page.evaluate(() => window.__sshWebAcceptance));
  assert(timing.click && timing.firstVisible, "No visible assistant text was observed");

  const result = {
    scenario,
    model,
    effort,
    frames: { ...frames },
    nativeErrors: { ...nativeErrors },
    millisecondsFromClick: elapsed(timing.click),
    millisecondsFromTurnStart: elapsed(timing.turnSent),
  };
  if (scenario === "patch") {
    phase = "verify native apply_patch, diff and status panel";
    assert(nativePatch, "No completed native fileChange matched the QA apply_patch fixture");
    result.patch = { approvedPatch, ...(await verifyPatch(page)) };
  }
  if (resultFile)
    await writeFile(resultFile, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const observation = await observePage().catch(() => null);
  if (page)
    Object.assign(timing, await page.evaluate(() => window.__sshWebAcceptance).catch(() => null));
  const partial = {
    scenario,
    phase,
    frames,
    nativeErrors,
    observation,
    rewindAttempt,
    millisecondsFromClick: elapsed(timing.click),
    millisecondsFromTurnStart: elapsed(timing.turnSent),
  };
  if (resultFile)
    await writeFile(resultFile, JSON.stringify(partial, null, 2) + "\n", { mode: 0o600 });
  console.error(JSON.stringify(partial, null, 2));
  throw Error(`SSH Web acceptance failed during ${phase}. ${error.message}`);
} finally {
  await browser.close();
}
