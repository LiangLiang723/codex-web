import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { ConversationPetActivity, ConversationPetProps } from "./contract.js";

const idleTimeline = [
  { at: 0, motion: "idle" },
  { at: 12_000, motion: "showcase" },
  { at: 31_000, motion: "idle" },
  { at: 36_000, motion: "turntable" },
  { at: 47_000, motion: "idle" },
  { at: 52_000, motion: "logo" },
  { at: 62_000, motion: "drowsy" },
  { at: 68_000, motion: "sleeping" },
] as const;

const reactions = [
  { motion: "curious", duration: 4_900 },
  { motion: "playful", duration: 5_300 },
  { motion: "happy", duration: 4_100 },
  { motion: "surprised", duration: 2_000 },
  { motion: "laughing", duration: 2_100 },
  { motion: "excited", duration: 2_300 },
  { motion: "shy", duration: 3_200 },
  { motion: "proud", duration: 4_300 },
  { motion: "approving", duration: 2_300 },
  { motion: "celebrate", duration: 6_300 },
] as const;

type PetCue =
  | ConversationPetActivity
  | "finished"
  | "failed"
  | "alerting"
  | "waking"
  | "listening"
  | (typeof idleTimeline)[number]["motion"]
  | (typeof reactions)[number]["motion"];

export function usePetBehavior(
  pet: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  activity: ConversationPetProps["activity"],
  completion: ConversationPetProps["completion"],
  conversationKey: ConversationPetProps["conversationKey"],
  onComposerActivity: ConversationPetProps["onComposerActivity"],
  { idleMotion, clickReactions }: ConversationPetProps["preferences"],
) {
  const [displayed, setDisplayed] = useState<PetCue>("idle");
  const last = useRef({ activity, conversationKey, activeSince: 0 });
  const interact = useRef<(() => void) | null>(null);
  const reactionIndex = useRef(0);

  useEffect(() => {
    const previous = last.current;
    const sameConversation = previous.conversationKey === conversationKey;
    const now = performance.now();
    last.current = {
      activity,
      conversationKey,
      activeSince: activity === "idle" ? 0 : (sameConversation && previous.activeSince) || now,
    };
    const pane = pet.current?.parentElement;
    if (!enabled || !pane || activity !== "idle") {
      setDisplayed("idle");
      return;
    }
    const completedHere =
      conversationKey !== null &&
      conversationKey === previous.conversationKey &&
      previous.activity !== "idle" &&
      completion;
    let idleSince = performance.now();
    let cue: PetCue = "idle";
    let timer = 0;
    let cuePlaying = false;
    const show = (motion: PetCue) => {
      cue = motion;
      setDisplayed(motion);
    };
    const rest = () => {
      window.clearTimeout(timer);
      if (document.hidden) return;
      if (!idleMotion) {
        show("idle");
        return;
      }
      const elapsed = performance.now() - idleSince;
      show(idleTimeline.findLast(({ at }) => at <= elapsed)?.motion ?? "idle");
      const upcoming = idleTimeline.find(({ at }) => at > elapsed);
      if (upcoming) timer = window.setTimeout(rest, upcoming.at - elapsed);
    };
    const restartIdle = () => {
      cuePlaying = false;
      idleSince = performance.now();
      rest();
    };
    const play = (motion: PetCue, duration: number, next = restartIdle) => {
      window.clearTimeout(timer);
      cuePlaying = true;
      show(motion);
      timer = window.setTimeout(next, duration);
    };
    const presence = () => {
      if (cuePlaying || performance.now() - idleSince < 300) return;
      if (cue === "sleeping" || cue === "drowsy") play("waking", 1700);
      else restartIdle();
    };
    onComposerActivity.current = () => play("listening", 1600);
    const visibility = () => {
      if (document.hidden) window.clearTimeout(timer);
      else restartIdle();
    };
    interact.current = clickReactions ? () => {
      if (cue === "sleeping" || cue === "drowsy") {
        play("waking", 1700);
        return;
      }
      const reaction = reactions[reactionIndex.current % reactions.length]!;
      reactionIndex.current++;
      play(reaction.motion, reaction.duration);
    } : null;
    if (completedHere === "finished") {
      const longTurn = previous.activeSince > 0 && now - previous.activeSince >= 20_000;
      play("finished", 6200, longTurn ? () => play("celebrate", 6300) : restartIdle);
    } else if (completedHere === "failed") {
      play("failed", 3500, () => play("alerting", 1700));
    } else {
      rest();
    }

    pane.addEventListener("pointermove", presence, { passive: true });
    pane.addEventListener("focusin", presence);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      interact.current = null;
      onComposerActivity.current = null;
      window.clearTimeout(timer);
      pane.removeEventListener("pointermove", presence);
      pane.removeEventListener("focusin", presence);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [activity, clickReactions, completion, conversationKey, enabled, idleMotion, onComposerActivity, pet]);

  return { motion: activity === "idle" ? displayed : activity, interact };
}
