import type { ComponentPropsWithoutRef, RefObject } from "react";

export type BotMood = "idle" | "thinking" | "working";
export const BOT_SHAPE_NAMES = [
  "sphere", "cloud", "square", "sparkle", "clover", "heartChubby", "starFlower", "teardrop",
  "tablet", "wedge", "house", "star6", "pebble", "bean", "egg", "squircle", "capsule", "cylinder",
  "hex", "gem", "crystal", "shield", "dome", "arch", "leaf",
] as const;
export type BotShape = (typeof BOT_SHAPE_NAMES)[number];
export const BOT_SIZES = { small: 0.8, regular: 1, large: 1.22 } as const;
export const BOT_PERSONALITIES = ["curious", "playful", "calm"] as const;
export type BotPersonality = (typeof BOT_PERSONALITIES)[number];
export const BOT_FACING_MODES = ["auto", "mirrored", "original"] as const;
export type BotFacingMode = (typeof BOT_FACING_MODES)[number];
export const BOT_MATERIALS = ["flat", "fluffy", "glass"] as const;
export type BotMaterial = (typeof BOT_MATERIALS)[number];

export interface ConversationPetPreferences {
  shape: BotShape;
  color: string | null;
  material: BotMaterial;
  size: keyof typeof BOT_SIZES;
  followPointer: boolean;
  idleMotion: boolean;
  clickReactions: boolean;
  personality: BotPersonality;
  spontaneous: boolean;
  facing: BotFacingMode;
  allActions: boolean;
}

export const DEFAULT_PET_PREFERENCES: ConversationPetPreferences = {
  shape: "sphere",
  color: null,
  material: "flat",
  size: "regular",
  followPointer: true,
  idleMotion: true,
  clickReactions: true,
  personality: "curious",
  spontaneous: true,
  facing: "auto",
  allActions: false,
};

export function normalizePetPreferences(value: unknown): ConversationPetPreferences {
  const saved = value && typeof value === "object"
    ? (value as Partial<ConversationPetPreferences>)
    : DEFAULT_PET_PREFERENCES;
  return {
    shape: saved.shape && BOT_SHAPE_NAMES.includes(saved.shape) ? saved.shape : "sphere",
    color: typeof saved.color === "string" && /^#[0-9a-f]{6}$/iu.test(saved.color)
      ? saved.color.toLowerCase()
      : null,
    material: saved.material === "fluffy" || saved.material === "glass" ? saved.material : "flat",
    size: saved.size && Object.hasOwn(BOT_SIZES, saved.size) ? saved.size : "regular",
    followPointer: saved.followPointer !== false,
    idleMotion: saved.idleMotion !== false,
    clickReactions: saved.clickReactions !== false,
    personality: saved.personality && BOT_PERSONALITIES.includes(saved.personality)
      ? saved.personality
      : DEFAULT_PET_PREFERENCES.personality,
    spontaneous: saved.spontaneous !== false,
    facing: saved.facing && BOT_FACING_MODES.includes(saved.facing)
      ? saved.facing
      : DEFAULT_PET_PREFERENCES.facing,
    allActions: saved.allActions === true,
  };
}

export type ConversationPetActivity =
  | BotMood
  | "sending"
  | "streaming"
  | "blocked"
  | "searching"
  | "reading"
  | "writing"
  | "running"
  | "spawning"
  | "coding"
  | "computing"
  | "controlling"
  | "loading"
  | "waiting";

export interface BotAvatarProps extends Omit<
  ComponentPropsWithoutRef<"svg">,
  "viewBox" | "children" | "color" | "scale"
> {
  mood?: BotMood;
  animated?: boolean;
  followPointer?: boolean;
  mirrored?: boolean;
  motion?: string;
  explicitPlayback?: boolean;
  shape?: BotShape;
  scale?: number;
  renderSize?: number;
  frontFacing?: boolean;
  seed?: string;
  pokeCount?: number;
}

export interface ConversationPetProps {
  draft: boolean;
  working: boolean;
  activity: ConversationPetActivity;
  completion?: "finished" | "failed";
  conversationKey: string | null;
  interactionLabel: string;
  onComposerActivity: RefObject<(() => void) | null>;
  preferences: ConversationPetPreferences;
}

export interface BotStudioProps {
  locale: string;
  preferences: ConversationPetPreferences;
  onChange: (preferences: Partial<ConversationPetPreferences>) => void;
  format: (key: string, values?: Record<string, string | number>) => string;
}
