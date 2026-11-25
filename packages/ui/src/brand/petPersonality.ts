import type { BotPersonality } from "./contract.js";

export type PetEmotion = "settled" | "cheerful" | "wary";

interface PetGesture {
  motion: string;
  duration: number;
  personality?: BotPersonality;
  emotion?: PetEmotion;
}

export const petTiming = {
  curious: { idle: [7_500, 14_500], active: [14_000, 26_000], sleep: [57_000, 73_000] },
  playful: { idle: [5_000, 10_500], active: [10_500, 22_000], sleep: [66_000, 82_000] },
  calm: { idle: [12_500, 22_000], active: [23_000, 40_000], sleep: [50_000, 65_000] },
} as const;

export const petGestures = {
  idle: [
    { motion: "curious", duration: 4_900, personality: "curious" },
    { motion: "showcase", duration: 17_000, personality: "playful", emotion: "cheerful" },
    { motion: "turntable", duration: 10_500, personality: "curious" },
    { motion: "logo", duration: 8_600, personality: "playful" },
    { motion: "humming", duration: 4_200, personality: "calm", emotion: "cheerful" },
    { motion: "bored", duration: 4_000, personality: "calm" },
    { motion: "shy", duration: 3_400, personality: "calm", emotion: "wary" },
    { motion: "bouncing", duration: 3_800, personality: "playful", emotion: "cheerful" },
  ],
  active: [
    { motion: "curious", duration: 3_200, personality: "curious" },
    { motion: "humming", duration: 3_000, personality: "calm", emotion: "cheerful" },
    { motion: "suspicious", duration: 3_100, personality: "curious", emotion: "wary" },
    { motion: "confused", duration: 2_300, personality: "curious", emotion: "wary" },
    { motion: "proud", duration: 3_900, personality: "playful", emotion: "cheerful" },
    { motion: "approving", duration: 3_900, personality: "calm", emotion: "cheerful" },
    { motion: "shy", duration: 2_700, personality: "calm", emotion: "wary" },
  ],
  touch: [
    { motion: "curious", duration: 4_900, personality: "curious" },
    { motion: "playful", duration: 5_300, personality: "playful" },
    { motion: "happy", duration: 4_100, emotion: "cheerful" },
    { motion: "surprised", duration: 2_000, emotion: "wary" },
    { motion: "laughing", duration: 2_100, personality: "playful", emotion: "cheerful" },
    { motion: "excited", duration: 2_300, personality: "playful" },
    { motion: "shy", duration: 3_200, personality: "calm", emotion: "wary" },
    { motion: "proud", duration: 4_300, personality: "curious", emotion: "cheerful" },
    { motion: "approving", duration: 4_300, personality: "calm" },
    { motion: "celebrate", duration: 6_300, personality: "playful", emotion: "cheerful" },
  ],
} satisfies Record<string, readonly PetGesture[]>;

export function randomPetDelay([min, max]: readonly [number, number]) {
  return min + Math.random() * (max - min);
}

export function choosePetGesture(
  gestures: readonly PetGesture[],
  personality: BotPersonality,
  emotion: PetEmotion,
  previousMotion: string | undefined,
) {
  const candidates = gestures
    .filter(({ motion }) => motion !== previousMotion)
    .map((gesture) => ({
      gesture,
      weight:
        1 + (gesture.personality === personality ? 2 : 0) + (gesture.emotion === emotion ? 2 : 0),
    }));
  let draw = Math.random() * candidates.reduce((total, { weight }) => total + weight, 0);
  for (const { gesture, weight } of candidates) {
    draw -= weight;
    if (draw < 0) return gesture;
  }
  return gestures[0]!;
}
