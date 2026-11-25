import type { ComponentPropsWithoutRef } from "react";

export type BotMood = "idle" | "thinking" | "working";

export interface BotAvatarProps extends Omit<
  ComponentPropsWithoutRef<"svg">,
  "viewBox" | "children"
> {
  mood?: BotMood;
  animated?: boolean;
  followPointer?: boolean;
}

export interface ConversationPetProps {
  draft: boolean;
  working: boolean;
}
