import { useEffect, useState } from "react";

interface AnatomyPlayer {
  setState: (state: string) => void;
  destroy: () => void;
}

interface AnatomyProfile {
  clips: string[];
  lifecycleGroups: { label: string; states: string[] }[];
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
