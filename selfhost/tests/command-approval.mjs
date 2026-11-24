import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { build, preview } from "vite";

const web = resolve(import.meta.dirname, "../../packages/web");
const hostId = 1;
const threadId = "approval-fixture";
const turnId = "turn-1";
const cwd = "/approval-fixture";
const command = '/usr/bin/bash -lc \'printf "%s\\n" "sample text"\'';
const prefix = ["printf", "%s\\n", "sample text"];
const amendment = { acceptWithExecpolicyAmendment: { execpolicy_amendment: prefix } };
const method = "item/commandExecution/requestApproval";
const thread = {
  id: threadId,
  cwd,
  name: "终端审批测试",
  createdAt: 1,
  updatedAt: 2,
  status: { type: "active" },
};
const model = {
  id: "test-model",
  model: "test-model",
  displayName: "Test Model",
  isDefault: true,
  defaultReasoningEffort: "low",
  supportedReasoningEfforts: [{ reasoningEffort: "low" }],
};

async function verifyCommandApproval(page, origin) {
  const prompt = {
    id: "prompt",
    type: "userMessage",
    content: [{ type: "text", text: "审批测试" }],
  };
  let item;
  const sockets = new Set();
  let cursor = 0;
  let turnStatus = "inProgress";
  const pendingRequests = new Map();
  let heldResolution;
  const responses = [];
  const errors = [];
  const networkErrors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400)
      networkErrors.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  const emit = (event) => {
    const envelope = { id: ++cursor, hostId, threadId, event, createdAt: new Date().toISOString() };
    if (event.type === "serverRequest.requested") pendingRequests.set(event.requestId, envelope);
    if (event.type === "serverRequest.resolved") pendingRequests.delete(event.requestId);
    const encoded = JSON.stringify({
      type: "thread.event",
      event: envelope,
      eventEpoch: "approval-fixture",
    });
    for (const socket of sockets) socket.send(encoded);
  };
  const requested = (id, nativeMethod, params, requestKind = "approval") =>
    emit({
      type: "serverRequest.requested",
      requestId: id,
      requestKind,
      item: {
        type: "serverRequest",
        id: `request-${typeof id}-${id}`,
        status: "waitingForClient",
        method: nativeMethod,
        requestId: id,
        params: { threadId, ...params },
      },
    });
  async function attach(client) {
    await client.addInitScript(() => {
      localStorage.setItem("selfhost.auth", "approval-test-fixture");
      localStorage.setItem("zcode-locale-preference", "zh-CN");
    });
    await client.route(new URL("/api/**", origin).href, (route) => {
      const url = new URL(route.request().url());
      const project = { hostId, remotePath: cwd, name: "审批测试项目" };
      const request = route.request().postDataJSON();
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
        "/api/threads": {
          data: url.searchParams.get("archived") === "true" ? [] : [thread],
          nextCursor: null,
        },
        "/api/selfhost/thread-summary": { thread },
        "/api/models": { data: [model], nextCursor: null },
        "/api/selfhost/settings": { locale: "zh-CN" },
        "/api/selfhost/organization": {
          value:
            request?.channel === "task-groups"
              ? { revision: 0, members: [], groups: [], order: [] }
              : [],
        },
        "/api/selfhost/workspace": {
          value: request?.channel === "system" ? { homedir: cwd, platform: "darwin" } : [],
        },
        "/api/selfhost/capability": { value: [] },
      };
      return route.fulfill({ json: values[url.pathname] ?? {} });
    });
    await client.routeWebSocket("**/api/realtime", (ws) => {
      sockets.add(ws);
      ws.onClose(() => sockets.delete(ws));
      ws.onMessage((data) => {
        const call = JSON.parse(data);
        const reply = (message) =>
          ws.send(JSON.stringify({ ...message, requestId: call.requestId }));
        switch (call.type) {
          case "auth.authenticate":
            reply({ type: "ready" });
            break;
          case "thread.activate":
            reply({
              type: "thread.snapshot",
              thread,
              history: {
                thread: {
                  ...thread,
                  turns: [
                    {
                      id: turnId,
                      status: turnStatus,
                      items: item ? [prompt, item] : [prompt],
                    },
                  ],
                },
              },
              lastEventId: cursor,
              eventEpoch: "approval-fixture",
              pendingRequests: [...pendingRequests.values()],
            });
            break;
          case "project.defaults.read":
            reply({ defaults: { model: model.model } });
            break;
          case "serverRequest.respond":
            if (responses.some(({ serverRequestId }) => serverRequestId === call.serverRequestId)) {
              responses.push(call);
              reply({ type: "error", message: "This Codex request has already been answered." });
              break;
            }
            responses.push(call);
            item = undefined;
            reply({ type: "serverRequest.respond.accepted" });
            if (heldResolution !== call.serverRequestId)
              emit({ type: "serverRequest.resolved", requestId: call.serverRequestId });
            break;
          case "ping":
            reply({ type: "pong", nonce: call.nonce });
            break;
          default:
            if (call.requestId) reply({ type: "fixture.result" });
        }
      });
    });
  }
  await attach(page);
  const url = new URL("/", origin);
  url.search = new URLSearchParams({ host: String(hostId), cwd, thread: threadId });
  await page.goto(url.href);
  await page
    .getByText("审批测试", { exact: true })
    .waitFor({ timeout: 25000 })
    .catch(async (error) => {
      throw new Error(
        `${error.message}\n${(await page.locator("body").innerText()).slice(0, 800)}\n${errors.concat(networkErrors.slice(0, 8)).join("\n")}`,
        { cause: error },
      );
    });

  const choices = page.getByRole("listbox", { name: "需要权限" });
  const card = choices.locator("../..");
  const similar = choices.getByRole("option", { name: "允许类似命令", exact: true });
  async function show(id, params) {
    item = {
      type: "commandExecution",
      id: `command-${id}`,
      turnId,
      status: "waitingForApproval",
      command,
      cwd,
      pendingApproval: { requestId: id, method, params: { command, cwd, ...params } },
    };
    emit({ type: "timeline.item.upsert", item });
    await choices.waitFor();
    assert.equal(await choices.count(), 1);
    const normalized = (await card.innerText()).replace(/\s+/g, " ");
    assert.equal(normalized.split(command).length - 1, 1, "show the full command exactly once");
  }
  async function choose(name, id, decision, nextReason) {
    await choices.getByRole("option", { name, exact: true }).focus();
    await card.getByRole("button", { name: "确认", exact: true }).click();
    if (nextReason) await card.getByText(nextReason).waitFor();
    else await choices.waitFor({ state: "hidden" });
    const response = responses.at(-1);
    assert.equal(response.threadId, threadId);
    assert.equal(response.hostId, hostId);
    assert.equal(response.eventEpoch, "approval-fixture");
    assert.equal(response.serverRequestId, id);
    assert.deepEqual(response.result, { decision });
  }

  await show(101, {});
  assert.equal(await similar.count(), 0);
  await choose("允许本轮", 101, "accept");

  const reason = "需要读取工作区中的示例配置。";
  await show(102, { reason, availableDecisions: ["accept", amendment, "decline"] });
  assert.equal(await card.getByText(reason, { exact: true }).count(), 1);
  await page.reload();
  await similar.waitFor();
  assert.equal(await similar.count(), 1);
  assert((await similar.innerText()).includes(JSON.stringify(prefix)));
  await choose("允许类似命令", 102, amendment);

  await show(103, { reason: command, proposedExecpolicyAmendment: prefix });
  await choose("允许类似命令", 103, amendment);

  await show(104, {
    proposedExecpolicyAmendment: prefix,
    availableDecisions: ["accept", "acceptForSession", "decline"],
  });
  assert.equal(await similar.count(), 0);
  await choose("允许本会话", 104, "acceptForSession");

  await show(105, { availableDecisions: ["accept", "decline"] });
  await choose("拒绝", 105, "decline");
  assert.equal(responses.length, 5);

  const shared = {
    turnId,
    itemId: "shared-command",
    command,
    cwd,
    availableDecisions: ["accept", "decline"],
  };
  requested(106, method, { ...shared, approvalId: "first", reason: "第一项原生审批" });
  requested("106", method, { ...shared, approvalId: "second", reason: "第二项原生审批" });
  await card.getByText("第一项原生审批").waitFor();
  await choose("允许本轮", 106, "accept", "第二项原生审批");
  await page.reload();
  await card.getByText("第二项原生审批").waitFor();
  await choose("拒绝", "106", "decline");

  const networkDecision = {
    applyNetworkPolicyAmendment: {
      network_policy_amendment: { host: "fixture.example", action: "deny" },
    },
  };
  requested(107, method, {
    ...shared,
    reason: "确认联网访问",
    networkApprovalContext: { host: "fixture.example", protocol: "https" },
    availableDecisions: ["accept", "acceptForSession", networkDecision, "decline"],
  });
  await card
    .getByText(/fixture\.example/)
    .first()
    .waitFor();
  await choose("保存拒绝规则", 107, networkDecision);

  const permissions = { fileSystem: { read: ["/fixture/source"], write: ["/fixture/target"] } };
  requested(108, "item/permissions/requestApproval", {
    turnId,
    cwd,
    permissions,
    reason: "确认文件读写权限",
  });
  await card.getByText("确认文件读写权限").waitFor();
  await card
    .getByText(/\/fixture\/target/)
    .first()
    .waitFor();
  await choices.getByRole("option", { name: "允许本会话", exact: true }).focus();
  await card.getByRole("button", { name: "确认", exact: true }).click();
  await choices.waitFor({ state: "hidden" });
  assert.deepEqual(responses.at(-1).result, { permissions, scope: "session" });

  const questions = [
    {
      id: "visible",
      header: "First",
      question: "同一题面",
      options: [{ label: "甲", description: "" }],
    },
    { id: "secret", header: "Secret", question: "同一题面", isSecret: true, options: null },
  ];
  requested(
    109,
    "item/tool/requestUserInput",
    { turnId, questions, isBlocking: true },
    "userInput",
  );
  const q = page.getByTestId("codex-user-input");
  await q.locator('input[type="password"]').fill("fixture-secret");
  await q.getByRole("button", { name: "提交", exact: true }).click();
  await q.waitFor({ state: "hidden" });
  assert.deepEqual(responses.at(-1).result, {
    answers: { secret: { answers: ["fixture-secret"] } },
  });
  assert.equal(
    await page.evaluate(() => JSON.stringify(localStorage).includes("fixture-secret")),
    false,
  );
  requested(110, "item/tool/requestUserInput", { turnId, questions }, "userInput");
  await q.getByRole("button", { name: "跳过", exact: true }).click();
  await q.waitFor({ state: "hidden" });
  assert.deepEqual(responses.at(-1).result, { answers: {} });

  turnStatus = "completed";
  emit({ type: "turn.completed", turn: { id: turnId, status: turnStatus, items: [prompt] } });
  requested(
    111,
    "mcpServer/elicitation/request",
    {
      turnId: null,
      mode: "form",
      serverName: "fixture-mcp",
      message: "线程级 MCP 表单",
      requestedSchema: { type: "object", properties: {} },
    },
    "elicitation",
  );
  const form = page.getByTestId("codex-mcp-elicitation");
  await form.getByText("线程级 MCP 表单").waitFor();
  await form.getByRole("button", { name: "拒绝", exact: true }).click();
  await form.waitFor({ state: "hidden" });
  assert.equal(responses.at(-1).serverRequestId, 111);
  assert.deepEqual(responses.at(-1).result, { action: "decline", content: null, _meta: null });
  assert.equal(await page.getByTestId("v4-stop").count(), 0);

  const viewport = page.viewportSize();
  const secondClient = await page
    .context()
    .browser()
    .newContext({
      viewport,
      isMobile: viewport.width < 600,
    });
  const other = await secondClient.newPage();
  other.on("pageerror", (error) => errors.push(error.message));
  try {
    await attach(other);
    await other.goto(url.href);
    await other.getByText("审批测试", { exact: true }).waitFor();
    heldResolution = 112;
    requested(112, method, { ...shared, reason: "双端同时待答" });
    const otherChoices = other.getByRole("listbox", { name: "需要权限" });
    await card.getByText("双端同时待答").waitFor();
    await otherChoices.locator("../..").getByText("双端同时待答").waitFor();
    await choices.getByRole("option", { name: "允许本轮", exact: true }).focus();
    await card.getByRole("button", { name: "确认", exact: true }).click();
    await otherChoices.getByRole("option", { name: "拒绝", exact: true }).focus();
    await otherChoices.locator("../..").getByRole("button", { name: "确认", exact: true }).click();
    await other.getByText("审批未完成，请重试。", { exact: true }).waitFor();
    assert.equal(await card.getByRole("button", { name: "确认", exact: true }).isDisabled(), true);
    assert.deepEqual(
      responses
        .filter(({ serverRequestId }) => serverRequestId === 112)
        .map(({ result }) => result),
      [{ decision: "accept" }, { decision: "decline" }],
    );
    emit({ type: "serverRequest.resolved", requestId: 112 });
    await Promise.all([
      choices.waitFor({ state: "hidden" }),
      otherChoices.waitFor({ state: "hidden" }),
    ]);
  } finally {
    await secondClient.close();
  }
  assert.deepEqual(errors, []);
}

const target = process.env.SELFHOST_COMMAND_APPROVAL_TEST_URL;
const outDir = target ? null : await mkdtemp(join(tmpdir(), "selfhost-command-approval-"));
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
    for (const width of [1480, 390]) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        isMobile: width < 600,
      });
      try {
        await verifyCommandApproval(page, origin);
        console.log(`PASS self-hosted command approval (${width}px)`);
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
