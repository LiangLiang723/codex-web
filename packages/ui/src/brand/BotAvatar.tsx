import { useEffect, useEffectEvent, useRef } from "react";
import { loadAnatomyMaterial, useBotAnatomy, type AnatomyGeometry } from "./anatomyPlayer.js";
import type { BotAvatarProps } from "./contract.js";
import { BOT_VIEW_BOX, createBotDrawing, staticBotPaths } from "./botDrawing.js";
import { createMaterialPainter } from "./materialPainter.js";

export function BotAvatar(props: BotAvatarProps) {
  const profile = useBotAnatomy();
  if (profile) return <AnatomyAvatar {...props} profile={profile} />;
  return <FallbackAvatar {...props} />;
}

function AnatomyAvatar({
  profile,
  mood = "idle",
  animated = false,
  followPointer = false,
  mirrored = false,
  motion = mood,
  explicitPlayback = false,
  shape = "sphere",
  color,
  material,
  scale = 1,
  renderSize = 300,
  frontFacing = false,
  seed = "hero",
  pokeCount,
  style,
  className = "",
  ...props
}: BotAvatarProps & { profile: NonNullable<ReturnType<typeof useBotAnatomy>> }) {
  const host = useRef<SVGGElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const surface = useRef<HTMLCanvasElement>(null);
  const player = useRef<ReturnType<typeof profile.createBot> | null>(null);
  const painter = useRef<ReturnType<typeof createMaterialPainter>>(null);
  const latestFrame = useRef<{ geometry: AnatomyGeometry; deformed: boolean } | null>(null);
  const startingMotion = useEffectEvent(() => motion);
  const materialTarget = material !== undefined;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const mountPlayer = () => {
      player.current?.destroy();
      player.current = profile.createBot(element, {
        size: renderSize,
        state: startingMotion(),
        compact: renderSize < 48,
        shape,
        seed,
        frontFacing,
        follow: followPointer,
        isMirrored: () => element.ownerSVGElement?.hasAttribute("data-bot-mirrored") === true,
        onFrame: materialTarget ? (geometry, deformed) => {
          latestFrame.current = { geometry, deformed };
          painter.current?.draw(geometry, deformed);
        } : undefined,
        staticMode: !animated,
        reducedMotion: reduced.matches && !explicitPlayback,
        maxFps: followPointer || explicitPlayback ? 60 : 30,
        firstPhase: explicitPlayback ? 0 : undefined,
        theme: { inkPaint: "currentColor", spotPaint: "currentColor", cutout: true },
      });
    };
    mountPlayer();
    reduced.addEventListener("change", mountPlayer);
    return () => {
      reduced.removeEventListener("change", mountPlayer);
      player.current?.destroy();
      player.current = null;
      latestFrame.current = null;
    };
  }, [animated, explicitPlayback, followPointer, frontFacing, materialTarget, profile, renderSize, seed, shape]);

  useEffect(() => {
    const drawing = svg.current;
    const canvas = surface.current;
    if (!drawing || !canvas || !material || material === "flat") return;
    let active = true;
    void loadAnatomyMaterial(profile, material).then((palette) => {
      if (!active || !palette) return;
      const next = createMaterialPainter(drawing, canvas, material, palette, profile.materialOutline?.(shape) ?? null);
      painter.current = next;
      const frame = latestFrame.current;
      if (frame) next?.draw(frame.geometry, frame.deformed);
    });
    return () => {
      active = false;
      painter.current?.dispose();
      painter.current = null;
    };
  }, [material, profile, shape]);

  useEffect(() => {
    player.current?.setState(motion);
  }, [motion]);
  useEffect(() => {
    if (pokeCount) player.current?.poke("bounce");
  }, [pokeCount]);

  const viewport = renderSize / scale;
  const inset = (renderSize - viewport) / 2;
  const orientation = mirrored ? { scale: "-1 1", transformOrigin: "center" } : undefined;
  const drawing = (
    <svg
      {...props}
      ref={svg}
      data-codex-bot={mood}
      data-bot-motion={motion}
      data-bot-engine="anatomy"
      data-bot-shape={shape}
      data-bot-mirrored={mirrored ? "" : undefined}
      viewBox={`${inset} ${inset} ${viewport} ${viewport}`}
      style={{
        ...style,
        ...(color ? { color } : {}),
        ...orientation,
      }}
      aria-hidden="true"
      focusable="false"
      className={materialTarget
        ? "absolute inset-0 block size-full data-[bot-material-painted]:opacity-0"
        : `block shrink-0 ${className}`}
    >
      <g ref={host} />
    </svg>
  );
  if (!materialTarget) return drawing;
  return (
    <span className={`relative block shrink-0 ${className}`}>
      {drawing}
      <canvas
        ref={surface}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 hidden size-full data-[bot-material]:block"
        style={orientation}
      />
    </span>
  );
}

function FallbackAvatar({
  mood = "idle",
  animated = false,
  followPointer = false,
  mirrored = false,
  motion: _motion,
  explicitPlayback: _explicitPlayback,
  shape: _shape,
  color,
  material: _material,
  scale = 1,
  renderSize: _renderSize,
  frontFacing: _frontFacing,
  seed: _seed,
  pokeCount: _pokeCount,
  style,
  className = "",
  ...props
}: BotAvatarProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const pathRef = useRef<SVGPathElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    const path = pathRef.current;
    if (!animated || !svg || !path) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const drawFrame = createBotDrawing(mood);
    let nextFrame = 0;
    let lastTime = 0;
    let visible = true;
    let targetX = 0;
    let targetY = 0;

    const resetGaze = () => {
      targetX = 0;
      targetY = 0;
    };
    const handlePointer = (event: PointerEvent) => {
      if (!visible || document.hidden || reducedMotion.matches || event.pointerType === "touch")
        return;
      const rect = svg.getBoundingClientRect();
      const dx = event.clientX - (rect.left + rect.width / 2);
      const dy = event.clientY - (rect.top + rect.height / 2);
      const reach = Math.max(rect.width * 2.8, 150);
      targetX = (dx / reach) * (svg.hasAttribute("data-bot-mirrored") ? -0.24 : 0.24);
      targetY = (-dy / reach) * 0.24;
      if (Math.hypot(dx, dy) > reach) resetGaze();
    };

    const tick = (time: number) => {
      // 同一绘制周期启动时，首个 rAF 时间戳可能早于 performance.now()。
      // 钳制负增量，避免 clip 播放头落到首个关键帧之前。
      const delta = Math.max(0, Math.min((time - lastTime) / 1000, 0.035));
      lastTime = time;
      const nextPath = drawFrame(delta, targetX, targetY);
      if (nextPath !== path.getAttribute("d")) path.setAttribute("d", nextPath);
      nextFrame = window.requestAnimationFrame(tick);
    };
    const sync = () => {
      window.cancelAnimationFrame(nextFrame);
      if (reducedMotion.matches) {
        path.setAttribute("d", staticBotPaths[mood]);
      } else if (visible && !document.hidden) {
        lastTime = performance.now();
        nextFrame = window.requestAnimationFrame(tick);
      }
    };

    const observer = new IntersectionObserver(([entry]) => {
      visible = Boolean(entry?.isIntersecting);
      sync();
    });
    observer.observe(svg);
    document.addEventListener("visibilitychange", sync);
    reducedMotion.addEventListener("change", sync);
    if (followPointer) {
      window.addEventListener("pointermove", handlePointer, { passive: true });
      document.documentElement.addEventListener("pointerleave", resetGaze);
    }
    sync();

    return () => {
      window.cancelAnimationFrame(nextFrame);
      observer.disconnect();
      document.removeEventListener("visibilitychange", sync);
      reducedMotion.removeEventListener("change", sync);
      window.removeEventListener("pointermove", handlePointer);
      document.documentElement.removeEventListener("pointerleave", resetGaze);
    };
  }, [animated, followPointer, mood]);

  return (
    <svg
      {...props}
      ref={svgRef}
      data-codex-bot={mood}
      data-bot-mirrored={mirrored ? "" : undefined}
      viewBox={BOT_VIEW_BOX}
      style={{
        ...style,
        ...(color ? { color } : {}),
        ...(scale !== 1 ? { scale } : {}),
        ...(mirrored ? { scale: `${-scale} ${scale}`, transformOrigin: "center" } : {}),
      }}
      aria-hidden="true"
      focusable="false"
      className={`block shrink-0 ${className}`}
    >
      <path ref={pathRef} d={staticBotPaths[mood]} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}
