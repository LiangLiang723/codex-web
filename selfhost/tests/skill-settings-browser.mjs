import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { build, preview } from "vite";

const exec = promisify(execFile);
const hostId = 23;
const otherHostId = 29;
const binary = process.env.SELFHOST_SKILL_CODEX_BIN ?? "codex";
const target = process.env.SELFHOST_SKILL_SETTINGS_TEST_URL;
const root = await realpath(await mkdtemp(join(tmpdir(), "selfhost-skill-settings-")));
const fixtureHome = join(root, "home");
const codexHome = join(fixtureHome, ".codex");
const cwd = join(root, "Review project (fixture)");
const secondCwd = join(root, "Second review project");
const projectId = "fixture-review-project";
const secondProjectId = "fixture-second-review-project";
const workspacePath = join(cwd, ".agents/skills/review/SKILL.md");
const secondWorkspacePath = join(secondCwd, ".agents/skills/review/SKILL.md");
const userPath = join(fixtureHome, ".agents/skills/review/SKILL.md");
const pluginMarket = "skills-fixture";
const marketPath = join(root, "marketplace");
const pluginPath = join(marketPath, "plugins/audit");
const pluginId = `audit@${pluginMarket}`;
const env = { ...process.env, HOME: fixtureHome, CODEX_HOME: codexHome };
for (const name of ["OPENAI_API_KEY", "CODEX_API_KEY", "CHATGPT_AUTH_TOKEN"]) delete env[name];

async function put(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

function skill(name, description, instructions) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${instructions}\n`;
}

async function verify(page, origin, rpc, nativePluginSkill, systemSkill) {
  const pageErrors = [];
  const writes = [];
  const messages = [];
  const hostProjects = [
    { id: secondProjectId, remotePath: secondCwd },
    ...Array.from({ length: 9 }, (_, index) => ({
      id: `fixture-extra-${index}`,
      remotePath: join(root, `Additional project ${index + 1}`),
    })),
    { id: projectId, remotePath: cwd },
  ].map((project) => ({ ...project, hostId, name: basename(project.remotePath) }));
  const otherProject = {
    id: "fixture-other-host-project",
    hostId: otherHostId,
    remotePath: join(root, "Other SSH host project"),
    name: "Other SSH host project",
  };
  const activate = (locator) =>
    page.viewportSize().width === 390 ? locator.tap() : locator.click();
  let listFailure = "connection";
  let deferredProjectRead;
  let failNextRead = false;
  let restoreAfterNextWrite = false;
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("selfhost.auth", "fixture");
    localStorage.setItem("zcode-locale-preference", "en-US");
  });
  await page.route(new URL("/api/**", origin).href, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postDataJSON();
    const value = (data) => route.fulfill({ json: { value: data } });
    if (url.pathname === "/api/selfhost/capability") {
      if (body.method === "skills/list") {
        assert.equal(body.hostId, hostId);
        if (listFailure === "connection") {
          return route.fulfill({
            status: 503,
            json: { message: "Fixture skill directory temporarily unavailable" },
          });
        }
        if (listFailure === "format") return value({ data: [] });
        if (body.params.cwds.includes(secondCwd) && deferredProjectRead) {
          await deferredProjectRead.promise;
        }
        const listing = await rpc(body.method, body.params);
        return value(listing);
      }
      if (body.method === "skills/config/write") {
        assert.equal(body.hostId, hostId);
        assert(
          [userPath, workspacePath, nativePluginSkill.path, systemSkill.path].includes(
            body.params.path,
          ),
        );
        writes.push(body.params);
        const saved = await rpc(body.method, body.params);
        if (restoreAfterNextWrite) {
          restoreAfterNextWrite = false;
          await rpc(body.method, { ...body.params, enabled: !body.params.enabled });
        }
        return value(saved);
      }
      return value({ data: [] });
    }
    if (url.pathname === "/api/selfhost/workspace" && body?.method === "readTextFile") {
      assert.equal(body.hostId, hostId);
      assert.equal(body.channel, "file");
      const [{ path, length }] = body.args;
      assert.equal(path, userPath);
      assert(length > 0 && length <= 256 * 1024);
      if (failNextRead) {
        failNextRead = false;
        return route.fulfill({
          status: 404,
          json: { message: "Fixture SKILL.md temporarily missing" },
        });
      }
      const contents = await readFile(path);
      return value({
        path,
        content: contents.toString("utf8"),
        offset: 0,
        bytesRead: contents.length,
        totalBytes: contents.length,
        truncated: false,
        isBinary: false,
      });
    }
    const queryHost = url.searchParams.get("hostId");
    const projects = [otherProject, ...hostProjects].filter(
      (project) => !queryHost || String(project.hostId) === queryHost,
    );
    const model = { id: "fixture", model: "fixture", displayName: "Fixture", isDefault: true };
    const routes = {
      "/api/hosts": [
        {
          id: hostId,
          name: "Fixture",
          sshHost: "fixture",
          port: 22,
          username: "qa",
          authMode: "agent",
        },
        {
          id: otherHostId,
          name: "Other fixture host",
          sshHost: "other-fixture",
          port: 22,
          username: "qa",
          authMode: "agent",
        },
      ],
      "/api/selfhost/projects": url.searchParams.has("organization")
        ? { items: projects, memberships: {} }
        : projects,
      "/api/projects": projects,
      "/api/threads": { data: [], nextCursor: null },
      "/api/models": { data: [model], nextCursor: null },
      "/api/selfhost/settings": { locale: "en-US" },
      "/api/selfhost/workspace": {
        value:
          body?.method === "resolveDirectory"
            ? body.args[0].path
            : { homedir: fixtureHome, platform: "linux" },
      },
      "/api/selfhost/organization": {
        value:
          body?.channel === "task-groups"
            ? { revision: 0, members: [], groups: [], order: [] }
            : [],
      },
    };
    return route.fulfill({ json: routes[url.pathname] ?? {} });
  });
  await page.routeWebSocket("**/api/realtime", (socket) =>
    socket.onMessage((raw) => {
      const call = JSON.parse(raw);
      messages.push(call);
      if (call.type === "auth.authenticate") socket.send(JSON.stringify({ type: "ready" }));
      else if (call.requestId)
        socket.send(
          JSON.stringify({
            type: "fixture.result",
            requestId: call.requestId,
            defaults: { model: "fixture" },
          }),
        );
    }),
  );
  const showTaskHome = async () => {
    const mobileChat = page.locator('[data-mobile-page="chat"]');
    if (await mobileChat.isVisible()) {
      await activate(mobileChat.getByRole("button", { name: "Back to task home", exact: true }));
    }
  };
  const skills = async () => {
    await showTaskHome();
    await page.getByTestId("task-settings-button").click();
    await page.locator('[data-settings-section-nav="skill"]').click();
  };
  const onPath = (path) => page.locator(`[data-skill-path="${path}"]`);
  const listing = () => rpc("skills/list", { cwds: [cwd], forceReload: true });
  const readEnabled = async (path) =>
    (await listing()).data[0].skills.find((entry) => entry.path === path)?.enabled;
  await page.goto(new URL("/?" + new URLSearchParams({ host: String(hostId), cwd }), origin).href, {
    waitUntil: "domcontentloaded",
  });
  await skills();
  const directoryError = page.getByTestId("native-skill-list-error");
  const emptyDirectory = page.getByText("No skills installed", { exact: true });
  await directoryError.getByText("Fixture skill directory temporarily unavailable").waitFor();
  assert.equal(await emptyDirectory.count(), 0);
  listFailure = null;
  await directoryError.getByRole("button", { name: "Retry", exact: true }).click();
  await onPath(userPath).getByText("User Review Display", { exact: true }).waitFor();
  await onPath(nativePluginSkill.path).waitFor();
  await page.getByRole("heading", { name: /^audit@skills-fixture/u }).waitFor();
  await page.getByRole("heading", { name: /^Codex built-in/u }).waitFor();
  assert.equal(await onPath(workspacePath).count(), 0);
  listFailure = "format";
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await directoryError.getByText(/no skill directory/u).waitFor();
  assert.equal(await emptyDirectory.count(), 0);
  assert.equal(await onPath(userPath).count(), 0);
  listFailure = null;
  await directoryError.getByRole("button", { name: "Retry", exact: true }).click();
  await onPath(userPath).waitFor();
  const scope = page.getByTestId("plugin-settings-scope-trigger");
  await scope.getByText("Current SSH host", { exact: true }).waitFor();
  const scopeMenu = page.getByRole("menu");
  const userScope = scopeMenu.getByTestId("plugin-settings-scope-user-option");
  const scopeProjects = scopeMenu.getByTestId(/^plugin-settings-scope-option-/u);
  const openScope = async () => {
    await activate(scope);
    await userScope.waitFor();
    assert.equal(await scopeMenu.locator('[data-scope-projects-trigger="true"]').count(), 0);
  };
  const chooseProjectScope = async (directory = cwd) => {
    await openScope();
    await activate(
      scopeMenu.getByRole("menuitemradio", { name: basename(directory), exact: true }),
    );
  };
  await openScope();
  await scopeProjects.first().waitFor();
  assert.equal(await userScope.getAttribute("aria-checked"), "true");
  assert.equal(await scopeProjects.count(), hostProjects.length);
  assert.equal(await scopeProjects.first().getAttribute("data-plugin-scope-key"), cwd);
  assert.equal(await scopeMenu.getByText(otherProject.name, { exact: true }).count(), 0);
  assert(
    await scopeProjects.first().evaluate((option) => {
      const list = option.parentElement;
      return list.scrollHeight > list.clientHeight && getComputedStyle(list).overflowY === "auto";
    }),
  );
  await scopeMenu.getByPlaceholder("Search projects", { exact: true }).fill(basename(secondCwd));
  const searchedProject = scopeMenu.getByRole("menuitemradio", {
    name: basename(secondCwd),
    exact: true,
  });
  await searchedProject.waitFor();
  assert.equal(await scopeProjects.count(), 1);
  await activate(searchedProject);
  await onPath(secondWorkspacePath).waitFor();
  assert.equal(await onPath(workspacePath).count(), 0);
  await chooseProjectScope();
  await onPath(workspacePath).waitFor();
  assert.equal(await onPath(userPath).count(), 0);

  const delayedRead = Promise.withResolvers();
  deferredProjectRead = delayedRead;
  const isSecondProjectRead = (request) => {
    if (!request.url().endsWith("/api/selfhost/capability")) return false;
    const body = request.postDataJSON();
    return body?.method === "skills/list" && body.params.cwds.includes(secondCwd);
  };
  try {
    await Promise.all([
      page.waitForRequest(isSecondProjectRead, { timeout: 45000 }),
      chooseProjectScope(secondCwd),
    ]);
    await chooseProjectScope();
    await onPath(workspacePath).waitFor();
    const response = page.waitForResponse((result) => isSecondProjectRead(result.request()));
    delayedRead.resolve();
    await (await response).finished();
    assert.equal(await onPath(secondWorkspacePath).count(), 0);
  } finally {
    delayedRead.resolve();
    deferredProjectRead = undefined;
  }
  await openScope();
  await activate(userScope);
  await onPath(userPath).waitFor();

  const search = page.getByPlaceholder(/Search skills/u).first();
  const userDetails = onPath(userPath).getByRole("button", { name: /^User Review Display/u });
  const useInList = onPath(userPath).getByTestId("native-skill-use-row");
  await search.fill("Codex built-in");
  await onPath(systemSkill.path).waitFor();
  assert.equal(await onPath(userPath).count(), 0);
  await search.fill("User Review Display");
  await onPath(userPath).waitFor();
  assert.equal(await onPath(nativePluginSkill.path).count(), 0);
  await search.clear();
  await userDetails.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("heading", { name: "User Review Display" }).waitFor();
  await dialog.getByText("Fixture dependency", { exact: true }).waitFor();
  failNextRead = true;
  await dialog.getByTestId("native-skill-preview").click();
  await dialog.getByRole("alert").waitFor();
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await dialog
    .getByTestId("native-skill-body")
    .getByText("Actual user review instructions.")
    .waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  const toggle = onPath(userPath).getByRole("switch");
  await toggle.click();
  await toggle.and(page.locator('[aria-checked="false"]')).waitFor();
  assert.equal(await useInList.count(), 0);
  await userDetails.click();
  assert.equal(await dialog.getByTestId("native-skill-use").count(), 0);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await readEnabled(userPath), false);
  assert.equal(await readEnabled(workspacePath), true);
  assert.equal(await readEnabled(nativePluginSkill.path), true);
  const config = await readFile(join(codexHome, "config.toml"), "utf8");
  assert(config.includes(`path = "${userPath}"`));
  assert.match(config, /enabled = false/u);

  await chooseProjectScope();
  const projectToggle = onPath(workspacePath).getByRole("switch");
  await projectToggle.click();
  await projectToggle.and(page.locator('[aria-checked="false"]')).waitFor();
  assert.equal(await readEnabled(workspacePath), false);
  assert.equal(await readEnabled(userPath), false);
  assert.equal(await readEnabled(nativePluginSkill.path), true);
  await projectToggle.click();
  await projectToggle.and(page.locator('[aria-checked="true"]')).waitFor();
  await page.reload({ waitUntil: "domcontentloaded" });
  await skills();
  await toggle.and(page.locator('[aria-checked="false"]')).waitFor();
  await toggle.click();
  await toggle.and(page.locator('[aria-checked="true"]')).waitFor();
  assert.deepEqual(writes, [
    { path: userPath, enabled: false },
    { path: workspacePath, enabled: false },
    { path: workspacePath, enabled: true },
    { path: userPath, enabled: true },
  ]);
  assert.equal(await readEnabled(userPath), true);
  restoreAfterNextWrite = true;
  await toggle.click();
  await page
    .getByRole("alert")
    .getByText(/effective skill setting/u)
    .waitFor();
  await toggle.and(page.locator('[aria-checked="true"]')).waitFor();
  assert.equal(await readEnabled(userPath), true);
  const systemToggle = onPath(systemSkill.path).getByRole("switch");
  await systemToggle.click();
  await systemToggle.and(page.locator('[aria-checked="false"]')).waitFor();
  assert.equal(await readEnabled(systemSkill.path), false);
  assert.equal(await page.getByTestId("native-skill-discover").count(), 0);
  await systemToggle.click();
  await systemToggle.and(page.locator('[aria-checked="true"]')).waitFor();
  assert.equal(await readEnabled(systemSkill.path), true);
  const pluginToggle = onPath(nativePluginSkill.path).getByRole("switch");
  await pluginToggle.click();
  await pluginToggle.and(page.locator('[aria-checked="false"]')).waitFor();
  assert.equal(await readEnabled(nativePluginSkill.path), false);
  assert.equal(await readEnabled(userPath), true);
  assert.equal(await readEnabled(workspacePath), true);
  await pluginToggle.click();
  await pluginToggle.and(page.locator('[aria-checked="true"]')).waitFor();
  assert.equal(await readEnabled(nativePluginSkill.path), true);
  const newName = `new-skill-${page.viewportSize().width}`;
  const discoveredPath = join(fixtureHome, ".agents", "skills", newName, "SKILL.md");
  await put(
    discoveredPath,
    skill(newName, "New fixture skill", "Instructions added after opening settings."),
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await onPath(discoveredPath).waitFor();

  const editor = page.locator('[contenteditable="true"]').first();
  await useInList.click();
  await editor.getByText("User Review Display", { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("cwd"), cwd);

  await skills();
  await userDetails.click();
  await dialog.getByTestId("native-skill-use").click();
  await editor.getByText("User Review Display", { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("cwd"), cwd);

  await skills();
  await page.getByTestId("native-skill-discover").click();
  await editor.getByText("Skill Installer", { exact: true }).waitFor();
  await editor.getByText(/Show the available skills/u).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("cwd"), cwd);
  await skills();
  await page.locator('[data-settings-create-action="settings.skills.create.open"]').click();
  await editor.getByText("Skill Creator", { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("cwd"), cwd);

  await showTaskHome();
  await activate(page.getByTestId("plugin-store-sidebar-open"));
  await activate(page.getByTestId("workspace-extensions-skills"));
  await chooseProjectScope(secondCwd);
  await onPath(secondWorkspacePath).getByTestId("native-skill-use-row").click();
  await page.waitForURL(
    (url) =>
      url.searchParams.get("host") === String(hostId) && url.searchParams.get("cwd") === secondCwd,
  );
  await editor
    .locator(`[data-mention-category="skills"][data-mention-id="skill:${secondWorkspacePath}"]`)
    .getByText("Second Project Review", { exact: true })
    .waitFor();
  const composerProject = page.getByTestId("composer-workspace-trigger");
  await composerProject.getByText(basename(secondCwd), { exact: true }).waitFor();
  await composerProject.click();
  await page
    .getByTestId("composer-project-menu")
    .locator(`[data-project-id="${secondProjectId}"][aria-checked="true"]`)
    .waitFor();
  await page.keyboard.press("Escape");
  assert.equal(messages.filter((message) => message.type === "thread.turn.start").length, 0);
  assert.deepEqual(pageErrors, []);
}

let appServer, previewServer, browser;
try {
  await mkdir(codexHome, { recursive: true });
  await put(workspacePath, skill("review", "Workspace review fixture", "Workspace instructions."));
  await put(
    secondWorkspacePath,
    skill("review", "Second work directory fixture", "Second workspace instructions."),
  );
  await put(
    join(dirname(secondWorkspacePath), "agents/openai.yaml"),
    "interface:\n  display_name: Second Project Review\n",
  );
  await put(userPath, skill("review", "User review fixture", "Actual user review instructions."));
  await put(
    join(dirname(userPath), "agents/openai.yaml"),
    "interface:\n  display_name: User Review Display\n  short_description: Short user review description\n" +
      "dependencies:\n  tools:\n    - type: mcp\n      value: fixture-server\n      description: Fixture dependency\n",
  );
  await put(
    join(marketPath, ".agents/plugins/marketplace.json"),
    JSON.stringify({
      name: pluginMarket,
      plugins: [{ name: "audit", source: { source: "local", path: "./plugins/audit" } }],
    }),
  );
  await put(
    join(pluginPath, ".codex-plugin/plugin.json"),
    JSON.stringify({ name: "audit", description: "Fixture plugin", version: "1.0.0" }),
  );
  await put(
    join(pluginPath, "skills/review/SKILL.md"),
    skill("review", "Plugin review fixture", "Plugin instructions."),
  );
  const run = (args) => exec(binary, args, { cwd, env, timeout: 30000 });
  const { stdout: binaryVersion } = await run(["--version"]);
  await run(["plugin", "marketplace", "add", "--json", "--", marketPath]);
  await run(["plugin", "add", "--json", "--", pluginId]);
  appServer = spawn(binary, ["app-server"], {
    cwd: fixtureHome,
    env,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const lines = createInterface({ input: appServer.stdout });
  let sequence = 0;
  const pending = new Map();
  lines.on("line", (line) => {
    const response = JSON.parse(line);
    const done = pending.get(response.id);
    if (!done) return;
    pending.delete(response.id);
    done(response);
  });
  const rpc = (method, params) => {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(Error(`App Server timeout: ${method}`)), 10000);
      pending.set(id, (response) => {
        clearTimeout(deadline);
        if (response.error) reject(Error(response.error.message));
        else resolve(response.result);
      });
      appServer.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  };
  const info = await rpc("initialize", {
    clientInfo: { name: "fixture", title: "Skill acceptance", version: "1" },
  });
  assert.equal(info.codexHome, codexHome);
  appServer.stdin.write('{"method":"initialized"}\n');
  const { data } = await rpc("skills/list", { cwds: [cwd], forceReload: true });
  const nativePluginSkill = data[0].skills.find((row) => row.pluginId === pluginId);
  const systemSkill = data[0].skills.find(
    (row) => row.scope === "system" && row.name === "skill-installer",
  );
  assert(nativePluginSkill);
  assert(systemSkill);
  assert(data[0].skills.some((row) => row.path === userPath && row.interface?.displayName));

  if (!target) {
    const web = resolve(import.meta.dirname, "../../packages/web");
    const config = {
      root: web,
      configFile: resolve(web, "vite.config.ts"),
      mode: "selfhost",
      logLevel: "error",
      build: { outDir: join(root, "dist") },
    };
    await build(config);
    previewServer = await preview({ ...config, preview: { host: "127.0.0.1", port: 0 } });
  }
  const origin = target ?? previewServer.resolvedUrls.local[0];
  browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const width of [1480, 390]) {
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      isMobile: width === 390,
      hasTouch: width === 390,
    });
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(45000);
    try {
      await verify(page, origin, rpc, nativePluginSkill, systemSkill);
      console.log(`PASS native skill settings ${width}px (${binaryVersion.trim()})`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser?.close();
  await previewServer?.close();
  if (appServer?.pid && appServer.exitCode === null && appServer.signalCode === null) {
    const exited = once(appServer, "exit");
    appServer.kill();
    await exited;
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}
