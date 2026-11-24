import { useRef } from "react";
import { useZCodeIntl } from "@zcode/ui";
import { Button } from "@zcode/ui/button";
import { WorkspaceAvatar, workspaceIconNames } from "@zcode/ui/workspace-avatar";

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
export function AvatarPicker({
  value,
  change,
  onError,
  onBusy,
}: {
  value: string;
  change: (v: string) => void;
  onError: (v: string) => void;
  onBusy: (v: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const version = useRef(0);
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-ui-xs text-foreground-subtle">
        {intl.formatMessage({ id: "selfhost.avatar" })}
      </legend>
      <div className="flex flex-wrap items-center gap-2">
        {workspaceIconNames.map((name) => (
          <label key={name} className="cursor-pointer">
            <input
              className="peer sr-only"
              type="radio"
              name="workspaceIcon"
              checked={value === name}
              aria-label={intl.formatMessage({ id: "selfhost.icon." + name })}
              onChange={() => {
                version.current++;
                onBusy(false);
                change(name);
                onError("");
              }}
            />
            <span className="block rounded-full peer-checked:ring-2 peer-checked:ring-foreground peer-focus-visible:outline">
              <WorkspaceAvatar value={name} />
            </span>
          </label>
        ))}
        {value.startsWith("data:") && <WorkspaceAvatar value={value} />}
        <Button asChild size="sm" variant="outline">
          <label className="cursor-pointer">
            {intl.formatMessage({ id: "selfhost.upload" })}
            <input
              className="sr-only"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={async (e) => {
                const file = e.currentTarget.files?.[0];
                e.currentTarget.value = "";
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
      </div>
    </fieldset>
  );
}
