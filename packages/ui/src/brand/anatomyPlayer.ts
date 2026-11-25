import { useEffect, useState } from "react";
import type { BotShape } from "./contract.js";

interface AnatomyPlayer {
  setState: (state: string) => void;
  poke: (motion: "bounce") => void;
  destroy: () => void;
}

interface AnatomyProfile {
  clips: string[];
  lifecycleGroups: { label: string; states: string[] }[];
  shapes: BotShape[];
  states: Record<string, { clips: string[]; face?: string; morph?: string; next?: string; holdSeconds?: number }>;
  createBot: (
    container: SVGElement,
    options: {
      size: number;
      state: string;
      compact: boolean;
      seed: string;
      follow: boolean;
      staticMode: boolean;
      reducedMotion: boolean;
      shape: BotShape;
      frontFacing: boolean;
      maxFps: number;
      firstPhase?: number;
      theme: { inkPaint: string; spotPaint: string; cutout: boolean };
    },
  ) => AnatomyPlayer;
}

let loaded: AnatomyProfile | null = null;
let pending: Promise<AnatomyProfile | null> | undefined;

function loadAnatomy() {
  const path = document.querySelector('meta[name="codex-bot-anatomy"]')?.getAttribute("content");
  if (!path?.match(/^assets\/codex-bot-anatomy-[a-f0-9]{12}\.mjs$/)) return;
  const url = new URL(path, window.location.origin + "/").href;
  pending ??= import(/* @vite-ignore */ url)
    .then((module: AnatomyProfile) => {
      loaded = module;
      return module;
    })
    .catch(() => null);
  return pending;
}

export function useBotAnatomy() {
  const [profile, setProfile] = useState(() => loaded);
  useEffect(() => {
    let active = true;
    void loadAnatomy()?.then((value) => {
      if (active) setProfile(value);
    });
    return () => {
      active = false;
    };
  }, []);
  return profile;
}
