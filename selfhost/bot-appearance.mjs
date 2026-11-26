const ns = "http://www.w3.org/2000/svg";
const colorProperty = "--codex-bot-color";

export function installBotAppearance(document, materials, favicon) {
  const root = document.documentElement;
  const icon = document.querySelector("link[data-codex-bot-favicon]");
  const win = document.defaultView;
  const subscribers = new Set();
  const imports = new Map();
  const patterns = document.createElementNS(ns, "svg");
  patterns.setAttribute("width", "0");
  patterns.setAttribute("height", "0");
  patterns.setAttribute("aria-hidden", "true");
  patterns.style.position = "absolute";
  patterns.style.pointerEvents = "none";
  const defs = patterns.appendChild(document.createElementNS(ns, "defs"));
  let patternCount = 0;
  let byTexture = new WeakMap();
  let paints = new Map();
  let preference;
  let palette;
  let revision = 0;

  function pattern(texture) {
    let node = byTexture.get(texture);
    if (node) return node;
    node = document.createElementNS(ns, "pattern");
    node.id = `codex-bot-paint-${++patternCount}`;
    node.setAttribute("width", "1");
    node.setAttribute("height", "1");
    node.setAttribute("patternContentUnits", "objectBoundingBox");
    const image = node.appendChild(document.createElementNS(ns, "image"));
    image.setAttribute("href", texture.toDataURL());
    image.setAttribute("width", "1");
    image.setAttribute("height", "1");
    image.setAttribute("preserveAspectRatio", "none");
    if (!patterns.isConnected) document.body.append(patterns);
    defs.append(node);
    byTexture.set(texture, node);
    return node;
  }

  function paintFor(outline, useSurface) {
    if (!palette) return null;
    const key = useSurface ? "surface" : outline;
    if (paints.has(key)) return paints.get(key);
    let paint = null;
    const { getTextures, renderFrame } = palette;
    const { material, color } = preference;
    try {
      const textures = getTextures(outline, color);
      if (textures) {
        const body = pattern(useSurface ? textures.surface : textures.outline);
        const eye = pattern(textures.eye);
        const surface = pattern(textures.surface);
        const stroke = textures.surface.getContext("2d")
          .getImageData(textures.surface.width / 2, textures.surface.height / 2, 1, 1).data;
        paint = {
          mode: material,
          color,
          body: `url(#${body.id})`,
          surface: `url(#${surface.id})`,
          eye: `url(#${eye.id})`,
          stroke: `rgb(${stroke[0]} ${stroke[1]} ${stroke[2]})`,
          iconDefs: () => body.outerHTML + eye.outerHTML,
          renderFrame: (area, eyes, view, morphing, density) =>
            renderFrame(outline, color, area, eyes, view, useSurface || morphing, density),
        };
      }
    } catch {
      // 材质模块或 WebGL2 纹理不可用时，所有入口继续显示当前纯色。
    }
    paints.set(key, paint);
    return paint;
  }

  function updateFavicon() {
    if (!icon) return;
    const paint = paintFor(null, false);
    const { theme, customColor } = preference;
    if (!paint && !customColor) {
      icon.href = `/codex-bot-${theme}.svg?v=4`;
      return;
    }
    const lenses = paint ? favicon.eyes.map((d) => `<path fill="${paint.eye}" d="${d}"/>`).join("") : "";
    const svg = `<svg xmlns="${ns}" viewBox="10 10 44 44"><defs>${paint?.iconDefs() ?? ""}</defs><path fill="${paint?.body ?? customColor}" fill-rule="evenodd" d="${favicon.body}"/>${lenses}</svg>`;
    icon.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }

  function notify() {
    for (const update of subscribers) update();
    updateFavicon();
  }

  function refresh() {
    const custom = root.style.getPropertyValue(colorProperty);
    const customColor = /^#[0-9a-f]{6}$/iu.test(custom) ? custom.toLowerCase() : null;
    const theme = root.getAttribute("data-zcode-browser-theme-surface") ??
      (root.classList.contains("dark") ? "dark" : "light");
    const color = customColor ?? (theme === "dark" ? "#ffffff" : "#161616");
    const material = root.dataset.codexBotMaterial;
    if (preference?.theme === theme && preference.customColor === customColor &&
        preference.material === material) return;

    const samePaint = preference?.material === material && preference?.color === color;
    preference = { theme, material, color, customColor };
    if (samePaint) {
      updateFavicon();
      return;
    }
    const request = ++revision;
    palette = null;
    defs.replaceChildren();
    paints = new Map();
    byTexture = new WeakMap();
    notify();

    if (!Object.hasOwn(materials, material)) return;
    const path = materials[material];
    if (!imports.has(path)) {
      imports.set(path, import(new URL(path, win.location.origin + "/").href).catch(() => null));
    }
    void imports.get(path).then((loaded) => {
      // 慢请求返回时只应用当前选择。
      if (request !== revision || !loaded) return;
      palette = loaded;
      notify();
    });
  }

  new win.MutationObserver(refresh).observe(root, {
    attributes: true,
    attributeFilter: ["class", "style", "data-codex-bot-material", "data-zcode-browser-theme-surface"],
  });
  refresh();
  return (outline, useSurface, receive) => {
    const update = () => receive(paintFor(outline, useSurface));
    subscribers.add(update);
    update();
    return () => subscribers.delete(update);
  };
}
