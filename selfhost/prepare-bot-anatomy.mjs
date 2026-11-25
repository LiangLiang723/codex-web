import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

const revision = "debd41625da89b4c4fde43b3b1f0add6dc113c02";
const [referenceArg, outputArg] = process.argv.slice(2);
assert(referenceArg && outputArg, "Expected the Anatomy checkout and built Web directory.");

const reference = resolve(referenceArg);
const output = resolve(outputArg);
const git = promisify(execFile);
const { stdout: head } = await git("git", ["rev-parse", "HEAD"], { cwd: reference });
assert.equal(head.trim(), revision, "Use the reviewed GrokBot Animation Anatomy revision.");
const { stdout: status } = await git("git", ["status", "--porcelain", "--", "js/vendor"], {
  cwd: reference,
});
assert.equal(status, "", "Use the unchanged reference player and recipes.");

const vendor = join(reference, "js/vendor");
const playerSource = join(vendor, "grok-player.js");
const indexPath = join(output, "index.html");
const [recipesText, index] = await Promise.all([
  readFile(join(vendor, "grok-recipes.json"), "utf8"),
  readFile(indexPath, "utf8"),
]);
const recipes = JSON.parse(recipesText);
const clips = recipes.clips.map(({ name }) => name);
assert.equal(new Set(clips).size, 28);
assert.equal(Object.keys(recipes.states).length, 53);
assert(index.includes("<head>") && !index.includes('name="codex-bot-anatomy"'));

// 预览选项直接使用原始轨道。新增的是播放入口，原有状态与数据始终保持原样。
const previewStates = {
  all: { clips, next: "idle" },
  ...Object.fromEntries(clips.map((name) => [`clip:${name}`, { clips: [name] }])),
};
const bundle = await build({
  stdin: {
    resolveDir: vendor,
    contents: `
      import { createGrokBot } from "./grok-player.js";
      const data = ${JSON.stringify(recipes)};
      export const clips = ${JSON.stringify(clips)};
      export const lifecycleGroups = data.lifecycleGroups;
      Object.assign(data.states, ${JSON.stringify(previewStates)});
      export const createBot = (host, options = {}) => createGrokBot(host, { ...options, data });
    `,
  },
  format: "esm",
  platform: "browser",
  bundle: true,
  minify: true,
  write: false,
  banner: {
    js: `/* Local study preview · GrokBot Animation Anatomy · ArvinYin1 · ${revision} */`,
  },
});
const code = bundle.outputFiles[0].contents;
const filename = `codex-bot-anatomy-${createHash("sha256").update(code).digest("hex").slice(0, 12)}.mjs`;

const { makeConfig, createRuntime, createStateMachine, buildModel, makeMorphGenerators, makeTrail } =
  await import(pathToFileURL(playerSource).href);
const config = makeConfig(recipes);
const runtime = createRuntime(config);
createStateMachine(config, runtime, "idle", { isResting: true });
for (let frame = 0; frame < 60; frame++) runtime.advance(0.1);
const size = 64;
const model = buildModel(
  runtime.frame(), { cutout: true, ink: [0, 0, 0], spot: [0, 0, 0] }, size, config,
  makeMorphGenerators(config), makeTrail(config), () => {},
);
assert.equal(model.mode, "sphere");
assert(model.bodyD && !model.eyesD);
const favicon = (color) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"><path fill="${color}" fill-rule="evenodd" d="${model.bodyD}"/></svg>\n`;

await Promise.all([
  writeFile(join(output, "assets", filename), code),
  writeFile(join(output, "codex-bot-light.svg"), favicon("#161616")),
  writeFile(join(output, "codex-bot-dark.svg"), favicon("#ffffff")),
]);
await writeFile(indexPath, index.replace("<head>", `<head>\n    <meta name="codex-bot-anatomy" content="assets/${filename}">`));
console.log(`Anatomy preview: ${clips.length} clips, ${Object.keys(recipes.states).length} original states.`);
