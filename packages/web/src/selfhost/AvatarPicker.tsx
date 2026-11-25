import { useId, useMemo, useRef, useState } from "react";
import { useZCodeIntl } from "@zcode/ui";
import { Button } from "@zcode/ui/button";
import { Input } from "@zcode/ui/input";
import {
  WorkspaceAvatar,
  parseWorkspaceAvatar,
  legacyWorkspaceIcons,
} from "@zcode/ui/workspace-avatar";
import workspaceIcons from "virtual:selfhost-workspace-icons";

async function thumbnail(file: File) {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 4 * 1024 * 1024)
    throw Error();
  const src = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    const crop = Math.min(img.naturalWidth, img.naturalHeight);
    if (!crop) throw Error();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw Error();
    ctx.drawImage(
      img,
      (img.naturalWidth - crop) / 2,
      (img.naturalHeight - crop) / 2,
      crop,
      crop,
      0,
      0,
      128,
      128,
    );
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(src);
  }
}
export function AvatarImageUpload({
  change,
  onError,
  onBusy,
}: {
  change: (v: string) => void;
  onError: (v: string) => void;
  onBusy: (v: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const version = useRef(0);
  return (
    <Button asChild size="sm" variant="outline">
      <label className="cursor-pointer focus-within:ring-2 focus-within:ring-ring">
        {intl.formatMessage({ id: "selfhost.upload" })}
        <input
          className="sr-only"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={async (event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (!file) return;
            const selection = ++version.current;
            onBusy(true);
            try {
              const data = await thumbnail(file);
              if (selection === version.current) {
                change(data);
                onError("");
              }
            } catch {
              if (selection === version.current)
                onError(intl.formatMessage({ id: "selfhost.imageError" }));
            } finally {
              if (selection === version.current) onBusy(false);
            }
          }}
        />
      </label>
    </Button>
  );
}

const iconColors = [
  "#4778c5",
  "#167e77",
  "#2b8a50",
  "#a47008",
  "#b86226",
  "#cf4c4c",
  "#ba4b8a",
  "#7654c9",
];
const iconPageSize = 72;
const legacyLabels = new Map(
  Object.entries(legacyWorkspaceIcons).map(([name, icon]) => [icon, name]),
);
const preferredOrder = new Map(
  [
    "fas fa-network-wired",
    "fas fa-server",
    "fab fa-docker",
    "fas fa-wifi",
    "fab fa-apple",
    "fab fa-linux",
    "fab fa-ubuntu",
    "fab fa-debian",
    "fab fa-windows",
    "fas fa-cloud",
    "fas fa-terminal",
    "fas fa-database",
    "fas fa-laptop",
    "fas fa-hard-drive",
    "fas fa-microchip",
    "fab fa-github",
  ].map((icon, index) => [icon, index]),
);
const orderedIcons = workspaceIcons.toSorted(
  ([a], [b]) =>
    (preferredOrder.get(a) ?? preferredOrder.size) - (preferredOrder.get(b) ?? preferredOrder.size),
);

export function AvatarPicker({
  value,
  change,
  onError,
  onBusy,
}: {
  value: string;
  change: (value: string) => void;
  onError: (message: string) => void;
  onBusy: (busy: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const [browsing, setBrowsing] = useState(false);
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(iconPageSize);
  const id = useId();
  const t = (key: string) => intl.formatMessage({ id: "selfhost." + key });
  const { image, icon, color } = parseWorkspaceAvatar(value);
  const normalizedQuery = query.trim().toLowerCase().replace(/\s+/g, " ");
  const options = useMemo(
    () =>
      orderedIcons.map(([className, label, keywords]) => {
        const legacy = legacyLabels.get(className);
        const local = legacy ? intl.formatMessage({ id: "selfhost.icon." + legacy }) : "";
        return {
          className,
          label: local && !className.startsWith("fab ") ? local : label,
          search: `${className} ${label} ${keywords} ${local}`.toLowerCase(),
        };
      }),
    [intl],
  );
  const results = useMemo(
    () => options.filter(({ search }) => search.includes(normalizedQuery)),
    [options, normalizedQuery],
  );
  function setIcon(name: string, nextColor?: string) {
    change(nextColor ? `${name}:${nextColor}` : name);
    onError("");
  }

  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <WorkspaceAvatar value={value} size="lg" />
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-expanded={browsing}
          aria-controls={id}
          onClick={() => setBrowsing(!browsing)}
        >
          {t("browseIcons")}
        </Button>
        <AvatarImageUpload change={change} onError={onError} onBusy={onBusy} />
      </div>
      <div id={id} hidden={!browsing}>
        {browsing ? (
          <div className="grid gap-2">
            <Input
              type="search"
              value={query}
              aria-label={t("searchIcons")}
              placeholder={t("searchIcons")}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
                setVisibleCount(iconPageSize);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                event.preventDefault();
                const match =
                  results.find((option) => option.className === normalizedQuery) ??
                  (results.length === 1 ? results[0] : undefined);
                if (match) setIcon(match.className, color);
              }}
            />
            {results.length > 0 ? (
              <div
                role="radiogroup"
                aria-label={t("avatar")}
                className="grid max-h-48 grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))] gap-1.5 overflow-y-auto p-1"
              >
                {results.slice(0, visibleCount).map(({ className, label }) => (
                  <label
                    key={className}
                    title={`${label} · ${className}`}
                    className="cursor-pointer"
                  >
                    <input
                      className="peer sr-only"
                      type="radio"
                      name="workspaceIcon"
                      checked={!image && icon === className}
                      aria-label={label}
                      aria-description={className}
                      onChange={() => setIcon(className, color)}
                    />
                    <span className="flex h-9 items-center justify-center rounded-md border border-transparent hover:bg-hover peer-checked:border-ring peer-checked:bg-selected peer-focus-visible:outline">
                      <WorkspaceAvatar value={className} />
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="text-ui-sm text-foreground-subtle">{t("noIcons")}</p>
            )}
            {results.length > visibleCount ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="w-fit"
                onClick={() => setVisibleCount(visibleCount + iconPageSize)}
              >
                {t("moreIcons")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {!image ? (
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-ui-sm">{t("iconColor")}</legend>
          <div className="flex flex-wrap items-center gap-2">
            {iconColors.map((preset) => (
              <Button
                key={preset}
                type="button"
                size="icon-sm"
                variant="outline"
                aria-label={preset}
                aria-pressed={color === preset}
                className="size-7 rounded-full border-border aria-pressed:ring-2 aria-pressed:ring-ring"
                style={{ backgroundColor: preset }}
                onClick={() => setIcon(icon, preset)}
              />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex items-center gap-2 text-ui-sm">
              <input
                type="color"
                className="size-7 cursor-pointer"
                value={color ?? iconColors[0]}
                onChange={(event) => setIcon(icon, event.currentTarget.value)}
              />
              {t("customColor")}
            </label>
            {color ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => setIcon(icon)}>
                {t("defaultColor")}
              </Button>
            ) : null}
          </div>
        </fieldset>
      ) : null}
    </div>
  );
}
