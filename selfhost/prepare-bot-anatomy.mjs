import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { prepareBotMaterials } from "./prepare-bot-materials.mjs";

const revision = "debd41625da89b4c4fde43b3b1f0add6dc113c02";
const [referenceArg, outputArg] = process.argv.slice(2);
if (referenceArg === "--print-revision" && !outputArg) {
  console.log(revision);
  process.exit(0);
}
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
const [recipesText, shapeText, originalPlayer, index] = await Promise.all([
  readFile(join(vendor, "grok-recipes.json"), "utf8"),
  readFile(join(vendor, "shape-data.json"), "utf8"),
  readFile(playerSource, "utf8"),
  readFile(indexPath, "utf8"),
]);
const materials = await prepareBotMaterials(output);
const recipes = JSON.parse(recipesText);
const clips = recipes.clips.map(({ name }) => name);
const clipDurations = new Map(recipes.clips.map(({ name, duration }) => [name, duration]));
const stateDurations = Object.fromEntries(
  Object.entries(recipes.states).map(([name, state]) => {
    const cycle = state.clips.reduce((total, clip) => total + clipDurations.get(clip), 0);
    const duration = Math.min(cycle, state.holdSeconds ?? cycle);
    assert(Number.isFinite(duration) && duration > 0, `Missing clip duration for ${name}`);
    return [name, Math.round(duration * 1_000)];
  }),
);
assert.equal(new Set(clips).size, 28);
assert.equal(Object.keys(recipes.states).length, 53);
assert(index.includes("<head>") && !index.includes('name="codex-bot-anatomy"'));

const shapes = JSON.parse(shapeText).shapes;
assert.deepEqual(
  new Set(shapes.map(({ engine }) => engine)),
  new Set(recipes.shapes.names),
);
const { makeConfig, createRuntime, createStateMachine, buildModel, makeMorphGenerators, makeTrail, lb, ir, Et } =
  await import(pathToFileURL(playerSource).href);

function sampleOutline(points) {
  return Array.from({ length: 360 }, (_, angle) => {
    const dx = Math.cos(angle * Math.PI / 180);
    const dy = Math.sin(angle * Math.PI / 180);
    let nearest = Infinity;
    for (const [index, [x, y]] of points.entries()) {
      const [nextX, nextY] = points[(index + 1) % points.length];
      const edgeX = nextX - x;
      const edgeY = nextY - y;
      const determinant = dx * edgeY - dy * edgeX;
      if (Math.abs(determinant) < 1e-9) continue;
      const alongEdge = (x * dy - y * dx) / determinant;
      const reach = (x * edgeY - y * edgeX) / determinant;
      if (reach > 0 && alongEdge >= 0 && alongEdge <= 1) nearest = Math.min(nearest, reach);
    }
    assert(Number.isFinite(nearest), "The reference shape must enclose its projection origin.");
    return Number(nearest.toFixed(4));
  });
}

const outlines = Object.fromEntries(
  shapes.filter(({ engine }) => engine !== "sphere").map(({ engine, path }) => {
    // 形状页记录的是单环点列。统一到相同画布尺寸，保留原来的横纵比例。
    assert.match(path, /^M[\d.\s,-]+Z$/u);
    const values = path.slice(1, -1).trim().split(/[\s,]+/u).map(Number);
    assert(values.length > 8 && values.length % 2 === 0 && values.every(Number.isFinite));
    const points = Array.from({ length: values.length / 2 }, (_, i) => values.slice(i * 2, i * 2 + 2));
    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);
    const bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const [left, top, right, bottom] = bounds;
    const centerX = (left + right) / 2;
    const centerY = (top + bottom) / 2;
    const radius = Math.max(right - left, bottom - top) / 2;
    const stride = Math.max(1, Math.floor(points.length / 128));
    const normalized = points
      .filter((_, i) => i % stride === 0)
      .map(([x, y]) => [
        Number(((x - centerX) / radius).toFixed(4)),
        Number(((y - centerY) / radius).toFixed(4)),
      ]);
    const { width, height, gap, shiftY } = recipes.shapes.eyeMetrics[engine];
    const halfGap = gap / 2;
    const pitch = -Math.asin(shiftY / Math.sqrt(1 - halfGap ** 2));
    const eyeBasis = recipes.eyes.basis.map(({ M, T, C }) => {
      const yaw = Math.asin(Math.sign(M[0]) * halfGap) - Math.asin(M[0]);
      const transform = ir(lb(pitch, yaw, 0));
      return { M: Et(transform, M), T: Et(transform, T), C: Et(transform, C) };
    });
    return [engine, {
      points: normalized,
      radii: sampleOutline(normalized),
      eyeBasis,
      eyeScale: [width / recipes.eyes.defaultWidth, height / 0.57],
    }];
  }),
);

// 部署包为选中的外形提供轮廓。圆形继续走参考引擎的原始弧线分支。
let player = originalPlayer;
function adapt(from, to) {
  assert.equal(player.split(from).length, 2, "Anatomy renderer integration point changed");
  player = player.replace(from, to);
}
adapt("function bT(e, t, G)", "function bT(e, t, G, outline)");
adapt(
  "body: [yM(s, [Math.abs(r) * i, Math.abs(o) * i], yT)]",
  "body: [outline ? outline.points.map(([x, y]) => [s[0] + x * Math.abs(r) * i, s[1] + y * Math.abs(o) * i]) : yM(s, [Math.abs(r) * i, Math.abs(o) * i], yT)]",
);
adapt("eyes: Ch(e, i, G).map(c => xT(c, kT).map(a))", "eyes: Ch(e, i, G, outline).map(c => xT(c, kT).map(a))");
adapt("function Ch(e, t, G)", "function Ch(e, t, G, outline)");
adapt("o = r[0] < 1 || r[1] < 1, s = [];", "o = !outline && (r[0] < 1 || r[1] < 1), s = [];");
adapt("ST(i, G.eyeBasis[a], G.eyeMirror[a], n, t)", "ST(i, outline?.eyeBasis[a] ?? G.eyeBasis[a], G.eyeMirror[a], n, t, outline?.eyeScale)");
adapt("function ST(e, t, n, r, o)", "function ST(e, t, n, r, o, [width = 1, height = 1] = [])");
adapt(
  "const w = y * e.lidY, S = f + l * m + d * w, b = h - d * m + l * w, v = Math.sqrt(S * S + b * b),",
  "const x = m * width, w = y * e.lidY * height, S = f + l * x + d * w, b = h - d * x + l * w, v = Math.sqrt(S * S + b * b),",
);
adapt("function buildModel(e, t, n, G, gE, tE, warnBody)", `
// 球面上的眼睛直接贴到非球体时会被窄轮廓切掉。沿射线压缩外缘，保留球面投影的侧转与表情。
function seatShapeEyes(eyes, body, center, radius, squash, outline, morphing) {
  if (eyes.length === 0 || radius === 0) return eyes;
  const [sx, sy] = squash.map(Math.abs);
  const morphEdges = morphing ? EM([body], center) : null;
  return eyes.map(eye => eye.map(([x, y]) => {
    const localX = (x - center[0]) / radius;
    const localY = (y - center[1]) / radius;
    const angle = us(center, x, y);
    const index = angle / TAU * outline.radii.length;
    const left = Math.floor(index) % outline.radii.length;
    const right = (left + 1) % outline.radii.length;
    const distance = Math.hypot(localX, localY);
    let edge = Math.min(outline.radii[left], outline.radii[right]);
    if (morphEdges && distance > 0) {
      const morphReach = PM(morphEdges, center, us([0, 0], localX * sx, localY * sy));
      const directionScale = Math.hypot(localX * sx, localY * sy) / distance;
      if (Number.isFinite(morphReach) && directionScale > 0) {
        edge = Math.min(edge, morphReach / (directionScale * radius));
      }
    }
    const safeEdge = Math.min(1, edge * 0.95);
    const scale = safeEdge / (safeEdge + (1 - safeEdge) * distance);
    return [center[0] + radius * scale * localX * sx, center[1] + radius * scale * localY * sy];
  }));
}

function buildModel(e, t, n, G, gE, tE, warnBody, outline)`);
adapt('s = e.morph == null && e.bodies.length === 1', 's = !outline && e.morph == null && e.bodies.length === 1');
adapt('c !== "sphere" && warnBody(c);', '!outline && c !== "sphere" && warnBody(c);');
adapt("shape: bT(e, n, G)", "shape: bT(e, n, G, outline)");
adapt('eyes: t.cutout ? "" : d(f),', 'eyes: t.cutout ? "" : d(f), surfaceEyes: () => f.map(eye => d([eye])),');
adapt("eyesD: i.eyes, glow: i.glow,", "eyesD: i.eyes, surfaceEyes: i.surfaceEyes, glow: i.glow,");
adapt(
  "l = mM([kE, ...i.map(({ shape: c }) => pM(c.body, c.center))]),",
  "l = outline && e.morph == null ? [] : mM([kE, ...i.map(({ shape: c }) => pM(c.body, c.center))]),",
);
adapt(
  "d = Th(i.map(({ shape: c, weight: u }) => ({ outline: gM(c.body, c.center, l), weight: u }))),",
  "d = l.length ? Th(i.map(({ shape: c, weight: u }) => ({ outline: gM(c.body, c.center, l), weight: u }))) : i[0].shape.body[0],",
);
adapt(
  `  return {
    mode: "morph", size: n, center: a,
    bodyPts: f == null || f.core.round === 0 ? d : SM(d, ME(f, a, u2, l, G), f.core.round),
    eyesPts: i[0]?.shape.eyes ?? [],`,
  `  const body = f == null || f.core.round === 0 ? d : SM(d, ME(f, a, u2, l, G), f.core.round);
  const eyes = i[0]?.shape.eyes ?? [];
  return {
    mode: "morph", size: n, center: a,
    bodyPts: body,
    eyesPts: outline ? seatShapeEyes(eyes, body, a, u2, e.squash, outline, !!e.morph) : eyes,`,
);
adapt(
  "renderer.render(buildModel(rt.frame(), theme, size, G, gE, trail, warnBody));",
  `const frame = rt.frame();
    // 造型选择用正脸缩略图，播放器的会话帧仍使用原始朝向。
    if (opts.frontFacing) frame.quat = [1, 0, 0, 0];
    lastModel = buildModel(frame, theme, size, G, gE, trail, warnBody, opts.outline);
    deformed = frame.morph != null;
    renderer.render(lastModel, skin, deformed);`,
);
adapt(
  "  const renderFrame = () => {",
  "  let lastModel, skin, deformed;\n  const renderFrame = () => {",
);
adapt(
  "  const warnedBodies = new Set;",
  `  const unbindAppearance = opts.bindAppearance?.(next => {
    skin = next;
    if (lastModel) renderer.render(lastModel, skin, deformed);
  });
  const warnedBodies = new Set;`,
);
adapt("      stopLoop();\n      io?.disconnect();", "      unbindAppearance?.();\n      stopLoop();\n      io?.disconnect();");
adapt(
  "  const render = model => {",
  `  const materialEyes = [];
  const drawMaterialEyes = (paths, eyePaint, clipId) => {
    // 眼窝只能画在原版可见眼睛里，保留转过侧面和合眼时的原始轮廓。
    for (let index = 0; index < Math.max(paths.length, materialEyes.length); index++) {
      const path = paths[index];
      const eye = materialEyes[index] ?? (materialEyes[index] = mk("path", { "data-bot-material-eye": "" }, headG));
      setA(eye, "d", path || null);
      setA(eye, "fill", path ? eyePaint : null);
      setA(eye, "clip-path", path && clipId ? clipId : null);
    }
  };
  const render = (model, skin, deformed) => {
    setA(svg, "data-bot-material", skin?.mode ?? null);
    setA(svg, "data-bot-color", skin?.color ?? null);`,
);
adapt('setA(haloP, "fill", `url(#${uid}-ghalo)`)', 'setA(haloP, "fill", skin?.surface ?? `url(#${uid}-ghalo)`)');
adapt('setA(bodyP, "fill", `url(#${uid}-gbody)`)', 'setA(bodyP, "fill", skin?.body ?? `url(#${uid}-gbody)`)');
adapt('} else setA(bodyP, "fill", model.inkPaint);', '} else setA(bodyP, "fill", skin?.body ?? model.inkPaint);');
adapt(
  '      setA(eyesP, "clip-path", null);\n      return;',
  '      setA(eyesP, "clip-path", null);\n      drawMaterialEyes(skin ? model.surfaceEyes?.() ?? [] : [], skin?.eye);\n      return;',
);
adapt(
  'const bodyD = da(model.bodyPts), eyesD = model.eyesPts.map(da).join("");\n    setA(bodyP, "d", bodyD); setA(bodyP, "fill", model.inkPaint);',
  `const bodyD = da(model.bodyPts), eyePaths = model.eyesPts.map(da), eyesD = eyePaths.join("");
    setA(bodyP, "d", bodyD); setA(bodyP, "fill", (deformed ? skin?.surface : skin?.body) ?? model.inkPaint);
    if (skin) setA(clipBody, "d", bodyD);
    drawMaterialEyes(skin ? eyePaths : [], skin?.eye, \`url(#\${uid}-body)\`);`,
);
adapt("const renderParts = (parts, inkPaint) => {", "const renderParts = (parts, inkPaint, strokePaint = inkPaint) => {");
adapt(
  'setA(n, "d", p.d); setA(n, "fill", "none"); setA(n, "stroke", inkPaint);',
  'setA(n, "d", p.d); setA(n, "fill", "none"); setA(n, "stroke", strokePaint);',
);
adapt(
  "renderParts(model.parts, model.inkPaint);",
  "renderParts(model.parts, skin?.surface ?? model.inkPaint, skin?.stroke ?? model.inkPaint);",
);
adapt(
  "createRuntime(G, { zoomMul: opts.zoomMul ?? 1, isGazeAlways:",
  "createRuntime(G, { body: opts.outline ? opts.shape : undefined, zoomMul: opts.zoomMul ?? 1, isGazeAlways:",
);
adapt(
  "rt.setGaze(ex(rect, { x: e.clientX, y: e.clientY }));",
  `// SVG 镜像后将指针换算回绘图坐标，桌宠仍朝实际指针看。
    const x = opts.isMirrored?.() ? rect.left + rect.right - e.clientX : e.clientX;
    rt.setGaze(ex(rect, { x, y: e.clientY }));`,
);

// 预览选项直接使用原始轨道。新增的是播放入口，原有状态与数据始终保持原样。
const previewStates = {
  all: { clips, next: "idle" },
  ...Object.fromEntries(clips.map((name) => [`clip:${name}`, { clips: [name] }])),
};
const config = makeConfig(recipes);
const runtime = createRuntime(config);
createStateMachine(config, runtime, "idle", { isResting: true });
for (let frame = 0; frame < 60; frame++) runtime.advance(0.1);
const faviconModel = (cutout) => buildModel(
  runtime.frame(),
  { cutout, ink: [0, 0, 0], spot: [0, 0, 0] }, 64, config,
  makeMorphGenerators(config), makeTrail(config), () => {},
);
const model = faviconModel(true);
assert.equal(model.mode, "sphere");
assert(model.bodyD && !model.eyesD);
const faviconEyes = faviconModel(false).eyesD.match(/M[^Z]+Z/gu);
assert.equal(faviconEyes?.length, 2);

const bundle = await build({
  stdin: {
    resolveDir: vendor,
    contents: `
      import { createGrokBot } from "./grok-player.js";
      import { installBotAppearance } from ${JSON.stringify(fileURLToPath(new URL("bot-appearance.mjs", import.meta.url)))};
      const data = ${JSON.stringify(recipes)};
      const outlines = ${JSON.stringify(outlines)};
      export const clips = ${JSON.stringify(clips)};
      export const lifecycleGroups = data.lifecycleGroups;
      export const shapes = data.shapes.names;
      export const states = { ...data.states };
      export const stateDurations = ${JSON.stringify(stateDurations)};
      export const materials = ${JSON.stringify(materials)};
      export const materialOutline = (shape) => {
        const points = outlines[shape]?.points;
        return points ? "M" + points.map(([x, y]) => [50 + x * 32, 50 + y * 32].join(" ")).join("L") + "Z" : null;
      };
      Object.assign(data.states, ${JSON.stringify(previewStates)});
      const subscribe = globalThis.document && installBotAppearance(document, materials, {
        body: ${JSON.stringify(model.bodyD)}, eyes: ${JSON.stringify(faviconEyes)},
      });
      export const createBot = (host, options = {}) => {
        const shape = options.shape ?? "sphere";
        // 小图标共用同一张纹理，精确轮廓仍由各自的 SVG 路径裁切。
        const useSurface = (options.size ?? 320) < 100 && shape !== "sphere";
        const outline = useSurface ? null : materialOutline(shape);
        return createGrokBot(host, {
          ...options, data, outline: outlines[shape],
          bindAppearance: receive => subscribe?.(outline, useSurface, receive),
        });
      };

      // HTML 启动壳早于 React 出现。独立加载同一模块，首帧就绪后再替换主题标志。
      const bootHost = globalThis.document?.querySelector(".zcode-boot-loading__anatomy");
      const root = bootHost?.closest("#root");
      if (bootHost && root) {
        const mark = bootHost.parentElement;
        const media = matchMedia("(prefers-reduced-motion: reduce)");
        let player;
        const mount = () => {
          player?.destroy();
          const next = createBot(bootHost, {
            size: 72,
            // 进度形变会遮住 Bot 的脸，启动等待使用原版的待机循环。
            state: "idle",
            reducedMotion: media.matches,
            maxFps: 30,
            seed: "startup",
            theme: { inkPaint: "currentColor", spotPaint: "currentColor", cutout: true },
          });
          player = next;
          void next.ready.then(() => {
            if (player === next && next.el && bootHost.isConnected) {
              mark.dataset.botMotion = next.state;
              mark.dataset.botEngine = "anatomy";
            }
          });
        };
        const observer = new MutationObserver(() => {
          if (bootHost.isConnected) return;
          player.destroy();
          media.removeEventListener("change", mount);
          observer.disconnect();
        });
        observer.observe(root, { childList: true });
        media.addEventListener("change", mount);
        mount();
      }
    `,
  },
  format: "esm",
  platform: "browser",
  bundle: true,
  minify: true,
  write: false,
  plugins: [{
    name: "anatomy-shape-outline",
    setup(bundle) {
      // esbuild 将此表达式传给 Go，省略 JavaScript 专有的 Unicode 标志。
      bundle.onLoad({ filter: /grok-player\.js$/ }, () => ({
        contents: player, loader: "js", resolveDir: vendor,
      }));
    },
  }],
  banner: {
    js: `/* Local study preview · GrokBot Animation Anatomy · ArvinYin1 · ${revision} */`,
  },
});
const code = bundle.outputFiles[0].contents;
const filename = `codex-bot-anatomy-${createHash("sha256").update(code).digest("hex").slice(0, 12)}.mjs`;

// 保留原版静帧的朝向和眼睛形状，标签图标只调整视口留白。
const favicon = (color) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 10 44 44"><path fill="${color}" fill-rule="evenodd" d="${model.bodyD}"/></svg>\n`;

await Promise.all([
  writeFile(join(output, "assets", filename), code),
  writeFile(join(output, "codex-bot-light.svg"), favicon("#161616")),
  writeFile(join(output, "codex-bot-dark.svg"), favicon("#ffffff")),
]);
await writeFile(
  indexPath,
  index
    .replace("<head>", `<head>\n    <meta name="codex-bot-anatomy" content="assets/${filename}">`)
    .replace("</body>", `  <script type="module" async src="/assets/${filename}"></script>\n  </body>`),
);
console.log(`Anatomy preview: ${clips.length} clips, ${Object.keys(recipes.states).length} states, ${shapes.length} shapes.`);
