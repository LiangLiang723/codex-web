import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { build, preview } from "vite";

const web = resolve(import.meta.dirname, "../../packages/web");
const target = process.env.SELFHOST_STARTUP_TEST_URL;
const outDir = target ? undefined : await mkdtemp(join(tmpdir(), "codex-web-startup-"));
const cwd = "/startup-fixture";
const hostId = 1;
const project = { hostId, remotePath: cwd, name: "Startup fixture" };
const model = { id: "fixture", model: "fixture", displayName: "Fixture", isDefault: true };
const thread = {
  id: "startup-share",
  cwd,
  name: "Startup share fixture",
  status: { type: "idle" },
  createdAt: 1,
  updatedAt: 2,
};

async function fixture(page, base) {
  const reads = { catalog: 0, hosts: 0, settings: 0, connections: 0 };
  const firstSettings = Promise.withResolvers();
  const firstCatalog = Promise.withResolvers();
  const initialCatalog = Promise.withResolvers();
  await page.route(new URL("/api/**", base).href, async (route) => {
    const request = route.request();
    const { pathname, search } = new URL(request.url());
    if (pathname === "/api/selfhost/settings" && request.method() === "GET") {
      reads.settings++;
      firstSettings.resolve();
      return route.fulfill({ json: { locale: "zh-CN", selfhostLastProject: { hostId, cwd } } });
    }
    if (pathname === "/api/selfhost/projects" && !search) {
      reads.catalog++;
      firstCatalog.resolve();
      await initialCatalog.promise;
      return route.fulfill({ json: [project] });
    }
    if (pathname === "/api/hosts") reads.hosts++;
    const responses = {
      "/api/auth/login": { token: "startup-fixture" },
      "/api/auth/me": { user: { username: "fixture", avatar: null } },
      "/api/hosts": [
        {
          id: hostId,
          name: "Host fixture",
          sshHost: "fixture",
          username: null,
          port: null,
          authMode: "agent",
        },
      ],
      "/api/selfhost/projects": search.includes("organization")
        ? { items: [project], memberships: {} }
        : [project],
      "/api/threads": { data: [], nextCursor: null },
      "/api/models": { data: [model], nextCursor: null },
      "/api/selfhost/workspace": { value: { homedir: cwd, platform: "linux" } },
      "/api/selfhost/organization": {
        value: { revision: 0, members: [], groups: [], order: [] },
      },
      "/api/selfhost/capability": { value: [] },
      "/api/selfhost/shares": {
        title: thread.name,
        sessionId: thread.id,
        history: {
          thread: {
            ...thread,
            turns: [
              {
                id: "turn",
                status: "completed",
                items: [
                  {
                    id: "answer",
                    type: "agentMessage",
                    text: "共享正文 $x^2$\n\n```mermaid\nflowchart LR\n  A --> B\n```",
                  },
                ],
              },
            ],
          },
        },
      },
    };
    return route.fulfill({ json: responses[pathname] ?? {} });
  });
  let liveSocket;
  await page.routeWebSocket("**/api/realtime", (socket) => {
    liveSocket = socket;
    socket.onMessage((value) => {
      const call = JSON.parse(value);
      const reply = (body) => socket.send(JSON.stringify({ ...body, requestId: call.requestId }));
      if (call.type === "auth.authenticate") {
        reads.connections++;
        reply({ type: "ready" });
      } else if (call.type === "project.defaults.read") {
        reply({ defaults: { model: model.id } });
      } else if (call.type === "ping") {
        reply({ type: "pong", nonce: call.nonce });
      } else if (call.requestId) {
        reply({ type: "fixture.result" });
      }
    });
  });
  return {
    reads,
    firstSettings,
    firstCatalog,
    initialCatalog,
    disconnect: () => liveSocket.close(),
  };
}

let server;
let browser;
try {
  let base = target;
  if (!base) {
    const config = { root: web, mode: "selfhost", build: { outDir }, logLevel: "error" };
    await build(config);
    server = await preview({ ...config, preview: { host: "127.0.0.1", port: 0 } });
    base = server.resolvedUrls.local[0];
  }
  // 首屏静态依赖在浏览器访问前就能从发布 HTML 复核，避免抽样遗漏某个预加载。
  const response = await fetch(base);
  assert(response.ok);
  const html = await response.text();
  assert.doesNotMatch(
    html,
    /\/assets\/(Workbench|PrivateShare|SettingsPage|PreviewPane|IntlProvider|katex|mermaid|zh-CN|en-US|ja-JP|ru-RU|ko-KR)-/,
  );
  browser = await chromium.launch({ channel: "chrome", args: ["--proxy-server=direct://"] });
  for (const width of [1480, 390]) {
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      locale: "zh-CN",
      isMobile: width === 390,
      hasTouch: width === 390,
    });
    try {
      const setup = await fixture(page, base);
      const assets = [];
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith("/assets/")) assets.push(path);
      });
      await page.goto(base);
      const username = page.locator("input[name=username]");
      await username.fill("fixture");
      const loginMs = await page.evaluate(() => Math.round(performance.now()));
      assert.equal(setup.reads.catalog, 0);
      assert.equal(setup.reads.settings, 0);
      await page.locator("input[name=password]").fill("fixture-password");
      await page.getByRole("button", { name: "登录" }).click();
      // 目录请求仍人为挂起。设置已经开始读取，才能保证它没有串行排在目录之后。
      await Promise.race([
        Promise.all([setup.firstCatalog.promise, setup.firstSettings.promise]),
        page.waitForURL((url) => url.searchParams.get("cwd") === cwd, { timeout: 15000 }),
      ]);
      setup.initialCatalog.resolve();
      await page.waitForURL((url) => url.searchParams.get("cwd") === cwd);
      // 手机默认展示项目和会话列表，显式打开草稿才能实际使用输入框。
      if (width === 390) {
        await page.getByRole("button", { name: "新建任务", exact: true }).first().click();
      }
      await page.locator("[contenteditable=true]").first().waitFor();
      const workspaceMs = await page.evaluate(() => Math.round(performance.now()));
      assert.deepEqual(setup.reads, { catalog: 1, hosts: 1, settings: 1, connections: 1 });
      assert(assets.some((path) => /\/zh-CN-/.test(path)));
      assert(
        !assets.some((path) =>
          /\/(?:en-US|ja-JP|ru-RU|ko-KR|SettingsPage|PreviewPane|katex|mermaid)-/.test(path),
        ),
      );
      const refreshed = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === "/api/selfhost/projects" && !url.search && response.ok();
      });
      setup.disconnect();
      await refreshed;
      assert.equal(setup.reads.catalog, 2);
      if (width === 1480) {
        await page.getByRole("button", { name: "设置", exact: true }).first().click();
        await page.locator('[data-settings-section-nav="general"]').click();
        const trigger = page.getByTestId("settings-locale-select-trigger");
        const japaneseDownload = Promise.withResolvers();
        await page.route("**/assets/ja-JP-*.js", async (route) => {
          await japaneseDownload.promise;
          await route.continue();
        });
        try {
          await trigger.click();
          const japaneseStarted = page.waitForRequest((request) =>
            /\/ja-JP-.*\.js$/.test(request.url()),
          );
          await page.getByTestId("settings-locale-select-item-ja-JP").click();
          await japaneseStarted;
          assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
          await trigger.click();
          await page.getByTestId("settings-locale-select-item-ko-KR").click();
          await page.locator('html[lang="ko-KR"]').waitFor({ state: "attached" });
          const japaneseResponse = page.waitForResponse(
            (response) => /\/ja-JP-.*\.js$/.test(response.url()) && response.ok(),
          );
          japaneseDownload.resolve();
          await (await japaneseResponse).finished();
          assert.equal(await page.locator("html").getAttribute("lang"), "ko-KR");
          assert.equal(
            await page.evaluate(() => localStorage.getItem("zcode-locale-preference")),
            "ko-KR",
          );
          assert(assets.some((path) => /\/en-US-/.test(path)));
          assert(!assets.some((path) => /\/ru-RU-/.test(path)));
        } finally {
          japaneseDownload.resolve();
        }
      }
      assets.length = 0;
      await page.goto(new URL("?share=startup-share", base).href);
      await page.getByRole("heading", { name: thread.name }).waitFor();
      await page.locator(".katex").first().waitFor();
      await page.locator("[data-mermaid-block] svg[id^=zcode-mermaid]").first().waitFor();
      assert(assets.some((path) => /\/PrivateShare-/.test(path)));
      assert(!assets.some((path) => /\/Workbench-/.test(path)));
      console.log(JSON.stringify({ width, loginMs, workspaceMs }));
    } finally {
      await page.close();
    }
  }
} finally {
  await browser?.close();
  await server?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
}
