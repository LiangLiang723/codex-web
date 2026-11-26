import { buildVolume } from "../upstream/open-bot-avatar/src/volume.ts";

// 上游球形网格以原点为球心；偏移 bounds 会把绒毛截成一边。
const sphere = { radius: 32, bounds: { minX: -32, minY: -32, maxX: 32, maxY: 32 } };
const front = { cY: 1, sY: 0, cP: 1, sP: 0, facing: 1 };
const tileSize = 160;

function cropMaterial(render, shape, color) {
  const { minX, minY, maxX, maxY } = shape.bounds;
  const width = maxX - minX;
  const height = maxY - minY;
  const density = tileSize / Math.max(width, height);
  const image = render(shape, front, { color, ink: "#151515", eyes: [] }, density);
  if (!image) return null;

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * density);
  canvas.height = Math.ceil(height * density);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  const ratio = image.size / (2 * image.radius);
  const x = image.x + (minX - image.cx + image.radius) * ratio;
  const y = image.y + (minY - image.cy + image.radius) * ratio;
  context.drawImage(image.canvas, x, y, width * ratio, height * ratio, 0, 0, canvas.width, canvas.height);
  return canvas;
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

export function createMaterialTextures(render) {
  const volumes = new Map();
  const cache = new Map();
  return (path, color) => {
    const key = JSON.stringify([path, color]);
    if (cache.has(key)) return cache.get(key);
    const round = cropMaterial(render, sphere, color);
    if (!round) return null;

    let outline = round;
    if (path) {
      if (!volumes.has(path)) {
        volumes.set(path, buildVolume({
          version: 1,
          id: "anatomy",
          name: "Anatomy",
          body: { path },
          eyes: { x: 50, y: 47, spacing: 14, scale: 1 },
        }));
      }
      outline = cropMaterial(render, volumes.get(path), color);
      if (!outline) return null;
    }
    const textures = { outline, surface: fillSurface(round) };
    if (cache.size >= 8) cache.delete(cache.keys().next().value);
    cache.set(key, textures);
    return textures;
  };
}
