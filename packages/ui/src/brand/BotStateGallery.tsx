import { useRef, useState } from "react";
import type { useBotAnatomy } from "./anatomyPlayer.js";
import { BotAvatar } from "./BotAvatar.js";
import { botStateGuide } from "./botStateGuide.js";
import type { BotStudioProps } from "./contract.js";

export function BotStateGallery({
  profile,
  preferences,
  locale,
  format,
}: Pick<BotStudioProps, "preferences" | "locale" | "format"> & {
  profile: NonNullable<ReturnType<typeof useBotAnatomy>>;
}) {
  const [group, setGroup] = useState("all");
  const [motion, setMotion] = useState("idle");
  const [replay, setReplay] = useState(0);
  const [poke, setPoke] = useState(0);
  const stage = useRef<HTMLDivElement>(null);
  const all = profile.lifecycleGroups.flatMap((entry) => entry.states);
  const visible = group === "all"
    ? all
    : profile.lifecycleGroups.find((entry) => entry.label === group)?.states ?? [];
  const chinese = locale.startsWith("zh");
  const label = (name: string) => chinese ? botStateGuide[name]?.[1] ?? name : name.replaceAll("-", " ");
  const [use, , zh, english] = botStateGuide[motion] ?? [];
  const autonomous = use === "manual" && preferences.spontaneous && preferences.allActions;
  const details = profile.states[motion];
  const select = (name: string) => {
    setPoke(0);
    setMotion(name);
    setReplay((value) => value + 1);
  };
  const control = "rounded-lg border border-border px-3 py-1.5 text-ui-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring";

  return (
    <div className="space-y-4" data-testid="bot-state-gallery">
      <div ref={stage} className="grid gap-3 rounded-xl border border-border bg-background-alt p-4 sm:grid-cols-[8rem_minmax(0,1fr)]">
        <div data-testid="bot-studio-avatar" className="grid place-items-center">
          <BotAvatar
            key={replay}
            motion={motion}
            shape={preferences.shape}
            color={preferences.color}
            renderSize={128}
            animated
            explicitPlayback
            mirrored={preferences.facing === "mirrored"}
            pokeCount={poke}
            className="size-32"
          />
        </div>
        <div className="min-w-0 space-y-2 self-center">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-ui-lg font-semibold">{motion === "all" ? format("playAll") : label(motion)}</h3>
            {motion === "all" ? null : <code className="text-ui-xs text-foreground-subtle">{motion}</code>}
          </div>
          {use ? (
            <p data-testid="bot-studio-trigger" className="text-ui-sm text-foreground-subtle">
              <span className="mr-2 font-medium text-foreground">{format(autonomous ? "use.automatic" : `use.${use}`)}</span>
              {autonomous ? format("allActionsDescription") : chinese ? zh : english}
            </p>
          ) : null}
          {details ? (
            <p className="break-words text-ui-caption text-foreground-subtle">
              {format("tracks")} {Array.from(new Set(details.clips)).join(" · ")}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button type="button" data-testid="bot-studio-poke" className={control} onClick={() => setPoke((value) => value + 1)}>
              {format("poke")}
            </button>
            <button type="button" data-testid="bot-studio-replay" className={control} onClick={() => select(motion)}>
              {format("replay")}
            </button>
            <button type="button" className={control} onClick={() => select("all")}>
              {format("playAll")}
            </button>
          </div>
        </div>
      </div>

      <p className="text-ui-sm text-foreground-subtle">
        {format("counts", { states: all.length, clips: profile.clips.length })}
      </p>
      <div className="flex flex-wrap gap-2" aria-label={format("groups")}>
        {[{ label: "all", states: all }, ...profile.lifecycleGroups].map((entry) => (
          <button
            key={entry.label}
            type="button"
            data-bot-group={entry.label}
            aria-pressed={group === entry.label}
            className={`${control} aria-pressed:border-brand aria-pressed:bg-accent`}
            onClick={() => setGroup(entry.label)}
          >
            {format(`group.${entry.label}`)} {entry.states.length}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(100px,1fr))] gap-2">
        {visible.map((name) => (
          <button
            key={name}
            type="button"
            data-bot-state-card={name}
            title={chinese ? botStateGuide[name]?.[2] : botStateGuide[name]?.[3]}
            aria-pressed={motion === name}
            className="flex min-w-0 flex-col items-center rounded-xl border border-border p-2 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring aria-pressed:border-brand aria-pressed:bg-accent"
            onClick={() => {
              select(name);
              stage.current?.scrollIntoView({ block: "nearest" });
            }}
          >
            <BotAvatar
              motion={name}
              shape={preferences.shape}
              color={preferences.color}
              renderSize={96}
              seed={`gallery-${name}`}
              animated
              mirrored={preferences.facing === "mirrored"}
              className="size-14"
            />
            <span className="max-w-full truncate text-ui-sm font-medium">{label(name)}</span>
            <code className="max-w-full truncate text-ui-xs text-foreground-subtle">{name}</code>
          </button>
        ))}
      </div>
    </div>
  );
}
