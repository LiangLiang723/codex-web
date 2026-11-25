import { useState, type FormEvent } from "react";
import { z } from "zod";
import { useZCodeIntl } from "@zcode/ui";
import { Button } from "@zcode/ui/button";
import { Input } from "@zcode/ui/input";
import { WorkspaceAvatar } from "@zcode/ui/workspace-avatar";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@zcode/ui/dialog";
import { AvatarImageUpload } from "./AvatarPicker.js";
import { accountAvatarSchema, type AccountProfile, type Gateway } from "./gateway.js";

export function AccountSettings({
  gateway,
  profile,
  loadError,
  onAvatarSaved,
  close,
  signOut,
}: {
  gateway: Gateway;
  profile?: AccountProfile;
  loadError?: string;
  onAvatarSaved: (avatar: string | null) => void;
  close: () => void;
  signOut: () => void;
}) {
  const { intl } = useZCodeIntl();
  const msg = (key: string) => intl.formatMessage({ id: "selfhost." + key });
  const [avatarDraft, setAvatarDraft] = useState<string | null>();
  const [readingAvatar, setReadingAvatar] = useState(false);
  const [savingAvatar, setSavingAvatar] = useState(false);
  const [avatarError, setAvatarError] = useState("");
  const [avatarSaved, setAvatarSaved] = useState(false);
  const [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  const avatar = avatarDraft === undefined ? (profile?.avatar ?? null) : avatarDraft;
  const writing = savingAvatar || saving;
  const canSaveAvatar = profile && avatar !== profile.avatar && !readingAvatar && !writing;
  function editAvatar(next: string | null) {
    setAvatarDraft(next);
    setAvatarSaved(false);
    setAvatarError("");
  }
  async function saveAvatar() {
    if (!canSaveAvatar) return;
    setSavingAvatar(true);
    setAvatarError("");
    setAvatarSaved(false);
    try {
      const result = await gateway.request(
        "/api/selfhost/account/avatar",
        accountAvatarSchema,
        "PATCH",
        { avatar },
      );
      onAvatarSaved(result.avatar);
      setAvatarDraft(undefined);
      setAvatarSaved(true);
    } catch (cause) {
      setAvatarError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingAvatar(false);
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile || writing) return;
    const fields = new FormData(event.currentTarget);
    const name = String(fields.get("username") || "").trim();
    const next = String(fields.get("newPassword") || "");
    if (next !== fields.get("confirmation")) {
      setError(msg("mismatch"));
      return;
    }
    if (name === profile.username && !next) {
      close();
      return;
    }
    setSaving(true);
    setError("");
    try {
      const result = await gateway.request(
        "/api/selfhost/account",
        z.object({ reauthenticate: z.boolean() }),
        "PATCH",
        {
          username: name,
          currentPassword: fields.get("currentPassword"),
          ...(next ? { newPassword: next } : {}),
        },
      );
      if (result.reauthenticate) signOut();
      else close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !writing) close();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{msg("account")}</DialogTitle>
        </DialogHeader>
        {loadError ? (
          <p role="alert" className="text-ui-xs text-destructive">
            {loadError}
          </p>
        ) : null}
        {profile ? (
          <fieldset className="grid gap-2 border-b border-border pb-4" disabled={writing}>
            <legend className="mb-2 text-ui-sm font-medium">{msg("accountAvatar")}</legend>
            <div className="flex flex-wrap items-center gap-2">
              <WorkspaceAvatar
                value={avatar ?? undefined}
                fallback={profile.username.charAt(0).toUpperCase() || undefined}
                size="lg"
              />
              <AvatarImageUpload
                change={editAvatar}
                onError={setAvatarError}
                onBusy={(busy) => {
                  setReadingAvatar(busy);
                  if (busy) setAvatarSaved(false);
                }}
              />
              {avatar ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={readingAvatar}
                  onClick={() => editAvatar(null)}
                >
                  {msg("accountAvatarReset")}
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!canSaveAvatar}
                onClick={() => void saveAvatar()}
              >
                {msg("accountAvatarSave")}
              </Button>
            </div>
            {avatarError ? (
              <p role="alert" className="text-ui-xs text-destructive">
                {avatarError}
              </p>
            ) : null}
            {avatarSaved ? (
              <p role="status" className="text-ui-xs text-foreground-subtle">
                {msg("accountAvatarSaved")}
              </p>
            ) : null}
          </fieldset>
        ) : null}
        <form onSubmit={save} className="grid gap-3">
          <DialogDescription>{msg("accountHint")}</DialogDescription>
          {profile && (
            <label className="grid gap-1 text-ui-xs">
              {msg("username")}
              <Input
                required
                autoComplete="username"
                maxLength={128}
                name="username"
                defaultValue={profile.username}
              />
            </label>
          )}
          <label className="grid gap-1 text-ui-xs">
            {msg("currentPassword")}
            <Input
              required
              name="currentPassword"
              type="password"
              autoComplete="current-password"
            />
          </label>
          <label className="grid gap-1 text-ui-xs">
            {msg("newPassword")}
            <Input
              name="newPassword"
              type="password"
              minLength={8}
              maxLength={4096}
              autoComplete="new-password"
            />
          </label>
          <label className="grid gap-1 text-ui-xs">
            {msg("confirmPassword")}
            <Input name="confirmation" type="password" autoComplete="new-password" />
          </label>
          {error && (
            <p role="alert" className="text-ui-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={writing} onClick={close}>
              {msg("cancel")}
            </Button>
            <Button disabled={writing || !profile}>{msg("save")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
