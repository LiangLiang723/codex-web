import type { AnatomyGeometry, AnatomyMaterial, TexturedMaterial } from "./anatomyPlayer.js";

interface Frame {
  geometry: AnatomyGeometry;
  deformed: boolean;
}

function withTransform(
  context: CanvasRenderingContext2D,
  node: SVGGraphicsElement,
  draw: () => void,
) {
  context.save();
  const transforms = node.transform.baseVal;
  for (let index = 0; index < transforms.numberOfItems; index++) {
    const { a, b, c, d, e, f } = transforms.getItem(index).matrix;
    context.transform(a, b, c, d, e, f);
  }
  context.globalAlpha *= Number(node.getAttribute("opacity") ?? 1);
  try {
    draw();
  } finally {
    context.restore();
  }
}

function paintPath(
  context: CanvasRenderingContext2D,
  node: SVGGeometryElement,
  texture: HTMLCanvasElement,
) {
  const path = new Path2D();
  if (node instanceof SVGCircleElement) {
    const radius = node.r.baseVal.value;
    if (radius <= 0) return;
    path.arc(node.cx.baseVal.value, node.cy.baseVal.value, radius, 0, 2 * Math.PI);
  } else {
    const data = node.getAttribute("d");
    if (!data) return;
    path.addPath(new Path2D(data));
  }

  const stroke = node.getAttribute("stroke");
  const isStroke = stroke !== null && stroke !== "none";
  const lineWidth = isStroke ? Number(node.getAttribute("stroke-width") ?? 1) : 0;
  const box = node.getBBox();
  if (box.width + lineWidth <= 0 || box.height + lineWidth <= 0) return;
  const paint = context.createPattern(texture, "no-repeat");
  if (!paint) return;
  paint.setTransform(new DOMMatrix([
    (box.width + lineWidth) / texture.width, 0, 0, (box.height + lineWidth) / texture.height,
    box.x - lineWidth / 2, box.y - lineWidth / 2,
  ]));

  withTransform(context, node, () => {
    if (isStroke) {
      context.lineWidth = lineWidth;
      context.lineCap = node.getAttribute("stroke-linecap") === "round" ? "round" : "butt";
      context.lineJoin = node.getAttribute("stroke-linejoin") === "round" ? "round" : "miter";
      const dash = node.getAttribute("stroke-dasharray");
      context.setLineDash(dash && dash !== "none" ? dash.trim().split(/[\s,]+/u).map(Number) : []);
      context.strokeStyle = paint;
      context.stroke(path);
    } else {
      context.fillStyle = paint;
      context.fill(path, node.getAttribute("fill-rule") === "evenodd" ? "evenodd" : "nonzero");
    }
  });
}

function beginFrame(context: CanvasRenderingContext2D, svg: SVGSVGElement, pixels: number) {
  if (context.canvas.width !== pixels) {
    context.canvas.width = pixels;
    context.canvas.height = pixels;
  }
  context.resetTransform();
  context.clearRect(0, 0, pixels, pixels);
  const { x, y, width } = svg.viewBox.baseVal;
  const scale = pixels / width;
  context.setTransform(scale, 0, 0, scale, -x * scale, -y * scale);
}

export function createMaterialPainter(
  svg: SVGSVGElement,
  canvas: HTMLCanvasElement,
  material: TexturedMaterial,
  palette: AnatomyMaterial,
  outline: string | null,
) {
  const output = canvas.getContext("2d");
  const headSurface = svg.ownerDocument.createElement("canvas").getContext("2d");
  if (!output || !headSurface) return null;

  let current: Frame | undefined;
  let pixels = 0;
  let color = "";
  let textures: ReturnType<AnatomyMaterial["getTextures"]> = null;

  function showFlat() {
    delete canvas.dataset.botMaterial;
    svg.removeAttribute("data-bot-material-painted");
  }

  function render() {
    if (!current || !pixels || !textures || !output || !headSurface) return;
    const { geometry, deformed } = current;
    const { surface, outline: bodyTexture } = textures;
    beginFrame(output, svg, pixels);
    withTransform(output, geometry.zoom, () => {
      withTransform(output, geometry.parts, () => {
        for (const part of geometry.parts.children) {
          if (part instanceof SVGGeometryElement) paintPath(output, part, surface);
        }
      });
    });

    // 单独合成身体，挖掉原版眼睛时不会一起擦掉背后的雷达或轨道。
    beginFrame(headSurface, svg, pixels);
    withTransform(headSurface, geometry.zoom, () => {
      withTransform(headSurface, geometry.head, () => {
        paintPath(headSurface, geometry.halo, surface);
        paintPath(headSurface, geometry.body, deformed ? surface : bodyTexture);
        const holes = geometry.body.hasAttribute("mask") && geometry.holes.getAttribute("d");
        if (holes) {
          headSurface.globalCompositeOperation = "destination-out";
          headSurface.globalAlpha = 1;
          headSurface.fillStyle = "#000";
          headSurface.fill(new Path2D(holes));
        }
      });
    });
    output.resetTransform();
    output.drawImage(headSurface.canvas, 0, 0);
    canvas.dataset.botMaterial = material;
    svg.setAttribute("data-bot-material-painted", "");
  }

  function refresh() {
    const next = getComputedStyle(svg).color;
    if (next !== color) {
      color = next;
      try {
        textures = palette.getTextures(outline, color);
      } catch {
        // 材质创建失败时保持原版 SVG 可见，原有播放器继续推进。
        textures = null;
      }
    }
    pixels = Math.min(288, Math.ceil(svg.clientWidth * window.devicePixelRatio));
    if (textures) render();
    else showFlat();
  }

  const resize = new ResizeObserver(refresh);
  resize.observe(svg);
  const theme = new MutationObserver(refresh);
  theme.observe(svg.ownerDocument.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style", "data-theme"],
  });
  theme.observe(svg, { attributes: true, attributeFilter: ["style", "viewBox"] });
  refresh();

  return {
    draw(geometry: AnatomyGeometry, deformed: boolean) {
      current = { geometry, deformed };
      render();
    },
    dispose() {
      resize.disconnect();
      theme.disconnect();
      showFlat();
    },
  };
}
