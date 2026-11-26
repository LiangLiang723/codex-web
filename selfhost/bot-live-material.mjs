const svgNamespace = "http://www.w3.org/2000/svg";
const htmlNamespace = "http://www.w3.org/1999/xhtml";

function materialArea(model) {
  if (model.mode === "sphere") return model.materialArea?.();
  if (model.bodyPts.length === 0) return null;
  const xs = model.bodyPts.map(([x]) => x);
  const ys = model.bodyPts.map(([, y]) => y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y, eyes: model.eyesPts,
  };
}

export function createBotMaterialLayer(svg, parent, refresh) {
  const doc = svg.ownerDocument;
  const win = doc.defaultView;
  let outer;
  let canvas;
  let ctx;
  let size;
  let visibleWidth = 0;
  let observed;

  const observer = new win.ResizeObserver(() => {
    const width = observed.getBoundingClientRect().width;
    if (width === visibleWidth) return;
    visibleWidth = width;
    refresh();
  });

  function hide() {
    if (outer) {
      outer.style.display = "none";
      delete canvas.dataset.botLiveMaterial;
    }
    return false;
  }

  function draw(model, skin, deformed, eyePaths) {
    if (!skin || deformed || model.glow) return hide();
    if (!observed) {
      observed = svg.closest("[data-codex-bot]") ?? svg;
      visibleWidth = observed.getBoundingClientRect().width;
      observer.observe(observed);
    }
    // 状态行和图鉴小卡用共享纹理，缩小的桌宠也不用逐帧绘制体积。
    if (visibleWidth < 80 || doc.hidden) return hide();

    const area = materialArea(model);
    if (!area || area.width < 1 || area.height < 1) return hide();
    const pixels = Math.ceil(Math.min(320, visibleWidth * Math.min(win.devicePixelRatio, 2.5)));
    const scale = pixels / model.size;
    const density = Math.min(2.7, Math.max(area.width, area.height) * scale / 64);
    let frame;
    try {
      frame = skin.renderFrame(area, density);
    } catch {
      // 上下文丢失或体积不可用时，仍然由同一帧的 SVG 绘制共享材质。
    }
    if (!frame) return hide();

    if (!ctx) {
      outer = doc.createElementNS(svgNamespace, "foreignObject");
      canvas = outer.appendChild(doc.createElementNS(htmlNamespace, "canvas"));
      ctx = canvas.getContext("2d");
      if (!ctx) return hide();
      outer.style.pointerEvents = "none";
      canvas.style.cssText = "display:block;width:100%;height:100%";
      parent.append(outer);
    }
    if (size !== model.size) {
      size = model.size;
      outer.setAttribute("width", size);
      outer.setAttribute("height", size);
    }
    if (canvas.width !== pixels || canvas.height !== pixels) canvas.width = canvas.height = pixels;

    ctx.resetTransform();
    ctx.clearRect(0, 0, pixels, pixels);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    const { image, bounds } = frame;
    const sx = area.width / (bounds.maxX - bounds.minX);
    const sy = area.height / (bounds.maxY - bounds.minY);
    const dx = area.x + (image.cx - image.radius - bounds.minX) * sx;
    const dy = area.y + (image.cy - image.radius - bounds.minY) * sy;
    const drawFrame = () => ctx.drawImage(
      image.canvas, image.x, image.y, image.size, image.size,
      dx, dy, image.radius * 2 * sx, image.radius * 2 * sy,
    );
    drawFrame();

    // 使用 Anatomy 的弧线作为眼珠外形，同时保留原版着色器画出的镜面亮点。
    for (const d of eyePaths) {
      const path = new Path2D(d);
      ctx.save();
      ctx.clip(path);
      ctx.fillStyle = "#151515";
      ctx.fill(path);
      ctx.globalAlpha = 0.8;
      drawFrame();
      ctx.restore();
    }
    outer.style.display = "block";
    canvas.dataset.botLiveMaterial = skin.mode;
    return true;
  }

  return {
    draw,
    active: () => Boolean(canvas?.dataset.botLiveMaterial),
    dispose: () => observer.disconnect(),
  };
}
