import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { warpSamples } from "./bot-material-projection.mjs";

// Anatomy 已经投影了身体和可见眼形。保留上游的材质运算，换算它们使用的几何坐标。
const projection = `
uniform bool anatomy, hasWarp;
uniform float warpRadii[${warpSamples}];

float warpRadius(vec2 point) {
  if (!hasWarp || dot(point, point) < 1e-8) return 1.0;
  float slot = mod(atan(point.y, point.x) * (${warpSamples}.0 / 6.28318530718), ${warpSamples}.0);
  int index = int(slot);
  return mix(warpRadii[index], warpRadii[(index + 1) % ${warpSamples}], fract(slot));
}

vec2 facePoint(vec2 point) {
  return pivot.xy + point * warpRadius(point);
}
`;

const originalMatrix = "[view.cY, view.sY * view.sP, -view.sY * view.cP, 0, view.cP, view.sP, view.sY, -view.cY * view.sP, view.facing]";
const renderer = [
  ["  eyes: SurfaceEye[];", "  eyes: SurfaceEye[];\n  anatomy?: { matrix: number[]; warp?: Float32Array };"],
  ["view: uniform('view'),", "view: uniform('view'), anatomy: uniform('anatomy'), hasWarp: uniform('hasWarp'), warpRadii: uniform('warpRadii[0]'),"],
  ["    regions: new Float32Array(8),", "    anatomy: false,\n    regions: new Float32Array(8),"],
  ["region.h * exposedHeight(region.w, region.h)", "region.h * (mark.anatomy ? 1 : exposedHeight(region.w, region.h))"],
  ["      turn < SAME_VIEW", "      !look.anatomy && !shown.anatomy && turn < SAME_VIEW"],
  ["    shown.view = view;", "    shown.view = view;\n    shown.anatomy = Boolean(look.anatomy);"],
  [
    `    gl.uniformMatrix3fv(u.view, false, ${originalMatrix});`,
    `    gl.uniform1i(u.anatomy, Number(shown.anatomy));
    gl.uniform1i(u.hasWarp, Number(Boolean(look.anatomy?.warp)));
    if (look.anatomy?.warp) gl.uniform1fv(u.warpRadii, look.anatomy.warp);
    gl.uniformMatrix3fv(u.view, false, look.anatomy?.matrix ?? ${originalMatrix});`,
  ],
];

const eye = [
  [
    "export type EyeMark =\n",
    "export type EyeMark = (\n",
  ],
  [
    "  | { shape: 'path'; d: string };",
    "  | { shape: 'path'; d: string }\n) & { anatomy?: { matrix: Matrix; box: { x: number; y: number; w: number; h: number } } };",
  ],
];

const socket = [
  ["const { x, y, w, h } = eyeBox(mark);", "const { x, y, w, h } = mark.shape === 'path' && mark.anatomy ? mark.anatomy.box : eyeBox(mark);"],
  [
    "  return mark.shape === 'arc' ?",
    "  if (mark.shape === 'path' && mark.anatomy) return `anatomy|${mark.anatomy.matrix.join(',')}|${mark.d}`;\n  return mark.shape === 'arc' ?",
  ],
  ["  const exposure = exposedHeight(w, h);", "  const anatomy = mark.shape === 'path' ? mark.anatomy : undefined;\n  const exposure = anatomy ? 1 : exposedHeight(w, h);"],
  ["  paintEye(ctx, mark);", "  if (anatomy) ctx.transform(...anatomy.matrix);\n  paintEye(ctx, mark);"],
  ["const cap = Math.min(1, w / h);", "const cap = anatomy ? 1 : Math.min(1, w / h);"],
  ["const taper = h > w ?", "const taper = !anatomy && h > w ?"],
];

// 投影后两个眼窝可能靠得很近。按较近的眼缘着色，避免第一个眼窝的留白盖住另一只眼。
const overlap = [
  ["  local = vec3(0.);", "  local = vec3(0.);\n  float nearest = FAR;"],
  ["      uv = sampleUV;", "      if (anatomy && d >= nearest) continue;\n      nearest = d;\n      uv = sampleUV;"],
  ["  return FAR;\n}", "  return nearest;\n}"],
];

const fluffy = [
  ...overlap,
  ["uniform vec2 eyeSize[2];", `uniform vec2 eyeSize[2];\n${projection}`],
  ["uniform mat3 view;\nuniform int pass;", "uniform mat3 view;\nuniform vec3 pivot;\nuniform int pass;"],
  ["if (normal.z < .03 || p.z < -.05)", "if ((!anatomy && normal.z < .03) || p.z < -.05)"],
  ["vec2 delta = p.xy - e.xy;", "vec2 delta = (anatomy ? facePoint(p.xy - pivot.xy) : p.xy) - e.xy;"],
  ["p.z <= e.w &&", "(anatomy || p.z <= e.w) &&"],
  ["      return d * mix(1.5, 1., local.z);", "      if (!anatomy) return d * mix(1.5, 1., local.z);"],
  ["  float loft = mix(.07, 1., smoothstep(.75, 3.7, d));", "  float loft = mix(.07, 1., anatomy ? smoothstep(-.2, .9, d) : smoothstep(.75, 3.7, d));"],
  [
    "    vec3 screenDir = view * (direction + .06 * comb);",
    "    mat3 geometry = anatomy ? mat3(1.) : view;\n    vec3 screenDir = geometry * (direction + .06 * comb);",
  ],
  ["p += transpose(view) * vec3(widthDir", "p += transpose(geometry) * vec3(widthDir"],
  ["  vec3 projected = view * (p - pivot);", `  vec3 projected = anatomy ? p - pivot : view * (p - pivot);
  if (hasWarp) projected.xy *= warpRadius(projected.xy);`],
  [
    "    lipLight = tipLight * gathered * lip * mix(.40, 1., local.z);",
    `    lipLight = tipLight * gathered * lip * mix(.40, 1., local.z);
    if (anatomy) {
      float edge = 1. - smoothstep(-.15, .4, d);
      crease *= edge;
      contact *= edge;
      pileRelief *= edge;
      lipLight *= edge;
    }`,
  ],
];

const glass = [
  ...overlap,
  ["uniform vec2 eyeSize[2];", `uniform vec2 eyeSize[2];\n${projection}`],
  ["if (normal.z < 0.05 || p.z < 0.0)", "if ((!anatomy && normal.z < 0.05) || p.z < 0.0)"],
  ["vec2 delta = p.xy - e.xy;", "vec2 delta = (anatomy ? facePoint(p.xy - pivot.xy) : p.xy) - e.xy;"],
  ["p.z <= e.w + 2.5 &&", "(anatomy || p.z <= e.w + 2.5) &&"],
  ["      return d;", "      if (!anatomy) return d;"],
  ["  mat3 invView = transpose(view);", "  mat3 invView = anatomy ? mat3(1.0) : transpose(view);"],
  ["  vec3 roS = vec3(screenXY, radius * 1.25);", "  vec3 roS = vec3(screenXY / warpRadius(screenXY), radius * 1.25);"],
  ["vec3(screenXY, 0.0);", "vec3(screenXY / warpRadius(screenXY), 0.0);"],
];

const adapters = new Map([
  ["render.ts", eye],
  ["dom/materials/socket.ts", socket],
  ["dom/fluffy/renderer.ts", [
    ...renderer,
    // 共享画布只增不减。清除视口外的旧像素，避免缩放时的插值捎带上一帧的边缘。
    ["    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);",
      "    gl.disable(gl.SCISSOR_TEST);\n    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);\n    gl.enable(gl.SCISSOR_TEST);"],
  ]],
  ["dom/fluffy/shaders.ts", fluffy],
  ["dom/glass/renderer.ts", [
    ...renderer,
    // 同一体积网格在尺寸变化时继续使用，屏幕分辨率单独调整。
    ["shapeOf(shape, scale >= 1.4)", "shapeOf(shape, Boolean(look.anatomy) || scale >= 1.4)"],
    ["    gl.clear(gl.COLOR_BUFFER_BIT);",
      "    gl.disable(gl.SCISSOR_TEST);\n    gl.clear(gl.COLOR_BUFFER_BIT);\n    gl.enable(gl.SCISSOR_TEST);"],
  ]],
  ["dom/glass/shaders.ts", glass],
]);

export const anatomyProjection = {
  name: "codex-bot-anatomy-projection",
  setup(build) {
    build.onLoad({ filter: /open-bot-avatar\/src\/.*\.ts$/ }, async ({ path }) => {
      const id = path.split("/open-bot-avatar/src/").at(-1);
      const edits = adapters.get(id);
      if (!edits) return undefined;
      let contents = await readFile(path, "utf8");
      for (const [from, to] of edits) {
        assert(contents.includes(from), `Missing Open Bot Avatar adapter anchor in ${id}: ${from}`);
        contents = contents.replace(from, to);
      }
      return { contents, loader: "ts" };
    });
  },
};
