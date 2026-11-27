import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createServer } from "vite";

const root = resolve(import.meta.dirname, "../../packages/web");
const vite = await createServer({
  root,
  configFile: resolve(root, "vite.config.ts"),
  mode: "selfhost",
  logLevel: "error",
  server: { middlewareMode: true, hmr: false, watch: null, ws: false },
});
const rows = [
  { id: "a-old", cwd: "/A", createdAt: 1, recencyAt: 9, updatedAt: 9, pinned: true },
  { id: "b-new", cwd: "/B", createdAt: 5, recencyAt: 5, updatedAt: 5 },
  { id: "a-new", cwd: "/A", createdAt: 4, recencyAt: 4, updatedAt: 4 },
].map((t) => ({ ...t, name: t.id, status: { type: "idle" } }));
const calls = [];
const listCalls = [];
const mcpListCalls = [];
const mcpStatusPages = [
  [
    {
      name: "ready",
      runtimeStatus: "connected",
      authStatus: "oAuth",
      httpOrigin: "https://fixture.invalid",
      tools: {},
      toolsError: null,
    },
    { name: "starting", runtimeStatus: "starting", tools: { cached: {} } },
    { name: "failed", runtimeStatus: "failed", tools: { cached: {} }, toolsError: null },
    { name: "reauth", runtimeStatus: "authenticationRequired", authStatus: "oAuth", tools: {} },
    { name: "disabled", runtimeStatus: "disabled", tools: {} },
  ],
  [
    { name: "discovery", runtimeStatus: null, tools: {}, toolsError: "Tool inventory timed out" },
    {
      name: "auth",
      runtimeStatus: null,
      authStatus: "notLoggedIn",
      tools: {},
      toolsError: "Login required",
    },
    { name: "legacy", tools: { lookup: {} }, authStatus: "unsupported", resources: [] },
    { name: "unknown", tools: {}, authStatus: "unknown" },
  ],
];
let threadRows = [...rows, { ...rows[0], id: "archived", archived: true }];
let heldPoint;
const listeners = new Set();
const socketCalls = [];
const sessionId = "3f8a4a38-4726-42bf-9f2d-225652625ffa";
const notify = (message) => {
  for (const listener of listeners) listener(message);
};
const gateway = {
  on: (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  onTerminal: () => () => {},
  connect: async () => {},
  send: async (message) => {
    socketCalls.push([message.type]);
  },
  models: async (_host, provider) => {
    if (provider === "broken") throw Error("modelProviderNotConfigured");
    const model = provider === "other" ? "specific" : "default";
    return [
      {
        id: model,
        model,
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: [{ reasoningEffort: "low" }],
      },
    ];
  },
  call: async (method, params, requestId) => {
    socketCalls.push([method, params, requestId]);
    if (method === "terminal.open") return { session: { sessionId, output: "" } };
    if (method === "terminal.list") return { sessions: [] };
    return { defaults: { model: "default" } };
  },
  request: async (url, schema, _method, payload) => {
    const u = new URL(url, "http://fixture.invalid");
    calls.push(u.pathname);
    if (u.pathname === "/api/threads") {
      listCalls.push(u.searchParams);
      const cwd = u.searchParams.get("cwd");
      const ids = u.searchParams.get("includedThreadIds")?.split(",");
      const archived = u.searchParams.get("archived") === "true";
      const sortKey = u.searchParams.get("sortKey");
      const sortTime = (t) => sortKey === "created_at" ? t.createdAt :
        sortKey === "recency_at" ? (t.recencyAt ?? t.createdAt) : t.updatedAt;
      const offset = Number(u.searchParams.get("cursor") ?? 0);
      const limit = Number(u.searchParams.get("limit") ?? 100);
      const scoped = threadRows
        .filter((t) => !!t.archived === archived && (!cwd || t.cwd === cwd) && (!ids || ids.includes(t.id)))
        .sort((a, b) => sortTime(b) - sortTime(a));
      return schema.parse({
        nextCursor: offset + limit < scoped.length ? String(offset + limit) : null,
        data: scoped.slice(offset, offset + limit),
      });
    }
    if (u.pathname === "/api/selfhost/thread-summary") {
      const thread = threadRows.find((t) => t.id === u.searchParams.get("threadId")) ?? null;
      const waiting = heldPoint;
      heldPoint = undefined;
      if (waiting) await waiting.promise;
      return schema.parse({ thread });
    }
    if (u.pathname === "/api/config/pinned-threads") {
      threadRows = threadRows.map((t) =>
        t.id === (payload.threadId ?? payload.thread?.threadId)
          ? { ...t, pinned: payload.pinned }
          : t,
      );
      return schema.parse({});
    }
    if (u.pathname === "/api/selfhost/thread-state" && payload.operation === "unread") {
      threadRows = threadRows.map((thread) => {
        if (thread.id !== payload.threadId) return thread;
        if (payload.unread) return { ...thread, unreadAt: (thread.unreadAt ?? 1) + 1 };
        return payload.expectedUnreadAt === thread.unreadAt
          ? { ...thread, unreadAt: undefined }
          : thread;
      });
      return schema.parse({});
    }
    if (u.pathname === "/api/selfhost/capability" && payload?.method === "mcpServerStatus/list") {
      const { cursor } = payload.params;
      mcpListCalls.push([payload.hostId, cursor]);
      return schema.parse({
        value: {
          data: mcpStatusPages[cursor === null ? 0 : 1],
          nextCursor: cursor === null ? "next" : null,
        },
      });
    }
    return schema.parse({});
  },
};
globalThis.document = Object.assign(new EventTarget(), { hidden: true });
globalThis.window = new EventTarget();

async function verifyNativeRecency(tasks) {
  const original = threadRows;
  const query = { kind: "timeline", workspaceScopes: "host", sortBy: "updated" };
  const order = async () => (await tasks.listTaskList(query)).items.map((item) => item.taskId);
  try {
    assert.deepEqual(await order(), ["a-old", "b-new", "a-new"]);
    threadRows = threadRows.map((thread) =>
      thread.id === "a-new" ? { ...thread, updatedAt: 20 } : thread,
    );
    assert.deepEqual(await order(), ["a-old", "b-new", "a-new"], "stream writes must preserve order");
    threadRows = threadRows.map((thread) =>
      thread.id === "a-new" ? { ...thread, recencyAt: 21 } : thread,
    );
    assert.deepEqual(await order(), ["a-new", "a-old", "b-new"]);
  } finally {
    threadRows = original;
  }
}

async function verifyNativeCatalogBudget(tasks) {
  await verifyNativeRecency(tasks);
  const originalRows = threadRows;
  threadRows = Array.from({ length: 600 }, (_, index) => ({
    id: `large-${index}`,
    cwd: index === 3 ? "/B" : "/A",
    name: `large-${index}`,
    createdAt: index + 1,
    updatedAt: 600 - index,
    pinned: index === 1 || index === 20,
    archived: index % 10 === 0,
    status: { type: "idle" },
  }));
  const scope = { workspaceScopes: "host", sortBy: "created" };
  try {
    for (const [kind, ids, expected] of [
      ["timeline", ["large-1", "large-2", "large-20", "missing"], ["large-2", "large-1"]],
      ["archived", ["large-0", "large-20", "large-21"], ["large-20", "large-0"]],
      ["pinned", ["large-1", "large-2", "large-20"], ["large-1"]],
    ]) {
      listCalls.length = 0;
      const result = await tasks.listTaskList({ ...scope, kind, taskIds: ids });
      assert.deepEqual(result.items.map((item) => item.taskId), expected);
      assert.equal(result.total, expected.length);
      assert.equal(result.hasMore, false);
      assert.equal(listCalls.length, 1, `${kind} should send one targeted list request`);
      assert.deepEqual(new Set(listCalls[0].get("includedThreadIds").split(",")), new Set(ids));
      assert.equal(listCalls[0].get("sortKey"), "created_at");
    }

    listCalls.length = 0;
    const fullQuery = { ...scope, kind: "timeline", limit: 1 };
    const [first, replica] = await Promise.all([tasks.listTaskList(fullQuery), tasks.listTaskList(fullQuery)]);
    assert.deepEqual(first, replica);
    assert.equal(first.items[0].taskId, "large-599");
    assert.equal(first.total, 540);
    assert.equal(first.hasMore, true);
    assert.equal(listCalls.length, 6, "concurrent exact callers should share one pagination pass");
    await tasks.listTaskList(fullQuery);
    assert.equal(listCalls.length, 12, "completed exact reads should be refreshed");

    calls.length = 0;
    const address = { workspacePath: "/A", taskId: "large-1" };
    await Promise.all([tasks.getTaskMeta({ address }), tasks.getTaskMeta({ address })]);
    assert.deepEqual(calls, ["/api/selfhost/thread-summary"]);

    calls.length = 0;
    const oldPoint = Promise.withResolvers();
    heldPoint = oldPoint;
    const previous = tasks.getTaskMeta({ address });
    const changed = tasks.mutateTask({ address, mutation: { kind: "pin", pinned: false } });
    try {
      await new Promise((done) => setImmediate(done));
      assert.deepEqual(calls, [
        "/api/selfhost/thread-summary",
        "/api/config/pinned-threads",
        "/api/selfhost/thread-summary",
      ]);
    } finally {
      oldPoint.resolve();
    }
    assert.equal((await previous).pinned, true);
    assert.equal((await changed).pinned, false);

    listCalls.length = 0;
    document.hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((done) => setImmediate(done));
    assert.equal(listCalls.length, 1, "directory preview should stop after the first page");
    assert.equal(listCalls[0].get("limit"), "25");
    assert.equal(listCalls[0].get("sortKey"), "recency_at");
    assert.equal(listCalls[0].get("discoverProjects"), "false");
    assert.equal(listCalls[0].get("cursor"), null);
    console.log("PASS 600 threads: scoped IDs, concurrent exact total, refreshed reads and one-page preview");
  } finally {
    document.hidden = true;
    threadRows = originalRows;
  }
}

try {
  const { openWorkspace } = await vite.ssrLoadModule("/src/selfhost/services.ts");
  const opened = await openWorkspace(gateway, 1, "/A", () => {});
  try {
    const {
      windowControllerService: tasks,
      modelSelectionService,
      mcpSyncService,
    } = opened.services;
    const q = {
      kind: "timeline",
      workspaceScopes: [{ workspacePath: "/A" }, { workspacePath: "/B" }],
      sortBy: "created",
    };
    assert.deepEqual(
      (await tasks.listTaskList(q)).items.map((t) => t.taskId),
      ["b-new", "a-new", "a-old"],
    );
    assert.equal(
      (await tasks.listTaskList({ ...q, kind: "archived", workspaceScopes: "host" })).items[0]
        .archived,
      true,
    );
    assert.equal((await tasks.listTaskList({ ...q, kind: "pinned" })).items[0].taskId, "a-old");
    calls.length = 0;
    assert.equal(
      (await tasks.getTaskMeta({ address: { workspacePath: "/A", taskId: "a-old" } })).taskId,
      "a-old",
    );
    assert.ok(!calls.includes("/api/threads"));
    await tasks.mutateTask({
      address: { workspacePath: "/A", taskId: "a-old" },
      mutation: { kind: "pin", pinned: false },
    });
    assert.ok(calls.includes("/api/config/pinned-threads"));
    const address = { workspacePath: "/A", taskId: "a-new" };
    const firstUnread = await tasks.mutateTask({ address, mutation: { kind: "mark-unread" } });
    const secondUnread = await tasks.mutateTask({ address, mutation: { kind: "mark-unread" } });
    assert(firstUnread.unreadAt < secondUnread.unreadAt);
    const readThroughOldMarker = await tasks.mutateTask({
      address,
      mutation: { kind: "mark-read", expectedUnreadAt: firstUnread.unreadAt },
    });
    assert.equal(readThroughOldMarker.unreadAt, secondUnread.unreadAt);
    assert.equal(
      (
        await tasks.mutateTask({
          address,
          mutation: { kind: "mark-read", expectedUnreadAt: secondUnread.unreadAt },
        })
      ).unreadAt,
      undefined,
    );
    await verifyNativeCatalogBudget(tasks);
    const view = await modelSelectionService.getView({
      selection: { modelId: "specific", providerId: "glm", options: { reasoningLevel: "high" } },
      workspacePath: "/B",
      nativeModelProvider: "other",
    });
    assert.equal(view.effectiveSelection.modelId, "specific");
    assert.equal(view.effectiveSelection.options.reasoningLevel, "low");
    const { zcodeMcpListResultSchema } = await vite.ssrLoadModule("@zcode/shared");
    const mcpParams = { workspacePath: "/B" };
    const mcpResults = [
      await mcpSyncService.listWorkspaceMcpServerStatuses(mcpParams),
      await opened.services.zcodeAgentService.listMcpServerStatuses(mcpParams),
    ];
    for (const result of mcpResults) {
      const { statuses } = zcodeMcpListResultSchema.parse(result);
      const status = (name) => {
        const { updatedAt, ...snapshot } = statuses[name];
        assert.ok(Number.isFinite(Date.parse(updatedAt)));
        return snapshot;
      };
      assert.deepEqual(status("ready"), { status: "connected", transport: "http", toolCount: 0 });
      assert.equal(status("starting").status, "connecting");
      assert.equal(status("failed").status, "failed");
      assert.equal(status("failed").failureKind, "connection_failed");
      assert.equal(status("reauth").status, "failed");
      assert.equal(status("reauth").failureKind, "not_authenticated");
      assert.equal(status("disabled").status, "disabled");
      assert.deepEqual(status("discovery"), {
        status: "failed",
        transport: "stdio",
        toolCount: 0,
        failureKind: "tool_list_failed",
        error: "Tool inventory timed out",
      });
      assert.equal(status("auth").status, "failed");
      assert.equal(status("auth").failureKind, "not_authenticated");
      assert.equal(status("legacy").status, "connected");
      assert.equal(status("legacy").toolCount, 1);
      assert.equal(status("unknown").status, "disconnected");
    }
    assert.deepEqual(mcpListCalls, [
      [1, null],
      [1, "next"],
      [1, null],
      [1, "next"],
    ]);
    const providerView = await opened.services.providerSettingsService.refresh(
      "root-provider-state-refresh",
    );
    assert.deepEqual(providerView.providerTemplates, []);
    assert.equal(providerView.providers[0].models[0].modelId, "default");
    const { fileWatcherService, terminalService } = opened.services;
    const watch = await fileWatcherService.watch({ path: "/A/sub" });
    const leases = () => socketCalls.filter(([method]) => method === "file.watch.subscribe");
    assert.equal(leases().length, 1);
    notify({ type: "host.lifecycle", event: { hostId: 1, status: "disconnected" } });
    notify({ type: "host.lifecycle", event: { hostId: 2, status: "connected" } });
    assert.equal(leases().length, 1);
    notify({ type: "host.lifecycle", event: { hostId: 1, status: "connected" } });
    assert.equal(leases().length, 2);
    assert.equal(leases()[1][1].threadId, watch.id);
    assert.notEqual(leases()[1][2], leases()[0][2]);
    await fileWatcherService.unwatch(watch);
    const terminal = await terminalService.create({ cwd: "/A", cols: 80, rows: 24 });
    notify({ type: "disconnected" });
    notify({ type: "ready" });
    await assert.rejects(terminalService.write({ id: terminal.id, data: "hello" }), /终端已退出/u);
    assert.ok(socketCalls.some(([method]) => method === "terminal.list"));
    assert.ok(!socketCalls.some(([method]) => method === "terminal.input"));
  } finally {
    opened.dispose();
  }
  const noModels = await openWorkspace(
    {
      ...gateway,
      models: async () => {
        throw Error("modelProviderNotConfigured");
      },
    },
    1,
    "/B",
    () => {},
  );
  noModels.dispose();
  console.log(
    "PASS scoped lists, point lookup, pin/archive, model provider, MCP, SSH watch reattachment and closed PTY reconciliation",
  );
} finally {
  await vite.close();
}
