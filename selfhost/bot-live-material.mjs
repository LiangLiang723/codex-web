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
    x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y,
    eyes: model.eyesPts, outline: model.bodyPts,
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
  let observer;

  function hide() {
    if (outer) {
      outer.style.display = "none";
      delete canvas.dataset.botLiveMaterial;
    }
    return false;
  }

  function draw(model, skin, eyePaths) {
    if (!skin) return hide();
    if (!observed) {
      observed = svg.closest("[data-codex-bot]") ?? svg;
      visibleWidth = observed.getBoundingClientRect().width;
      observer = new win.ResizeObserver(() => {
        const width = observed.getBoundingClientRect().width;
        if (width === visibleWidth) return;
        visibleWidth = width;
        refresh();
      });
      observer.observe(observed);
    }
    if (visibleWidth === 0 || doc.hidden) return hide();

    const area = materialArea(model);
    const pixels = Math.ceil(Math.min(320, visibleWidth * Math.min(win.devicePixelRatio, 2.5)));
    const scale = pixels / model.size;
    const hasBody = area && Math.min(area.width, area.height) * scale >= 0.5;
    let frame;
    if (hasBody) {
      try {
        const density = Math.min(2.7, Math.max(area.width, area.height) * scale / 64);
        frame = skin.renderFrame(area, eyePaths, model.materialView, model.materialMorph, density);
      } catch {
        // 上下文丢失时仍然可以用当前帧的 SVG 绘制身体和眼睛。
      }
      if (!frame) return hide();
    }

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
    if (frame) {
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      const { image, bounds } = frame;
      const sx = area.width / (bounds.maxX - bounds.minX);
      const sy = area.height / (bounds.maxY - bounds.minY);
      const dx = area.x + (image.cx - image.radius - bounds.minX) * sx;
      const dy = area.y + (image.cy - image.radius - bounds.minY) * sy;
      // 眼珠已由体积着色器完整绘制，第二次合成会在精确眼缘内留下暗边。
      ctx.drawImage(
        image.canvas, image.x, image.y, image.size, image.size,
        dx, dy, image.radius * 2 * sx, image.radius * 2 * sy,
      );
    }
    outer.style.display = "block";
    canvas.dataset.botLiveMaterial = skin.mode;
    return true;
  }

  return {
    draw,
    fps: () => canvas?.dataset.botLiveMaterial ? Math.min(30, 8 + visibleWidth / 5) : undefined,
    dispose: () => observer?.disconnect(),
  };
}
