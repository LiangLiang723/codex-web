import { useLayoutEffect, useRef, useState } from "react";
import { useBotAnatomy } from "./anatomyPlayer.js";
import { BotAvatar } from "./BotAvatar.js";
import { useBotActivity } from "./BotActivity.js";
import { BOT_SIZES, type ConversationPetProps } from "./contract.js";
import { usePetBehavior } from "./usePetBehavior.js";

export function ConversationPet({
  draft,
  working,
  activity,
  completion,
  conversationKey,
  interactionLabel,
  onComposerActivity,
  preferences,
}: ConversationPetProps) {
  const petRef = useRef<HTMLDivElement>(null);
  const flight = useRef<Animation | null>(null);
  const anatomy = useBotAnatomy();
  const hasAnatomy = Boolean(anatomy);
  const [autoMirrored, setAutoMirrored] = useState(false);
  const activityMotion = useBotActivity()?.motion;
  const { cue, interact } = usePetBehavior(
    petRef,
    anatomy,
    activity,
    completion,
    conversationKey,
    onComposerActivity,
    preferences,
  );

  useLayoutEffect(() => {
    const pet = petRef.current;
    // 子组件 layout effect 可能先于父容器的 ref 赋值。用已挂载桌宠的父节点定位。
    const pane = pet?.parentElement;
    if (!pane || !pet) return;

    const selector = draft
      ? '[data-codex-pet-anchor="draft"]'
      : '[data-codex-pet-anchor]:not([data-codex-pet-anchor="draft"])';
    const dockSelector = "[data-v4-composer-dock-content]";
    const layoutSelector = `${selector}, ${dockSelector}`;
    let slots: HTMLElement[] = [];
    let dock: HTMLElement | null = null;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    let statusPanel: HTMLElement | null = null;
    const place = () => {
      const anchor = slots.find((slot) => slot.offsetHeight > 0);
      if (!anchor) {
        pet.style.visibility = "hidden";
        return;
      }
      const placement = anchor.dataset.codexPetAnchor;
      const rect = anchor.getBoundingClientRect();
      const frame = pane.getBoundingClientRect();
      const nextStatusPanel =
        placement === "rail"
          ? pane.querySelector<HTMLElement>('[data-status-placement="inline"]')
          : null;
      if (nextStatusPanel !== statusPanel) {
        if (statusPanel) observer.unobserve(statusPanel);
        statusPanel = nextStatusPanel;
        if (statusPanel) observer.observe(statusPanel);
      }
      const topLimit = statusPanel ? statusPanel.getBoundingClientRect().bottom + 8 : frame.top;
      const size = Math.min(rect.width, rect.bottom - topLimit);
      if (!placement || size < 24 || rect.top >= frame.bottom) {
        pet.style.visibility = "hidden";
        return;
      }
      const left = rect.left - frame.left + (rect.width - size) / 2;
      const top = rect.bottom - frame.top - size;
      const chat = dock?.getBoundingClientRect() ?? frame;
      // 输入区中心落在桌宠左边缘外时镜像，中心位于桌宠下方时使用原始方向。
      setAutoMirrored((chat.left + chat.right) / 2 < frame.left + left);
      const previousPlacement = pet.dataset.petPlacement;
      const previousRect = pet.getBoundingClientRect();
      // 使用提交后的锚点确定终点，以当前动画帧为起点，连续切换时可立即反向。
      pet.style.left = `${left}px`;
      pet.style.top = `${top}px`;
      pet.style.width = `${size}px`;
      pet.style.visibility = "visible";
      pet.dataset.petPlacement = placement;

      if (previousPlacement && previousPlacement !== placement) {
        flight.current?.cancel();
        if (!reducedMotion.matches && previousRect.width > 0) {
          const x = previousRect.left - frame.left - left;
          const y = previousRect.top - frame.top - top;
          const scale = previousRect.width / size;
          flight.current = pet.animate(
            [{ transform: `translate(${x}px, ${y}px) scale(${scale})` }, { transform: "none" }],
            { duration: 600, easing: "cubic-bezier(0.22, 0.78, 0.28, 1)" },
          );
        }
      }
    };

    const cancelFlightForReducedMotion = () => {
      if (reducedMotion.matches) flight.current?.cancel();
    };
    const observer = new ResizeObserver(place);
    const observeAnchors = () => {
      const next = [...pane.querySelectorAll<HTMLElement>(selector)];
      const nextDock = pane.querySelector<HTMLElement>(dockSelector);
      if (
        nextDock === dock &&
        next.length === slots.length &&
        next.every((slot, index) => slot === slots[index])
      ) {
        return;
      }
      observer.disconnect();
      observer.observe(pane);
      slots = next;
      dock = nextDock;
      if (dock) observer.observe(dock);
      for (const slot of slots) {
        observer.observe(slot);
        if (slot.parentElement) observer.observe(slot.parentElement);
      }
      if (statusPanel) observer.observe(statusPanel);
      place();
    };
    // 手机切换时 composer 的元素可能被替换，定位必须随实际锚点更新。
    const anchorChanges = new MutationObserver((records) => {
      if (
        records.some(({ addedNodes, removedNodes }) =>
          [...addedNodes, ...removedNodes].some(
            (node) =>
              node instanceof HTMLElement &&
              (node.matches(layoutSelector) || node.querySelector(layoutSelector)),
          ),
        )
      )
        observeAnchors();
    });
    anchorChanges.observe(pane, { subtree: true, childList: true });
    pane.addEventListener("scroll", place, true);
    reducedMotion.addEventListener("change", cancelFlightForReducedMotion);
    observeAnchors();
    return () => {
      anchorChanges.disconnect();
      observer.disconnect();
      pane.removeEventListener("scroll", place, true);
      reducedMotion.removeEventListener("change", cancelFlightForReducedMotion);
    };
  }, [draft]);

  useLayoutEffect(() => () => flight.current?.cancel(), []);

  // 手机建议面板会跨过宠物锚点，桌宠应处于 z-20 的输入层下方。
  return (
    <div
      ref={petRef}
      data-codex-pet=""
      data-pet-reaction={cue?.reaction}
      aria-hidden={!hasAnatomy || !preferences.clickReactions || undefined}
      className="pointer-events-none invisible absolute z-10 aspect-square origin-top-left select-none"
    >
      <button
        type="button"
        aria-label={interactionLabel}
        className="size-full rounded-full focus-visible:outline-2 focus-visible:outline-ring enabled:pointer-events-auto"
        disabled={!hasAnatomy || !preferences.clickReactions || activity !== "idle"}
        onClick={() => interact.current?.()}
      >
        <BotAvatar
          className="size-full"
          mood={working ? "working" : "idle"}
          motion={cue?.motion ?? activityMotion ?? activity}
          animated
          followPointer={preferences.followPointer}
          mirrored={preferences.facing === "mirrored" || (preferences.facing === "auto" && autoMirrored)}
          shape={preferences.shape}
          scale={BOT_SIZES[preferences.size]}
        />
      </button>
    </div>
  );
}
