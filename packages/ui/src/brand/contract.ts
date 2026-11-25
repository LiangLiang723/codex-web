import type { ComponentPropsWithoutRef, RefObject } from "react";

export type BotMood = "idle" | "thinking" | "working";
export type ConversationPetActivity =
  | BotMood
  | "sending"
  | "streaming"
  | "blocked"
  | "searching"
  | "reading"
  | "writing"
  | "running"
  | "spawning";

export interface BotAvatarProps extends Omit<
  ComponentPropsWithoutRef<"svg">,
  "viewBox" | "children"
> {
  mood?: BotMood;
  animated?: boolean;
  followPointer?: boolean;
  motion?: string;
  explicitPlayback?: boolean;
}

export interface ConversationPetProps {
  draft: boolean;
  working: boolean;
  activity: ConversationPetActivity;
  completion?: "finished" | "failed";
  conversationKey: string | null;
  interactionLabel: string;
  onComposerActivity: RefObject<(() => void) | null>;
}

export interface BotMotionPreviewProps {
  label: string;
  allClipsLabel: string;
  clipsLabel: string;
}
