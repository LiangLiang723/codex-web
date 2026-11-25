import { useState } from "react";
import { useBotAnatomy } from "./anatomyPlayer.js";
import { BotAvatar } from "./BotAvatar.js";
import type { BotMotionPreviewProps } from "./contract.js";

export function BotMotionPreview({ label, allClipsLabel, clipsLabel }: BotMotionPreviewProps) {
  const profile = useBotAnatomy();
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState("all");
  if (!profile) return null;
  return (
    <details
      data-testid="bot-motion-preview"
      className="border-t border-border px-4 py-3 text-ui-base"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer font-medium">{label}</summary>
      {open ? (
        <div className="mt-3 flex min-w-0 flex-col items-center gap-3 sm:flex-row">
          <BotAvatar
            motion={selection.replace(/^state:/, "")}
            animated
            explicitPlayback
            className="size-32"
          />
          <select
            aria-label={label}
            data-testid="bot-motion-select"
            className="w-full min-w-0 rounded-md border border-border bg-background px-3 py-2 text-foreground sm:w-auto"
            value={selection}
            onChange={(event) => setSelection(event.currentTarget.value)}
          >
            <option value="all">{allClipsLabel}</option>
            <optgroup label={clipsLabel}>
              {profile.clips.map((clip) => (
                <option key={clip} value={`clip:${clip}`}>
                  {clip.replaceAll("_", " ")}
                </option>
              ))}
            </optgroup>
            {profile.lifecycleGroups.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.states.map((motion) => (
                  <option key={motion} value={`state:${motion}`}>
                    {motion.replaceAll("-", " ")}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      ) : null}
    </details>
  );
}
