import { buildVolume } from "../upstream/open-bot-avatar/src/volume.ts";
import { exposedHeight } from "../upstream/open-bot-avatar/src/dom/materials/socket.ts";
import { EYE_W, EYE_H, eyeCenters } from "../upstream/open-bot-avatar/src/validate.ts";
import { bodyWarp, outlineProfile } from "./bot-material-projection.mjs";

const front = { cY: 1, sY: 0, cP: 1, sP: 0, facing: 1 };
const tileSize = 160;
const eyeLayout = { x: 50, y: 47, spacing: 14, scale: 1 };
const lensSphere = "M18 50A32 32 0 1 0 82 50A32 32 0 1 0 18 50Z";

function toVolume(path) {
  return buildVolume({
    version: 1, id: "anatomy", name: "Anatomy", body: { path }, eyes: eyeLayout,
  });
}

function cropImage(image, left, top, width, height, density) {
  if (!image) return null;

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * density);
  canvas.height = Math.ceil(height * density);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  const ratio = image.size / (2 * image.radius);
  const x = image.x + (left - image.cx + image.radius) * ratio;
  const y = image.y + (top - image.cy + image.radius) * ratio;
  context.drawImage(image.canvas, x, y, width * ratio, height * ratio, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function cropMaterial(render, shape, color) {
  const { minX, minY, maxX, maxY } = shape.bounds;
  const width = maxX - minX;
  const height = maxY - minY;
  const density = tileSize / Math.max(width, height);
  const image = render(shape, front, { color, ink: "#151515", eyes: [] }, density);
  return cropImage(image, minX, minY, width, height, density);
}

function cropEye(render, volume, color) {
  const width = EYE_W * volume.eyeScale;
  const height = EYE_H * volume.eyeScale;
  const centers = eyeCenters(eyeLayout);
  const eyes = centers.map(([x, y]) => ({
    mark: { shape: "pill", x: x - width / 2, y: y - height / 2, width, height, radius: width / 2 },
    dx: 0,
    dy: 0,
  }));
  const density = 4.5;
  const image = render(volume, front, { color, ink: "#393939", eyes }, density);
  const [x, y] = centers[0];
  const exposed = height * exposedHeight(width, height);
  // 只取参考着色器的眼珠和内缘。眼睛的位置、外轮廓和眨眼都由 Anatomy 决定。
  return cropImage(image, x - width / 2, y - exposed / 2, width, exposed, density);
}

function fillSurface(sphereTexture) {
  const { width, height } = sphereTexture;
  const source = sphereTexture.getContext("2d").getImageData(0, 0, width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  const image = context.createImageData(width, height);

  // 让完整材质覆盖形变后的 SVG 区域。圆盘里的高光和绒毛沿投影拉到矩形，透明轮廓仍由原播放器决定。
  for (let y = 0; y < height; y++) {
    const v = (2 * y + 1) / height - 1;
    for (let x = 0; x < width; x++) {
      const u = (2 * x + 1) / width - 1;
      const sx = Math.floor(width * (0.5 + 0.49 * u * Math.sqrt(1 - v * v / 2)));
      const sy = Math.floor(height * (0.5 + 0.49 * v * Math.sqrt(1 - u * u / 2)));
      const from = (sy * width + sx) * 4;
      const to = (y * width + x) * 4;
      image.data.set(source.data.subarray(from, from + 4), to);
    }
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

function projectedEyes(bounds, area, paths) {
  const sx = (bounds.maxX - bounds.minX) / area.width;
  const sy = (bounds.maxY - bounds.minY) / area.height;
  const ox = bounds.minX - area.x * sx;
  const oy = bounds.minY - area.y * sy;
  const matrix = [sx, 0, 0, sy, ox, oy];
  return area.eyes.slice(0, 2).flatMap((points, index) => {
    if (points.length < 3 || !paths[index]) return [];
    const xs = points.map(([x]) => x * sx + ox);
    const ys = points.map(([, y]) => y * sy + oy);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const w = Math.max(...xs) - x;
    const h = Math.max(...ys) - y;
    if (w < 0.01 || h < 0.01) return [];
    // 点列只用来计算瓦片范围，绘制时使用 Anatomy 的原始弧线路径。
    const mark = { shape: "path", d: paths[index], anatomy: { matrix, box: { x, y, w, h } } };
    return [{ mark, dx: 0, dy: 0 }];
  });
}

export function createMaterialTextures(render) {
  const volumes = new Map();
  const profiles = new Map();
  const cache = new Map();
  let restEyes;
  function volumeFor(path) {
    if (!volumes.has(path)) {
      const volume = toVolume(path);
      if (path === lensSphere) restEyes = [...volume.eyeZ];
      volumes.set(path, volume);
    }
    return volumes.get(path);
  }

  function getTextures(path, color) {
    let palette = cache.get(color);
    if (!palette) {
      const sphere = volumeFor(lensSphere);
      const outline = cropMaterial(render, sphere, color);
      if (!outline) return null;
      sphere.eyeZ = [...restEyes];
      const eye = cropEye(render, sphere, color);
      if (!eye) return null;
      const round = { outline, surface: fillSurface(outline), eye };
      palette = { round, outlines: new Map() };
      if (cache.size >= 6) cache.delete(cache.keys().next().value);
      cache.set(color, palette);
    }
    if (!path) return palette.round;
    const { outlines } = palette;
    if (!outlines.has(path)) {
      const outline = cropMaterial(render, volumeFor(path), color);
      if (!outline) return palette.round;
      if (outlines.size >= 8) outlines.delete(outlines.keys().next().value);
      outlines.set(path, { ...palette.round, outline });
    }
    return outlines.get(path);
  }

  // 动画推进时按当前投影渲染身体和眼窝，完整保留着色器绘制的毛尖和半透明边缘。
  function renderFrame(path, color, area, paths, matrix, morphing, density) {
    const shape = volumeFor(path ?? lensSphere);
    let warp;
    if (morphing && area.outline) {
      if (!profiles.has(path)) profiles.set(path, outlineProfile(path, shape.bounds));
      warp = bodyWarp(profiles.get(path), area, shape.bounds);
    }
    const eyes = projectedEyes(shape.bounds, area, paths);
    const image = render(shape, front, { color, ink: "#151515", eyes, anatomy: { matrix, warp } }, density);
    return image ? { image, bounds: shape.bounds } : null;
  }

  return { getTextures, renderFrame };
}
