import { useState } from "react";
import { useBotAnatomy } from "./anatomyPlayer.js";
import { BotAvatar } from "./BotAvatar.js";
import { BotStateGallery } from "./BotStateGallery.js";
import { chineseShapeNames } from "./botStateGuide.js";
import {
  BOT_FACING_MODES,
  BOT_MATERIALS,
  BOT_PERSONALITIES,
  BOT_SIZES,
  DEFAULT_PET_PREFERENCES,
  type BotShape,
  type BotStudioProps,
} from "./contract.js";

const swatches = [
  ["white", "#ffffff"], ["neutral", "#161616"], ["brown", "#9c6b45"],
  ["red", "#f62f51"], ["orange", "#ff7208"], ["yellow", "#ffa000"], ["green", "#36c56e"],
  ["teal", "#2ebaaa"], ["blue", "#3289ff"], ["purple", "#9559ee"], ["pink", "#f739aa"],
  ["gray", "#868888"],
] as const;

const option = "rounded-lg border border-border text-ui-sm transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring aria-pressed:border-brand aria-pressed:bg-accent";

export function BotStudio({ preferences, onChange, locale, format }: BotStudioProps) {
  const profile = useBotAnatomy();
  const [gallery, setGallery] = useState(false);
  const [poke, setPoke] = useState(0);
  const shapes: readonly BotShape[] = profile?.shapes ?? ["sphere"];

  return (
    <div data-testid="conversation-pet-studio" className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="bot-studio-appearance-tab"
          aria-pressed={!gallery}
          onClick={() => setGallery(false)}
          className={`${option} px-3 py-1.5`}
        >
          {format("appearance")}
        </button>
        {profile ? (
          <button
            type="button"
            data-testid="bot-studio-gallery-tab"
            aria-pressed={gallery}
            onClick={() => setGallery(true)}
            className={`${option} px-3 py-1.5`}
          >
            {format("gallery")}
          </button>
        ) : null}
      </div>

      {gallery && profile ? (
        <BotStateGallery profile={profile} locale={locale} preferences={preferences} format={format} />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(11rem,0.8fr)_minmax(0,1.4fr)]">
          <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-border bg-background-alt p-4">
            <button
              type="button"
              data-testid="bot-studio-avatar"
              className="flex min-h-36 w-full items-center justify-center rounded-xl focus-visible:outline-2 focus-visible:outline-ring"
              aria-label={format("poke")}
              onClick={() => setPoke((value) => value + 1)}
            >
              <BotAvatar
                animated
                followPointer={preferences.followPointer}
                mirrored={preferences.facing === "mirrored"}
                shape={preferences.shape}
                color={preferences.color}
                material={preferences.material}
                renderSize={144}
                scale={BOT_SIZES[preferences.size]}
                pokeCount={poke}
                className="size-36"
              />
            </button>
            <span className="text-ui-caption text-foreground-subtle">{format("livePreview")}</span>
          </div>
          <div className="min-w-0 space-y-4">
            <fieldset className="min-w-0">
              <legend className="mb-2 text-ui-sm font-medium">{format("shape")}</legend>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(46px,1fr))] gap-1.5">
                {shapes.map((shape) => {
                  const name = locale.startsWith("zh") ? chineseShapeNames[shape] : humanize(shape);
                  return (
                    <button
                      key={shape}
                      type="button"
                      data-pet-shape-option={shape}
                      aria-label={name}
                      title={name}
                      aria-pressed={preferences.shape === shape}
                      onClick={() => onChange({ shape })}
                      className={`${option} grid h-11 place-items-center`}
                    >
                      <BotAvatar
                        shape={shape}
                        color={preferences.color}
                        renderSize={32}
                        scale={1.32}
                        frontFacing
                        className="size-8"
                      />
                    </button>
                  );
                })}
              </div>
            </fieldset>
            {profile?.materials ? (
              <fieldset>
                <legend className="mb-2 text-ui-sm font-medium">{format("material")}</legend>
                <div className="flex flex-wrap gap-2">
                  {BOT_MATERIALS.map((material) => (
                    <button
                      key={material}
                      type="button"
                      data-pet-material-option={material}
                      aria-pressed={material === preferences.material}
                      onClick={() => onChange({ material })}
                      className={`${option} px-3 py-1.5`}
                    >
                      {format(`material.${material}`)}
                    </button>
                  ))}
                </div>
              </fieldset>
            ) : null}
            <fieldset>
              <legend className="mb-2 text-ui-sm font-medium">{format("color")}</legend>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-pet-color-option="auto"
                  aria-pressed={preferences.color === null}
                  onClick={() => onChange({ color: null })}
                  className={`${option} h-8 px-2`}
                >
                  {format("autoColor")}
                </button>
                {swatches.map(([name, value]) => (
                  <button
                    key={name}
                    type="button"
                    data-pet-color-option={value}
                    aria-pressed={preferences.color === value}
                    aria-label={`${format("color")} ${format(`color.${name}`)}`}
                    title={format(`color.${name}`)}
                    className="size-7 rounded-full border border-border ring-offset-2 ring-offset-background focus-visible:ring-2 focus-visible:ring-ring aria-pressed:ring-2 aria-pressed:ring-foreground"
                    style={{ backgroundColor: value }}
                    onClick={() => onChange({ color: value })}
                  />
                ))}
                <label className="inline-flex h-8 items-center gap-1.5 text-ui-caption text-foreground-subtle">
                  <input
                    type="color"
                    data-testid="bot-studio-custom-color"
                    value={preferences.color ?? "#3289ff"}
                    onChange={(event) => onChange({ color: event.currentTarget.value })}
                    className="h-7 w-8 cursor-pointer rounded border border-border bg-background p-0.5"
                  />
                  {format("customColor")}
                </label>
              </div>
            </fieldset>
            <fieldset>
              <legend className="mb-2 text-ui-sm font-medium">{format("size")}</legend>
              <div className="flex flex-wrap gap-2">
                {(Object.keys(BOT_SIZES) as (keyof typeof BOT_SIZES)[]).map((size) => (
                  <button
                    key={size}
                    type="button"
                    data-pet-size-option={size}
                    aria-pressed={size === preferences.size}
                    className={`${option} px-3 py-1.5`}
                    onClick={() => onChange({ size })}
                  >
                    {format(`size.${size}`)}
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend className="mb-2 text-ui-sm font-medium">{format("facing")}</legend>
              <div className="flex flex-wrap gap-2">
                {BOT_FACING_MODES.map((facing) => (
                  <button
                    key={facing}
                    type="button"
                    data-pet-facing-option={facing}
                    aria-pressed={facing === preferences.facing}
                    onClick={() => onChange({ facing })}
                    className={`${option} px-3 py-1.5`}
                  >
                    {format(`facing.${facing}`)}
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend className="mb-2 text-ui-sm font-medium">{format("personality")}</legend>
              <div className="flex flex-wrap gap-2">
                {BOT_PERSONALITIES.map((personality) => (
                  <button
                    key={personality}
                    type="button"
                    data-pet-personality-option={personality}
                    aria-pressed={personality === preferences.personality}
                    onClick={() => onChange({ personality })}
                    className={`${option} px-3 py-1.5`}
                  >
                    {format(`personality.${personality}`)}
                  </button>
                ))}
              </div>
            </fieldset>
            <button
              type="button"
              data-testid="bot-studio-reset"
              onClick={() => onChange(DEFAULT_PET_PREFERENCES)}
              className="rounded-md px-2 py-1 text-ui-sm text-foreground-subtle hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              {format("reset")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function humanize(value: string) {
  const text = value.replace(/([a-z])([A-Z])/gu, "$1 $2");
  return text[0]?.toUpperCase() + text.slice(1);
}
