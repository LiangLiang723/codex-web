import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { ConversationPetActivity, ConversationPetProps } from "./contract.js";
import {
  choosePetGesture,
  petGestures,
  petTiming,
  randomPetDelay,
  type PetEmotion,
} from "./petPersonality.js";

type PetReaction = "spontaneous" | "touch" | "session";

interface DisplayedCue {
  activity: ConversationPetActivity;
  conversationKey: string | null;
  motion: string;
  reaction?: PetReaction;
}

const priorityActivities = new Set<ConversationPetActivity>([
  "sending",
  "loading",
  "waiting",
  "blocked",
]);

export function usePetBehavior(
  pet: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  activity: ConversationPetProps["activity"],
  completion: ConversationPetProps["completion"],
  conversationKey: ConversationPetProps["conversationKey"],
  onComposerActivity: ConversationPetProps["onComposerActivity"],
  { idleMotion, clickReactions, personality, spontaneous }: ConversationPetProps["preferences"],
) {
  const [displayed, setDisplayed] = useState<DisplayedCue | null>(null);
  const last = useRef({ activity, conversationKey, activeSince: 0 });
  const emotion = useRef<{ kind: PetEmotion; until: number }>({ kind: "settled", until: 0 });
  const previousGesture = useRef<string | undefined>(undefined);
  const interact = useRef<(() => void) | null>(null);

  useEffect(() => {
    const previous = last.current;
    const sameConversation = previous.conversationKey === conversationKey;
    const now = performance.now();
    const idle = activity === "idle";
    last.current = {
      activity,
      conversationKey,
      activeSince: idle ? 0 : (sameConversation && previous.activeSince) || now,
    };

    const pane = pet.current?.parentElement;
    if (!enabled || !pane) {
      setDisplayed(null);
      return;
    }

    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const timing = petTiming[personality];
    const ambientAllowed = spontaneous && (idle ? idleMotion : !priorityActivities.has(activity));
    const ambientDelay = idle ? timing.idle : timing.active;
    let timer = 0;
    let currentMotion: string | null = null;
    let playing = false;
    let lastPresence = now;
    let sleepAt = idle && idleMotion ? now + randomPetDelay(timing.sleep) : Infinity;
    let ambientAt = ambientAllowed ? now + randomPetDelay(ambientDelay) : Infinity;

    const show = (motion: string | null, reaction?: PetReaction) => {
      currentMotion = motion;
      setDisplayed(motion ? { activity, conversationKey, motion, reaction } : null);
    };
    const mood = () =>
      performance.now() < emotion.current.until ? emotion.current.kind : "settled";
    const canMove = () => !document.hidden && !media.matches;
    const rememberMood = (kind: PetEmotion) => {
      emotion.current = { kind, until: performance.now() + 45_000 };
    };
    const resetSleep = () => {
      lastPresence = performance.now();
      if (idleMotion) sleepAt = lastPresence + randomPetDelay(timing.sleep);
    };

    function resume(): void {
      playing = false;
      ambientAt = ambientAllowed ? performance.now() + randomPetDelay(ambientDelay) : Infinity;
      rest();
    }

    function play(motion: string, duration: number, reaction: PetReaction, next = resume): void {
      window.clearTimeout(timer);
      if (document.hidden) return;
      playing = true;
      show(motion, reaction);
      if (canMove()) timer = window.setTimeout(next, duration);
    }

    function rest(): void {
      window.clearTimeout(timer);
      if (!canMove()) {
        show(null);
        return;
      }
      const time = performance.now();
      const drowsyAt = sleepAt - 5_000;
      if (time >= sleepAt) {
        show("sleeping");
        return;
      }
      if (time >= drowsyAt) {
        show("drowsy");
        timer = window.setTimeout(rest, sleepAt - time);
        return;
      }
      if (time >= ambientAt) {
        const choices = idle ? petGestures.idle : petGestures.active;
        const gesture = choosePetGesture(choices, personality, mood(), previousGesture.current);
        previousGesture.current = gesture.motion;
        play(gesture.motion, gesture.duration, "spontaneous");
        return;
      }
      show(null);
      const next = Math.min(ambientAt, drowsyAt);
      if (Number.isFinite(next)) timer = window.setTimeout(rest, next - time);
    }

    const presence = () => {
      if (!canMove() || performance.now() - lastPresence < 400) return;
      const asleep = currentMotion === "sleeping" || currentMotion === "drowsy";
      resetSleep();
      if (asleep) play("waking", 1_700, "session");
      else if (!playing) rest();
    };

    const visibilityChanged = () => {
      playing = false;
      if (idle) resetSleep();
      resume();
    };
    if (idle) {
      onComposerActivity.current = () => {
        resetSleep();
        play("listening", 1_600, "session");
      };
      interact.current = clickReactions
        ? () => {
            resetSleep();
            if (currentMotion === "sleeping" || currentMotion === "drowsy") {
              play("waking", 1_700, "touch");
              return;
            }
            if (currentMotion === "waking") return;
            const gesture = choosePetGesture(
              petGestures.touch,
              personality,
              mood(),
              previousGesture.current,
            );
            previousGesture.current = gesture.motion;
            rememberMood(gesture.motion === "surprised" ? "wary" : "cheerful");
            play(gesture.motion, gesture.duration, "touch");
          }
        : null;
      pane.addEventListener("pointermove", presence, { passive: true });
      pane.addEventListener("focusin", presence);
    }

    const completedHere =
      idle &&
      conversationKey !== null &&
      sameConversation &&
      previous.activity !== "idle" &&
      completion;
    if (completedHere === "finished") {
      rememberMood("cheerful");
      const longTurn = previous.activeSince > 0 && now - previous.activeSince >= 20_000;
      play(
        "finished",
        6_200,
        "session",
        longTurn ? () => play("celebrate", 6_300, "session") : resume,
      );
    } else if (completedHere === "failed") {
      rememberMood("wary");
      play("failed", 3_500, "session", () => play("alerting", 1_700, "session"));
    } else {
      rest();
    }

    document.addEventListener("visibilitychange", visibilityChanged);
    media.addEventListener("change", visibilityChanged);
    return () => {
      interact.current = null;
      onComposerActivity.current = null;
      window.clearTimeout(timer);
      pane.removeEventListener("pointermove", presence);
      pane.removeEventListener("focusin", presence);
      document.removeEventListener("visibilitychange", visibilityChanged);
      media.removeEventListener("change", visibilityChanged);
    };
  }, [
    activity,
    clickReactions,
    completion,
    conversationKey,
    enabled,
    idleMotion,
    onComposerActivity,
    personality,
    pet,
    spontaneous,
  ]);

  const cue =
    enabled &&
    displayed?.activity === activity &&
    displayed.conversationKey === conversationKey &&
    (displayed.reaction !== "spontaneous" || spontaneous)
      ? displayed
      : null;
  return { cue, interact };
}
