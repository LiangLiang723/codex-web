import { useEffect, useRef } from "react";
import type { BotAvatarProps } from "./contract.js";
import { BOT_VIEW_BOX, createBotDrawing, staticBotPaths } from "./botDrawing.js";

export function BotAvatar({
  mood = "idle",
  animated = false,
  followPointer = false,
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
      targetX = (dx / reach) * 0.24;
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
      viewBox={BOT_VIEW_BOX}
      aria-hidden="true"
      focusable="false"
      className={`block shrink-0 ${className}`}
    >
      <path ref={pathRef} d={staticBotPaths[mood]} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}
