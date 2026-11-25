import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

const exec = promisify(execFile);
const repo = resolve(import.meta.dirname, "../..");
const cwd = await realpath(await mkdtemp(join(tmpdir(), "selfhost-plugin-settings-")));
const env = { ...process.env, CODEX_HOME: join(cwd, "codex-home") };
for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "CHATGPT_AUTH_TOKEN"]) delete env[key];
const binary = process.env.SELFHOST_PLUGIN_CODEX_BIN ?? "codex";
const nativeChanges = [];
const cliCommands = [];
const host = { id: 7 };
let appServer;

try {
  await mkdir(env.CODEX_HOME);
  appServer = spawn(binary, ["app-server"], { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map();
  const lines = createInterface({ input: appServer.stdout });
  let sequence = 0;
  lines.on("line", (line) => {
    const value = JSON.parse(line);
    const request = pending.get(value.id);
    if (!request) return;
    pending.delete(value.id);
    if (value.error) request.reject(Error(value.error.message));
    else request.resolve(value.result);
  });
  const rpc = (method, params) => {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      appServer.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  };
  const initialize = await rpc("initialize", {
    clientInfo: { name: "fixture", title: "Plugin acceptance fixture", version: "1" },
  });
  assert.equal(initialize.codexHome, env.CODEX_HOME);
  appServer.stdin.write('{"method":"initialized"}\n');
  globalThis.pluginGatewayFixture = {
    async command(target, command, options) {
      assert.equal(target, host);
      cliCommands.push({ command, timeout: options.timeoutMs });
      try {
        return {
          code: 0,
          ...(await exec("/bin/sh", ["-c", command], {
            env: { ...env, CODEX_BIN: binary },
            timeout: options.timeoutMs,
          })),
        };
      } catch (error) {
        return { code: error.code, stdout: error.stdout, stderr: error.stderr };
      }
    },
    rpc(target, method, params) {
      assert.equal(target, host);
      if (method === "config/batchWrite") nativeChanges.push(params);
      return rpc(method, params);
    },
    async openRemoteFile(target, file) {
      assert.equal(target, host);
      try {
        const { Readable } = await import("node:stream");
        return { stream: Readable.from(await readFile(file)) };
      } catch (error) {
        if (error.code === "ENOENT")
          throw Object.assign(error, { name: "RemoteFileNotFoundError" });
        throw error;
      }
    },
  };
  const { outputFiles } = await build({
    absWorkingDir: repo,
    stdin: {
      contents: `export * from './selfhost/gateway/overlay/utils/selfhost-native-plugins';`,
      resolveDir: repo,
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    plugins: [
      {
        name: "fixture-transport",
        setup(plugin) {
          const mock = {
            "host-services": `export const sshConnections = { exec: globalThis.pluginGatewayFixture.command }; export const remoteFiles = { openRemoteFile: globalThis.pluginGatewayFixture.openRemoteFile };`,
            broker: `export const threadBroker = { selfhostCapability: globalThis.pluginGatewayFixture.rpc };`,
            "remote-command": `export const remoteLoginShellCommand = (payload) => payload; export const codexRemotePayload = (payload) => payload;`,
          };
          plugin.onResolve({ filter: /gateway\/infra\/ssh\/(shell|shell\.ts)$/ }, () => ({
            path: join(repo, "upstream/codex-gateway/server/utils/gateway/infra/ssh/shell.ts"),
          }));
          plugin.onResolve({ filter: /\/(host-services|broker|remote-command)$/ }, ({ path }) => ({
            path: path.split("/").at(-1),
            namespace: "fixture",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
            contents: mock[path],
          }));
        },
      },
    ],
  });
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`;
  const { nativePluginRequestSchema, manageNativePlugins } = await import(moduleUrl);
  const invoke = (operation, params = {}) =>
    manageNativePlugins(
      host,
      nativePluginRequestSchema.parse({ operation, hostId: host.id, cwd, ...params }),
    );
  const pluginSkills = async () => {
    const result = await rpc("skills/list", { cwds: [cwd] });
    return result.data[0].skills.filter((skill) => skill.pluginId).map((skill) => skill.pluginId);
  };
  assert.deepEqual(await pluginSkills(), []);

  for (const marketplace of ["fixture-first", "fixture-second"]) {
    // Paths with spaces and shell punctuation are literal SSH argv values.
    const root = join(cwd, `${marketplace} ' & spaces`);
    const manifest = join(root, "plugins/review/.codex-plugin");
    const skill = join(root, "plugins/review/skills/sample");
    await mkdir(join(root, ".agents/plugins"), { recursive: true });
    await mkdir(manifest, { recursive: true });
    await mkdir(skill, { recursive: true });
    await writeFile(
      join(root, ".agents/plugins/marketplace.json"),
      JSON.stringify({
        name: marketplace,
        plugins: [{ name: "review", source: { source: "local", path: "./plugins/review" } }],
      }),
    );
    await writeFile(
      join(manifest, "plugin.json"),
      JSON.stringify({
        name: "review",
        description: marketplace,
        version: "1.0.0",
        skills: "./skills",
        interface: { displayName: "Review" },
      }),
    );
    await writeFile(
      join(skill, "SKILL.md"),
      `---\nname: sample\ndescription: Skill from ${marketplace}.\n---\nReview the fixture.\n`,
    );
    let source = root;
    if (marketplace === "fixture-second") {
      const git = (...args) => exec("git", args, { cwd: root, env });
      await git("init", "--quiet");
      await git("add", ".");
      await git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "--no-gpg-sign",
        "-m",
        "Marketplace fixture",
      );
      // 只在此测试子进程将 HTTPS Git 市场指向可控的本地仓库。
      source = "https://fixture.invalid/review-market.git";
      env.GIT_CONFIG_COUNT = "1";
      env.GIT_CONFIG_KEY_0 = `url.${pathToFileURL(root).href}.insteadOf`;
      env.GIT_CONFIG_VALUE_0 = source;
    }
    await invoke("marketplaceAdd", { source });
    await invoke("install", { pluginId: `review@${marketplace}` });
  }
  const first = "review@fixture-first";
  const second = "review@fixture-second";
  const states = async () => {
    const { entries } = await invoke("catalog", { source: "configured" });
    return Object.fromEntries(
      entries.map((entry) => [entry.pluginId, [entry.installed, entry.enabled]]),
    );
  };
  assert.deepEqual(await states(), { [first]: [true, true], [second]: [true, true] });
  assert.deepEqual((await pluginSkills()).sort(), [first, second]);
  const beforeOpeningInstalled = cliCommands.length;
  assert.equal(
    (await invoke("describe", { pluginId: first })).manifest.description,
    "fixture-first",
  );
  assert.equal(
    (await invoke("describe", { pluginId: second })).manifest.description,
    "fixture-second",
  );
  assert.equal(
    cliCommands.length,
    beforeOpeningInstalled,
    "Installed details must never wait for the marketplace",
  );
  await invoke("setEnabled", { pluginId: second, enabled: false });
  assert.deepEqual(nativeChanges, [
    {
      edits: [
        {
          keyPath: 'plugins."review@fixture-second".enabled',
          value: false,
          mergeStrategy: "replace",
        },
      ],
      reloadUserConfig: true,
    },
  ]);
  assert.deepEqual(await states(), { [first]: [true, true], [second]: [true, false] });
  assert.deepEqual(await pluginSkills(), [first]);
  await invoke("setEnabled", { pluginId: second, enabled: true });
  assert.deepEqual((await pluginSkills()).sort(), [first, second]);
  await invoke("uninstall", { pluginId: second });
  assert.deepEqual(await states(), { [first]: [true, true], [second]: [false, false] });
  assert.deepEqual(await pluginSkills(), [first]);
  await invoke("marketplaceRemove", { marketplace: "fixture-second" });
  assert.deepEqual(await states(), { [first]: [true, true] });
  assert(
    !nativePluginRequestSchema.safeParse({
      operation: "uninstall",
      hostId: host.id,
      cwd,
      pluginId: "--config",
    }).success,
  );
  assert(
    !nativePluginRequestSchema.safeParse({
      operation: "marketplaceAdd",
      hostId: host.id,
      cwd,
      source: "ext::fixture",
    }).success,
  );

  const skillPath = join(cwd, ".agents/skills/review/SKILL.md");
  await mkdir(join(cwd, ".agents/skills/review"), { recursive: true });
  await writeFile(
    skillPath,
    "---\nname: review\ndescription: Fixture review skill.\n---\nReview the fixture.\n",
  );
  const readSkill = async () => {
    const value = await rpc("skills/list", { cwds: [cwd], forceReload: true });
    return value.data[0].skills.find((item) => item.path === skillPath);
  };
  assert.equal((await readSkill()).enabled, true);
  await rpc("skills/config/write", { path: skillPath, enabled: false });
  assert.equal((await readSkill()).enabled, false);
  console.log(
    `Native plugin and skill management passed with ${initialize.userAgent.split(" ")[1]}`,
  );
} finally {
  if (appServer?.exitCode === null && appServer.signalCode === null) {
    const closed = once(appServer, "close");
    appServer.kill();
    await closed;
  }
  await rm(cwd, { recursive: true, force: true, maxRetries: 6 });
}
