import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../..");
const directory = await mkdtemp(join(tmpdir(), "codex-app-management-"));
try {
  const api = join(directory, "gateway"),
    bundle = join(directory, "probe.mjs");
  execFileSync("python3", ["selfhost/gateway/materialize.py", api], { cwd: root });
  await build({
    entryPoints: [join(api, "server/utils/selfhost-apps.ts")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    nodePaths: [join(root, "node_modules")],
  });
  const { manageCodexApps } = await import(pathToFileURL(bundle));
  const calls = [];
  let legacy = false,
    failDirectory = false;
  const app = (id, name, accessible = true) => ({
    id,
    name,
    description: name,
    isAccessible: accessible,
    isEnabled: true,
    pluginDisplayNames: ["Native Pack"],
    installUrl: "https://chatgpt.com/apps/demo",
  });
  const rpc = async (method, params) => {
    calls.push([method, params]);
    if (method === "app/list") {
      if (failDirectory) throw Error("directory offline");
      return params.cursor
        ? { data: [app("directory", "Unconnected", false)], nextCursor: null }
        : { data: [app("app.with.dot", "Documents")], nextCursor: "next" };
    }
    if (method === "app/installed") {
      if (legacy)
        throw Object.assign(Error("Invalid request: unknown variant `app/installed`"), {
          rpcCode: -32600,
        });
      return {
        apps: [
          { id: "app.with.dot", runtimeName: "Runtime Docs", enabled: false, callable: false },
          { id: "installed-only", runtimeName: "Remote notes", enabled: true, callable: true },
        ],
      };
    }
    if (method === "app/read")
      return {
        apps: [
          {
            id: params.appIds[0],
            name: "Documents",
            pluginDisplayNames: ["Native Pack"],
            toolSummaries: [
              {
                name: "files/list.v2",
                description: "List files",
                isEnabled: true,
                isReadOnly: true,
              },
            ],
          },
        ],
        missingAppIds: [],
      };
    if (method === "config/value/write")
      return { status: "okOverridden", overriddenMetadata: { message: "Managed setting" } };
    throw Error("Unexpected native method " + method);
  };
  let list = await manageCodexApps(rpc, { operation: "list", force: true });
  assert.equal(list.apps.length, 2);
  assert.equal(list.nextCursor, "next");
  assert.equal(calls.filter(([method]) => method === "app/list").length, 1);
  const second = await manageCodexApps(rpc, {
    operation: "list",
    force: false,
    cursor: list.nextCursor,
  });
  assert.equal(list.apps.find((a) => a.id === "app.with.dot").enabled, false);
  assert.equal(second.apps.find((a) => a.id === "directory").accessible, false);
  assert.equal(list.apps.find((a) => a.id === "installed-only").callable, true);
  assert.deepEqual(
    calls
      .filter(([method]) => method === "app/list")
      .map(([, args]) => [args.cursor, args.forceRefetch]),
    [
      [null, true],
      ["next", false],
    ],
  );
  const detail = await manageCodexApps(rpc, { operation: "detail", id: "app.with.dot" });
  assert.equal(detail.tools[0].name, "files/list.v2");
  assert.equal(detail.tools[0].readOnly, true);
  const written = await manageCodexApps(rpc, {
    operation: "setEnabled",
    id: "app.with.dot",
    tool: "files/list.v2",
    enabled: false,
  });
  assert.equal(written.overridden, true);
  assert.deepEqual(calls.at(-1), [
    "config/value/write",
    {
      keyPath: 'apps."app.with.dot".tools."files/list.v2".enabled',
      mergeStrategy: "upsert",
      value: false,
    },
  ]);
  await assert.rejects(
    manageCodexApps(rpc, { operation: "setEnabled", id: "_default", enabled: false }),
  );
  await assert.rejects(
    manageCodexApps(rpc, {
      operation: "setEnabled",
      id: "app.with.dot",
      tool: "unknown",
      enabled: false,
    }),
  );
  legacy = true;
  list = await manageCodexApps(rpc, { operation: "list", force: false });
  assert.equal(list.apps[0].installed, null);
  assert.equal(list.apps[0].callable, null);
  legacy = false;
  failDirectory = true;
  list = await manageCodexApps(rpc, { operation: "list", force: false });
  assert.equal(list.apps.length, 2);
  assert.ok(list.directoryIssue);
  console.log(
    "PASS native App directory pagination, runtime fallback, tools, scoped config writes and policy overrides",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
