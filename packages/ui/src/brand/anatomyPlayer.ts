import { useEffect, useState } from "react";
import type { BotMaterial, BotShape } from "./contract.js";

export interface AnatomyGeometry {
  svg: SVGSVGElement;
  zoom: SVGGElement;
  parts: SVGGElement;
  head: SVGGElement;
  body: SVGPathElement;
  holes: SVGPathElement;
  halo: SVGPathElement;
}

export type TexturedMaterial = Exclude<BotMaterial, "flat">;
interface MaterialTextures {
  outline: HTMLCanvasElement;
  surface: HTMLCanvasElement;
}
export interface AnatomyMaterial {
  getTextures: (path: string | null, color: string) => MaterialTextures | null;
}

interface AnatomyPlayer {
  setState: (state: string) => void;
  poke: (motion: "bounce") => void;
  destroy: () => void;
}

export interface AnatomyProfile {
  clips: string[];
  lifecycleGroups: { label: string; states: string[] }[];
  shapes: BotShape[];
  states: Record<string, { clips: string[]; face?: string; morph?: string; next?: string; holdSeconds?: number }>;
  stateDurations?: Readonly<Record<string, number>>;
  materials?: Readonly<Record<TexturedMaterial, string>>;
  materialOutline?: (shape: BotShape) => string | null;
  createBot: (
    container: SVGElement,
    options: {
      size: number;
      state: string;
      compact: boolean;
      seed: string;
      follow: boolean;
      isMirrored?: () => boolean;
      onFrame?: (geometry: AnatomyGeometry, deformed: boolean) => void;
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

export async function loadAnatomyMaterial(profile: AnatomyProfile, material: TexturedMaterial) {
  const path = profile.materials?.[material];
  if (!path || !/^assets\/codex-bot-material-(fluffy|glass)-[a-f0-9]{12}\.mjs$/u.test(path)) return null;
  const url = new URL(path, window.location.origin + "/").href;
  return import(/* @vite-ignore */ url).catch(() => null) as Promise<AnatomyMaterial | null>;
}

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
