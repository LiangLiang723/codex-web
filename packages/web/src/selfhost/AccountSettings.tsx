import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";
import { useZCodeIntl } from "@zcode/ui";
import { Button } from "@zcode/ui/button";
import { Input } from "@zcode/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@zcode/ui/dialog";
import type { Gateway } from "./gateway.js";

export function AccountSettings({
  gateway,
  close,
  signOut,
}: {
  gateway: Gateway;
  close: () => void;
  signOut: () => void;
}) {
  const { intl } = useZCodeIntl();
  const msg = (key: string) => intl.formatMessage({ id: "selfhost." + key });
  const [username, setUsername] = useState<string>();
  const [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    void gateway
      .request("/api/auth/me", z.object({ user: z.object({ username: z.string() }) }))
      .then(
        (result) => {
          if (active) setUsername(result.user.username);
        },
        (err) => {
          if (active) setError(String(err));
        },
      );
    return () => {
      active = false;
    };
  }, [gateway]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const name = String(fields.get("username") || "").trim();
    const next = String(fields.get("newPassword") || "");
    if (next !== fields.get("confirmation")) {
      setError(msg("mismatch"));
      return;
    }
    if (name === username && !next) {
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
        if (!v && !saving) close();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{msg("account")}</DialogTitle>
          <DialogDescription>{msg("accountHint")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="grid gap-3">
          {username !== undefined && (
            <label className="grid gap-1 text-ui-xs">
              {msg("username")}
              <Input
                required
                autoComplete="username"
                maxLength={128}
                name="username"
                defaultValue={username}
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
            <Button type="button" variant="ghost" onClick={close}>
              {msg("cancel")}
            </Button>
            <Button disabled={saving || username === undefined}>{msg("save")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
