export const warpSamples = 96;
const directions = Array.from({ length: warpSamples }, (_, index) => {
  const angle = index * 2 * Math.PI / warpSamples;
  return [Math.cos(angle), Math.sin(angle)];
});

function radii(points) {
  const edges = points.map(([x, y], index) => {
    const [endX, endY] = points[(index + 1) % points.length];
    return [x, y, endX - x, endY - y];
  });
  return directions.map(([dx, dy]) => {
    let radius = 0;
    for (const [x, y, ex, ey] of edges) {
      const determinant = dx * ey - dy * ex;
      if (Math.abs(determinant) < 1e-9) continue;
      const edgePosition = (x * dy - y * dx) / determinant;
      if (edgePosition >= 0 && edgePosition <= 1) {
        radius = Math.max(radius, (x * ey - y * ex) / determinant);
      }
    }
    return radius;
  });
}

export function outlineProfile(path, bounds) {
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  if (!path) return directions.map(([x, y]) => 0.5 / Math.hypot(x / width, y / height));
  const cx = bounds.minX + width / 2;
  const cy = bounds.minY + height / 2;
  // 造型是构建时从 Anatomy 的单环点列生成的 M/L/Z 路径。
  return radii(path.slice(1, -1).split("L").map((pair) => {
    const [x, y] = pair.split(" ").map(Number);
    return [x - cx, y - cy];
  }));
}

export function bodyWarp(profile, area, bounds) {
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const target = radii(area.outline.map(([x, y]) => [
    ((x - area.x) / area.width - 0.5) * width,
    ((y - area.y) / area.height - 0.5) * height,
  ]));
  return Float32Array.from(target, (radius, index) =>
    Math.max(1 / 16, Math.min(8, radius / Math.max(0.01, profile[index]))));
}
