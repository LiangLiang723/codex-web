import { useEffect, useRef, useState, type FormEvent } from "react";
import { useZCodeIntl } from "@zcode/ui";
import { Button } from "@zcode/ui/button";
import { WorkspaceAvatar } from "@zcode/ui/workspace-avatar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@zcode/ui/dialog";
import { Input } from "@zcode/ui/input";
import { Textarea } from "@zcode/ui/textarea";
import { ChevronDown } from "lucide-react";
import { z } from "zod";
import { AvatarPicker } from "./AvatarPicker.js";
import type { Gateway, Host } from "./gateway.js";

const testResultSchema = z.object({
  status: z.enum([
    "connected",
    "mfaRequired",
    "authentication",
    "hostKey",
    "timeout",
    "unreachable",
    "privateKey",
    "proxy",
    "invalid",
    "failed",
    "canceled",
  ]),
});
type TestStatus = z.infer<typeof testResultSchema>["status"];

function parseAddress(input: string) {
  let address = input.trim();
  let port = "";
  let username = "";
  if (address.startsWith("ssh://")) {
    try {
      const url = new URL(address);
      if (url.password || url.search || url.hash || (url.pathname && url.pathname !== "/")) return;
      address = url.hostname;
      username = decodeURIComponent(url.username);
      port = url.port;
    } catch {
      return;
    }
  } else {
    const command = /^ssh\s+(?:-p\s+(\d+)\s+)?(\S+?)(?:\s+-p\s+(\d+))?$/.exec(address);
    if (command?.[2]) {
      if (command[1] && command[3]) return;
      address = command[2];
      port = command[1] || command[3] || "";
    }
    const destination = /^(?:([^@\s]+)@)?(\S+)$/.exec(address);
    if (!destination?.[2]) return;
    username = destination[1] || "";
    address = destination[2];
    const endpoint = /^(\[[0-9a-f:]+\]|[^:]+):(\d+)$/i.exec(address);
    if (endpoint?.[1] && endpoint[2]) {
      if (port) return;
      address = endpoint[1];
      port = endpoint[2];
    }
  }
  address = address.replace(/^\[([0-9a-f:]+)\]$/i, "$1");
  if (
    !address ||
    address.startsWith("-") ||
    !/^[\p{L}\d_.:-]+$/u.test(address) ||
    (address.includes(":") && !/^[0-9a-f:.]+$/i.test(address)) ||
    /[\s/@]/.test(username) ||
    (port && (Number(port) < 1 || Number(port) > 65535))
  )
    return;
  return { address, username, port };
}

function normalizeAddress(form: HTMLFormElement) {
  const address = form.elements.namedItem("address");
  const user = form.elements.namedItem("user");
  const port = form.elements.namedItem("port");
  if (
    !(address instanceof HTMLInputElement) ||
    !(user instanceof HTMLInputElement) ||
    !(port instanceof HTMLInputElement)
  )
    return false;
  const parsed = parseAddress(address.value);
  if (!parsed) return false;
  address.value = parsed.address;
  if (parsed.username) user.value = parsed.username;
  if (parsed.port) port.value = parsed.port;
  return true;
}

const labelClass = "grid min-w-0 gap-1 text-ui-sm text-foreground-subtle";
const selectClass =
  "min-h-9 w-full rounded-md border border-input-border bg-input px-2 text-ui-base text-foreground";

export function HostForm({
  host,
  gateway,
  finish,
  onClose,
}: {
  host: Host | null;
  gateway: Gateway;
  finish: () => Promise<void>;
  onClose: () => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const [avatar, setAvatar] = useState(host?.avatar ?? "server");
  const [readingAvatar, setReadingAvatar] = useState(false);
  const [mode, setMode] = useState<Host["authMode"]>(host?.authMode ?? "privateKey");
  const [appearance, setAppearance] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<TestStatus | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const { current: probe } = useRef<{ active?: AbortController }>({});
  useEffect(() => () => probe.active?.abort(), [probe]);

  function cancelTest() {
    probe.active?.abort();
    probe.active = undefined;
    setTesting(false);
    setResult("canceled");
  }
  function handleClose() {
    if (saving) return;
    cancelTest();
    onClose();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (probe.active || saving || readingAvatar) return;
    const form = event.currentTarget;
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const test = submitter?.getAttribute("value") === "test";
    setError("");
    setResult(null);
    if (!normalizeAddress(form)) {
      setResult("invalid");
      return;
    }
    const fields = new FormData(form);
    const value = (name: string) => String(fields.get(name) ?? "");
    const field = (name: string) => value(name).trim();
    const sshHost = field("address");
    const privateKey = mode === "privateKey" ? field("key") : "";
    const body = {
      name: field("name") || sshHost,
      avatar,
      sshHost,
      port: field("port") ? Number(field("port")) : null,
      username: field("user") || null,
      authMode: mode,
      hostKeyType: field("algorithm"),
      hostKeyFingerprint: field("fingerprint") || null,
      proxyUrl: field("proxy") || null,
      ...(mode === "privateKey"
        ? {
            privateKeyPath: privateKey ? null : field("path") || null,
            ...(privateKey ? { privateKey: privateKey + "\n" } : {}),
            ...(value("passphrase") ? { passphrase: value("passphrase") } : {}),
          }
        : {}),
      ...(mode === "password" && value("password") ? { password: value("password") } : {}),
    };
    if (test) {
      const controller = new AbortController();
      probe.active = controller;
      setTesting(true);
      try {
        const reply = await gateway.request(
          "/api/selfhost/ssh-test",
          testResultSchema,
          "POST",
          { hostId: host?.id, host: body },
          controller.signal,
        );
        if (probe.active === controller) {
          setResult(reply.status);
          // 试连失败后直接显示要核对的指纹与密钥类型。
          if (reply.status === "hostKey") setAdvanced(true);
        }
      } catch {
        if (probe.active === controller) setResult("failed");
      } finally {
        if (probe.active === controller) {
          probe.active = undefined;
          setTesting(false);
        }
      }
      return;
    }
    setSaving(true);
    try {
      await gateway.request(
        "/api/hosts" + (host ? "/" + host.id : ""),
        z.unknown(),
        host ? "PATCH" : "POST",
        body,
      );
      await finish();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
        data-testid="selfhost-ssh-host-form"
      >
        <DialogHeader>
          <DialogTitle>{t(host ? "selfhost.ssh.edit" : "selfhost.ssh.addTitle")}</DialogTitle>
          <DialogDescription>{t("selfhost.ssh.fromServer")}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={submit}
          onChange={(event) => {
            if ((event.target as HTMLElement).closest("[data-ssh-appearance]")) return;
            setResult(null);
            setError("");
          }}
        >
          <fieldset disabled={testing || saving || readingAvatar} className="grid min-w-0 gap-3">
            <label className={labelClass}>
              {t("selfhost.ssh.address")}
              <Input
                required
                name="address"
                defaultValue={host?.sshHost}
                placeholder="user@host"
                spellCheck={false}
                autoCapitalize="none"
                autoComplete="off"
                onBlur={(event) => {
                  if (event.currentTarget.form) normalizeAddress(event.currentTarget.form);
                }}
              />
            </label>
            <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3">
              <label className={labelClass}>
                {t("selfhost.ssh.user")}
                <Input name="user" defaultValue={host?.username ?? ""} autoComplete="off" />
              </label>
              <label className={labelClass}>
                {t("selfhost.ssh.port")}
                <Input
                  type="number"
                  name="port"
                  min={1}
                  max={65535}
                  placeholder="22"
                  defaultValue={host?.port ?? ""}
                />
              </label>
            </div>
            <div className={labelClass}>
              <label htmlFor="selfhost-ssh-auth">{t("selfhost.ssh.auth")}</label>
              <select
                id="selfhost-ssh-auth"
                className={selectClass}
                value={mode}
                aria-describedby="selfhost-ssh-auth-help"
                onChange={(event) => setMode(event.currentTarget.value as Host["authMode"])}
              >
                <option value="agent">{t("selfhost.ssh.agent")}</option>
                <option value="privateKey">{t("selfhost.ssh.key")}</option>
                <option value="password">{t("selfhost.ssh.password")}</option>
              </select>
            </div>
            <p id="selfhost-ssh-auth-help" className="text-ui-sm text-foreground-subtle">
              {t(`selfhost.ssh.${mode}Hint`)}
            </p>
            {mode === "privateKey" ? (
              <>
                <label className={labelClass}>
                  {t("selfhost.ssh.pasteKey")}
                  <Textarea
                    name="key"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={host ? t("selfhost.ssh.keepKey") : undefined}
                  />
                </label>
                <label className={labelClass}>
                  {t("selfhost.ssh.keyPath")}
                  <Input
                    name="path"
                    defaultValue={host?.privateKeyPath ?? ""}
                    placeholder="/run/ssh-keys/work"
                  />
                </label>
                <label className={labelClass}>
                  {t("selfhost.ssh.passphrase")}
                  <Input type="password" name="passphrase" autoComplete="new-password" />
                </label>
              </>
            ) : mode === "password" ? (
              <label className={labelClass}>
                {t("selfhost.ssh.password")}
                <Input
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  required={!host || host.authMode !== "password"}
                />
              </label>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              className="w-fit gap-2 px-0"
              aria-expanded={advanced}
              aria-controls="selfhost-ssh-advanced"
              onClick={() => setAdvanced(!advanced)}
            >
              <ChevronDown aria-hidden className={advanced ? "rotate-180" : ""} />
              {t("selfhost.ssh.advanced")}
            </Button>
            <div
              id="selfhost-ssh-advanced"
              hidden={!advanced}
              className={advanced ? "grid gap-3" : undefined}
            >
              <p className="text-ui-sm text-foreground-subtle">{t("selfhost.ssh.trustHint")}</p>
              <label className={labelClass}>
                {t("selfhost.ssh.fingerprint")}
                <Input
                  name="fingerprint"
                  defaultValue={host?.hostKeyFingerprint ?? ""}
                  placeholder="SHA256:…"
                  spellCheck={false}
                />
              </label>
              <label className={labelClass}>
                {t("selfhost.ssh.keyType")}
                <select
                  name="algorithm"
                  className={selectClass}
                  defaultValue={host?.hostKeyType ?? "ssh-ed25519"}
                >
                  {[
                    "ssh-ed25519",
                    "ecdsa-sha2-nistp256",
                    "ecdsa-sha2-nistp384",
                    "ecdsa-sha2-nistp521",
                    "ssh-rsa",
                  ].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label className={labelClass}>
                {t("selfhost.ssh.proxy")}
                <Input
                  name="proxy"
                  defaultValue={host?.proxyUrl ?? ""}
                  placeholder="socks5h://127.0.0.1:1080"
                />
              </label>
            </div>
            <Button
              type="button"
              variant="ghost"
              className="w-fit gap-2 px-0"
              aria-expanded={appearance}
              aria-controls="selfhost-ssh-appearance"
              onClick={() => setAppearance(!appearance)}
            >
              <ChevronDown aria-hidden className={appearance ? "rotate-180" : ""} />
              {t("selfhost.ssh.appearance")}
              {!appearance ? <WorkspaceAvatar value={avatar} size="sm" /> : null}
            </Button>
            <div
              id="selfhost-ssh-appearance"
              data-ssh-appearance
              hidden={!appearance}
              className={appearance ? "grid gap-3" : undefined}
            >
              <label className={labelClass}>
                {t("selfhost.ssh.name")}
                <Input name="name" defaultValue={host?.name} />
              </label>
              <AvatarPicker
                value={avatar}
                change={setAvatar}
                onError={setError}
                onBusy={setReadingAvatar}
              />
            </div>
          </fieldset>
          {testing ? (
            <p role="status" className="text-ui-sm">
              {t("selfhost.ssh.testing")}
            </p>
          ) : null}
          {result ? (
            <p
              role="status"
              className={
                result === "connected" ? "text-ui-sm text-success" : "text-ui-sm text-foreground"
              }
            >
              {t("selfhost.ssh.result." + result)}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter className="gap-2 sm:justify-between">
            {testing ? (
              <Button
                type="button"
                variant="outline"
                onClick={(event) => {
                  // 取消后同一按钮会恢复为提交按钮，拦住当前点击的默认提交动作。
                  event.preventDefault();
                  cancelTest();
                }}
              >
                {t("selfhost.ssh.cancelTest")}
              </Button>
            ) : (
              <Button
                type="submit"
                variant="outline"
                value="test"
                disabled={saving || readingAvatar}
              >
                {t("selfhost.ssh.test")}
              </Button>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" disabled={saving} onClick={handleClose}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" value="save" disabled={saving || testing || readingAvatar}>
                {t("selfhost.save")}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
