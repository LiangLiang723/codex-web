import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ConversationPetActivity } from "./contract.js";

interface MotionStep {
  motion: string;
  duration: number;
}

const sequences: Partial<Record<ConversationPetActivity, MotionStep[]>> = {
  working: [{ motion: "progress", duration: 2_400 }, { motion: "working", duration: 36_000 }],
  reading: [{ motion: "reading", duration: 3_800 }, { motion: "curious", duration: 2_100 }],
  thinking: [{ motion: "thinking", duration: 3_000 }, { motion: "curious", duration: 2_400 }],
  streaming: [{ motion: "streaming", duration: 9_500 }, { motion: "receiving", duration: 1_500 }],
  running: [{ motion: "running", duration: 4_500 }, { motion: "progress", duration: 2_400 }],
  computing: [{ motion: "computing", duration: 4_500 }, { motion: "progress", duration: 2_400 }],
  controlling: [{ motion: "controlling", duration: 4_500 }, { motion: "progress", duration: 2_400 }],
  coding: [{ motion: "coding", duration: 3_600 }, { motion: "writing", duration: 2_800 }],
  writing: [{ motion: "writing", duration: 3_800 }, { motion: "coding", duration: 2_800 }],
  searching: [{ motion: "searching", duration: 4_800 }, { motion: "curious", duration: 1_900 }],
  spawning: [{ motion: "spawning", duration: 2_400 }, { motion: "working", duration: 3_800 }],
  waiting: [{ motion: "waiting", duration: 4_500 }, { motion: "idle", duration: 3_000 }],
};

const context = createContext<{ activity: ConversationPetActivity; motion: string } | null>(null);

export function BotActivityProvider({
  enabled,
  scope,
  activity,
  children,
}: {
  enabled: boolean;
  scope: string;
  activity: ConversationPetActivity;
  children: ReactNode;
}) {
  const [selection, setSelection] = useState<{ activity: ConversationPetActivity; scope: string; step: number } | null>(null);
  const sequence = enabled ? sequences[activity] : undefined;
  const index = selection?.activity === activity && selection.scope === scope ? selection.step : 0;
  const motion = sequence?.[index]?.motion ?? activity;

  useEffect(() => {
    if (!sequence) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let step = 0;
    let timer = 0;
    const schedule = () => {
      window.clearTimeout(timer);
      if (document.hidden || media.matches) return;
      timer = window.setTimeout(() => {
        step = (step + 1) % sequence.length;
        setSelection({ activity, scope, step });
        schedule();
      }, sequence[step]!.duration);
    };
    setSelection({ activity, scope, step });
    schedule();
    document.addEventListener("visibilitychange", schedule);
    media.addEventListener("change", schedule);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", schedule);
      media.removeEventListener("change", schedule);
    };
  }, [activity, scope, sequence]);

  const value = useMemo(() => ({ activity, motion }), [activity, motion]);
  return <context.Provider value={enabled ? value : null}>{children}</context.Provider>;
}

export function useBotActivity() {
  return useContext(context);
}
