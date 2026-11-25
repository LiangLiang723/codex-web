import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { build, preview } from "vite";

const web = resolve(import.meta.dirname, "../../packages/web");
const hostId = 1;
const cwd = "/clipboard-fixture";
const thread = {
  id: "clipboard-thread",
  name: "剪贴板验收",
  cwd,
  status: { type: "idle" },
  createdAt: 1,
  updatedAt: 2,
};
const tableText = ["| 名称 | 值 |", "| --- | --- |", "| 茶🍵 | A\\|B |", "| 水 | 第二行 |"].join(
  "\n",
);
const codeText = ["第一行 🌿", "  第二行"].join("\n");
const markdownUrl = "https://example.com/clipboard-fixture?part=one#copy";
const messageText = [
  "剪贴板验收",
  "",
  tableText,
  "",
  "```text",
  codeText,
  "```",
  "",
  `[验收链接](${markdownUrl})`,
].join("\n");
const history = {
  thread: {
    ...thread,
    turns: [
      {
        id: "clipboard-turn",
        status: "completed",
        items: [
          {
            id: "user",
            type: "userMessage",
            content: [{ type: "text", text: "返回表格和代码" }],
          },
          { id: "assistant", type: "agentMessage", text: messageText },
        ],
      },
    ],
  },
};
const project = { hostId, remotePath: cwd, name: "Clipboard" };
const model = {
  id: "fixture",
  model: "fixture",
  displayName: "Fixture",
  isDefault: true,
  defaultReasoningEffort: "low",
  supportedReasoningEfforts: [{ reasoningEffort: "low" }],
};
const beforeCopy = "先前的剪贴板内容";
const genericFailure = "复制失败，请检查剪贴板权限后重试。";
const tableFailure = "复制表格失败，请检查剪贴板权限后重试。";

async function fixture(page, base, mode) {
  const address = new URL(base);
  if (mode === "lan-http") address.hostname = "clipboard-fixture.test";
  const origin = address.origin;
  await page.route(`${base}clipboard-test-seed`, (route) =>
    route.fulfill({ contentType: "text/html", body: "Clipboard test setup" }),
  );
  await page.goto(`${base}clipboard-test-seed`);
  await page.evaluate((text) => navigator.clipboard.writeText(text), beforeCopy);
  // 代理每个静态模块时，关闭上一场景会中断迟到的请求。只为受限页面的文档设置权限头。
  if (mode === "denied") {
    await page.route(
      (url) => url.origin === origin && url.pathname === "/",
      async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          response,
          headers: { ...response.headers(), "permissions-policy": "clipboard-write=()" },
        });
      },
    );
  }
  await page.route(`${origin}/api/**`, (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postDataJSON();
    const responses = {
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
      "/api/selfhost/projects": url.searchParams.has("organization")
        ? { items: [project], memberships: { [thread.id]: cwd } }
        : [project],
      "/api/threads": { data: [thread], nextCursor: null },
      "/api/models": { data: [model], nextCursor: null },
      "/api/selfhost/settings": { locale: "zh-CN" },
      "/api/selfhost/capability": { value: [] },
      "/api/selfhost/organization": {
        value:
          body?.channel === "task-groups"
            ? { revision: 0, members: [], groups: [], order: [] }
            : [],
      },
      "/api/selfhost/workspace": {
        value: body?.channel === "system" ? { homedir: cwd, platform: "linux" } : [],
      },
      "/api/selfhost/shares": { title: thread.name, sessionId: thread.id, history },
    };
    return route.fulfill({ json: responses[url.pathname] ?? {} });
  });
  await page.routeWebSocket("**/api/realtime", (socket) => {
    socket.onMessage((data) => {
      const call = JSON.parse(data);
      const reply = (message) =>
        socket.send(JSON.stringify({ ...message, requestId: call.requestId }));
      if (call.type === "auth.authenticate") reply({ type: "ready" });
      else if (call.type === "thread.activate")
        reply({
          type: "thread.snapshot",
          thread,
          lastEventId: 0,
          eventEpoch: "clipboard-fixture",
          history,
        });
      else if (call.type === "thread.native.controls")
        reply({
          type: "thread.native.controls.result",
          queue: false,
          fork: false,
          compact: false,
          queued: [],
        });
      else if (call.type === "project.defaults.read") reply({ defaults: { model: model.model } });
      else if (call.type === "ping") reply({ type: "pong", nonce: call.nonce });
      else if (call.requestId) reply({ type: "fixture.result" });
    });
  });
  await page.addInitScript(() => {
    localStorage.setItem("selfhost.auth", "clipboard-fixture");
    localStorage.setItem("zcode-locale-preference", "zh-CN");
    window.clipboardActivation = undefined;
    document.addEventListener(
      "click",
      (event) => {
        if (!(event.target instanceof Element) || !event.target.closest("button, [role=menuitem]"))
          return;
        window.clipboardActivation = {
          focused: document.hasFocus(),
          trusted: event.isTrusted,
          active: navigator.userActivation.isActive,
        };
      },
      true,
    );
  });
  return origin;
}

async function paste(page) {
  const target = page.getByTestId("clipboard-paste-target");
  if (!(await target.count())) {
    await page.evaluate(() => {
      const textarea = document.createElement("textarea");
      textarea.dataset.testid = "clipboard-paste-target";
      textarea.style.cssText = "position:fixed;opacity:0;width:1px;height:1px";
      document.body.append(textarea);
    });
  }
  await target.fill("");
  await target.press("ControlOrMeta+V");
  return target.inputValue();
}

async function verifyCopy(
  page,
  { button, success, failure = genericFailure, value, activate },
  mode,
) {
  const failureMessage = page.getByText(failure, { exact: true }).last();
  if (mode === "denied") await failureMessage.waitFor({ state: "hidden" });
  await (activate ? activate(button) : button.click());
  assert.deepEqual(await page.evaluate(() => window.clipboardActivation), {
    focused: true,
    trusted: true,
    active: true,
  });
  if (mode === "denied") {
    await failureMessage.waitFor();
    assert.equal(await success.count(), 0, "Rejected copy must not report success");
    assert.equal(await paste(page), beforeCopy, "Rejected copy must preserve the clipboard");
  } else {
    await success
      .or(page.getByText(/复制.*失败/).last())
      .first()
      .waitFor({ state: "attached" });
    assert.equal(await paste(page), value, "Paste must contain the selected content");
    assert.equal(await success.count(), 1, "Successful copy must report success");
  }
}

function tableCopy(page) {
  return {
    button: page.getByRole("button", { name: "复制 Markdown", exact: true }),
    success: page.getByText("已复制 Markdown 表格", { exact: true }),
    failure: tableFailure,
    value: tableText,
  };
}

function codeCopy(page) {
  const button = page.getByRole("button", { name: "复制代码", exact: true });
  return { button, success: button.locator(".lucide-check"), value: codeText };
}

async function openLinkMenu(page, link, menuItem, mobile) {
  if (!mobile) {
    await link.click({ button: "right" });
    return;
  }
  await link.scrollIntoViewIfNeeded();
  const bounds = await link.boundingBox();
  assert(bounds);
  const touch = await page.context().newCDPSession(page);
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }],
  });
  try {
    await menuItem.waitFor();
  } finally {
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await touch.detach();
  }
}

async function verify(browser, base, width, mode) {
  const mobile = width < 600;
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    isMobile: mobile,
    hasTouch: mobile,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    // 并行验收时，本地预览也可能花十几秒加载未缓存的脚本。
    page.setDefaultNavigationTimeout(30000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const verifyAction = (action) =>
      verifyCopy(
        page,
        { activate: mobile ? (button) => button.tap() : undefined, ...action },
        mode,
      );
    const origin = await fixture(page, base, mode);
    const url = new URL("/", origin);
    url.search = new URLSearchParams({ host: String(hostId), cwd, thread: thread.id });
    const response = await page.goto(url.href);
    assert(
      response?.ok(),
      `${mode} (${width}px) fixture document returned HTTP ${response?.status()}`,
    );
    assert.deepEqual(
      await page.evaluate(() => [isSecureContext, typeof navigator.clipboard?.writeText]),
      mode === "lan-http" ? [false, "undefined"] : [true, "function"],
    );
    try {
      await page.getByRole("columnheader", { name: "名称" }).waitFor();
    } catch (error) {
      throw Error((await page.locator("body").innerText()) + "\n" + errors.join("\n"), {
        cause: error,
      });
    }
    await verifyAction(tableCopy(page));
    await verifyAction(codeCopy(page));
    const row = page.getByRole("button", { name: "复制", exact: true }).last();
    await verifyAction({ button: row, success: row.locator(".lucide-check"), value: messageText });
    const link = page.getByRole("button", { name: "验收链接", exact: true });
    await verifyAction({
      button: page.getByRole("menuitem", { name: "复制链接", exact: true }),
      success: page.getByText("已复制", { exact: true }),
      value: markdownUrl,
      activate: async (menuItem) => {
        await openLinkMenu(page, link, menuItem, mobile);
        await (mobile ? menuItem.tap() : menuItem.click());
        // 菜单退场时会恢复原焦点，卸载后再聚焦验收用的粘贴输入框。
        await page.locator('[data-slot="context-menu-content"]').waitFor({ state: "detached" });
      },
    });
    if (!mobile) {
      const shareUrl = new URL("/?share=clipboard-share", origin).href;
      await page.evaluate(
        ({ taskId, shareUrl }) => window.openClipboardShareFixture(taskId, shareUrl),
        { taskId: thread.id, shareUrl },
      );
      const share = page.getByTestId("conversation-share-copy-link");
      await verifyAction({
        button: share,
        success: share.getByText("分享链接已复制", { exact: true }),
        failure: "复制分享链接失败",
        value: shareUrl,
      });
    }
    if (mode === "lan-http") {
      await page.goto(`${origin}/?share=clipboard-share`);
      // 模拟 WebKit 的选择区返回值，实际 copy 事件和粘贴仍由 Chromium 执行。
      await page.evaluate(() => {
        const execCommand = document.execCommand.bind(document);
        document.execCommand = (...args) => {
          execCommand(...args);
          return false;
        };
      });
      const table = tableCopy(page);
      await verifyAction({
        ...table,
        activate: async (button) => {
          await button.focus();
          const selection = page.getByRole("columnheader", { name: "名称" });
          await selection.evaluate((element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            document.getSelection().removeAllRanges();
            document.getSelection().addRange(range);
          });
          await button.press("Enter");
          assert.equal(await page.evaluate(() => document.getSelection().toString()), "名称");
          assert.equal(
            await button.evaluate((element) => document.activeElement === element),
            true,
          );
        },
      });
      await verifyAction(codeCopy(page));
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${mode} (${width}px): text pasted and copy feedback verified`);
  } finally {
    await context.close();
  }
}

const outDir = await mkdtemp(join(tmpdir(), "selfhost-clipboard-"));
let server, browser;
try {
  const config = {
    root: web,
    configFile: resolve(web, "vite.config.ts"),
    mode: "selfhost",
    logLevel: "error",
    build: { outDir },
  };
  await build({
    ...config,
    plugins: [
      {
        name: "clipboard-share-fixture",
        transform(source, id) {
          if (!id.endsWith("/store/conversationShareSelectionStore.ts")) return;
          // 用正常状态入口送达已发布结果，保持分享入口的现有权限条件。
          return (
            source +
            `
            globalThis.openClipboardShareFixture = (taskId, publishedShareUrl) => {
              const share = useConversationShareSelectionStore.getState();
              share.openShare(taskId);
              share.updateDockState(taskId, { publishedShareUrl });
            };
          `
          );
        },
      },
    ],
  });
  server = await preview({
    ...config,
    preview: { host: "127.0.0.1", port: 0, allowedHosts: ["clipboard-fixture.test"] },
  });
  // Chromium Headless Shell 使用进程内剪贴板，复制和粘贴不会接触系统剪贴板。
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.SELFHOST_CLIPBOARD_HEADLESS_SHELL,
    // Headless Shell 会沿用系统代理，显式指定直连才能让测试域名到达预览端口。
    args: [
      "--host-resolver-rules=MAP clipboard-fixture.test 127.0.0.1",
      "--proxy-server=direct://",
    ],
  });
  const base = server.resolvedUrls.local[0];
  for (const width of [1480, 390])
    for (const mode of ["lan-http", "secure", "denied"]) await verify(browser, base, width, mode);
} finally {
  await browser?.close();
  await server?.close();
  await rm(outDir, { recursive: true, force: true });
}
