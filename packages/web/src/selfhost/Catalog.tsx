import { useEffect, useRef, useState, type FormEvent } from "react";
import { useZCodeIntl } from "@zcode/ui";
import { WorkspaceAvatar } from "@zcode/ui/workspace-avatar";
import { Button } from "@zcode/ui/button";
import { Input } from "@zcode/ui/input";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogHeader,
  DialogFooter,
  DialogDescription,
} from "@zcode/ui/dialog";
import { ZCodeAppLogo } from "@zcode/ui/app-logo";
import { z } from "zod";
import type { Gateway, Host } from "./gateway.js";
import { HostForm } from "./HostForm.js";
import {
  hostConnectionMessages,
  hostConnectionPending,
  waitForHostConnection,
  type HostConnections,
} from "./HostConnection.js";

type Props = {
  gateway: Gateway;
  hosts: Host[];
  connections: HostConnections;
  currentHostId?: number;
  refresh: () => Promise<void>;
  select: (host: Host, cwd: string) => void;
  onConnecting: (hostId: number | null) => void;
  cancelConnection: (hostId: number) => boolean;
  onClose?: () => void;
  account: () => void;
  logout: () => void;
};

const lastDirectorySchema = z.object({
  selfhostLastProject: z.object({ hostId: z.number(), cwd: z.string() }).optional(),
});

export function Catalog({
  gateway,
  hosts,
  connections,
  currentHostId,
  refresh,
  select,
  onConnecting,
  cancelConnection,
  onClose,
  account,
  logout,
}: Props) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const [form, setForm] = useState<Host | null | undefined>();
  const [remove, setRemove] = useState<Host | null>(null);
  const [project, setProject] = useState<Host | null>(null);
  const [error, setError] = useState<{ hostId: number; message: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [entering, setEntering] = useState<number | null>(null);
  const [canceled, setCanceled] = useState<number | null>(null);
  const { current: navigation } = useRef<{ active?: AbortController }>({});
  useEffect(() => () => navigation.active?.abort(), [navigation]);

  function cancelOpen() {
    if (!navigation.active) return;
    navigation.active.abort();
    navigation.active = undefined;
    setCanceled(entering);
    setEntering(null);
    onConnecting(null);
  }

  async function open(host: Host, directory: (signal: AbortSignal) => Promise<string>) {
    if (navigation.active) return;
    const controller = new AbortController();
    navigation.active = controller;
    setError(null);
    setCanceled(null);
    setEntering(host.id);
    onConnecting(host.id);
    try {
      await waitForHostConnection(gateway, host.id, controller.signal);
      const cwd = await directory(controller.signal);
      // 项目读取可能在取消后才结束，旧请求不能切走当前对话。
      if (!controller.signal.aborted) select(host, cwd);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError({
          hostId: host.id,
          message: cause instanceof Error ? cause.message : String(cause),
        });
    } finally {
      if (navigation.active === controller) {
        navigation.active = undefined;
        setEntering(null);
        onConnecting(null);
      }
    }
  }

  function enter(host: Host) {
    return open(host, async (signal) => {
      const [projects, settings] = await Promise.all([
        gateway.projects(host.id, false, signal),
        gateway.request("/api/selfhost/settings", lastDirectorySchema, "GET", undefined, signal),
      ]);
      const last = settings.selfhostLastProject;
      if (
        last?.hostId === host.id &&
        projects.some((candidate) => candidate.remotePath === last.cwd)
      )
        return last.cwd;
      if (projects[0]) return projects[0].remotePath;
      const info = await gateway.request(
        "/api/selfhost/workspace",
        z.object({ value: z.object({ homedir: z.string().startsWith("/") }) }),
        "POST",
        { hostId: host.id, channel: "system", method: "info", args: [] },
        signal,
      );
      return info.value.homedir;
    });
  }

  function submitDirectory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!project) return;
    const fields = new FormData(event.currentTarget);
    const path = String(fields.get("path") ?? "").trim();
    const name = String(fields.get("name") || path.split("/").filter(Boolean).at(-1) || path);
    const hostId = project.id;
    void open(project, async (signal) => {
      const { value } = await gateway.request(
        "/api/selfhost/workspace",
        z.object({ value: z.object({ type: z.string() }) }),
        "POST",
        { hostId, channel: "file", method: "stat", args: [{ path }] },
        signal,
      );
      if (value.type !== "directory") throw Error(t("selfhost.ssh.chooseDirectory"));
      signal.throwIfAborted();
      await gateway.request(
        "/api/projects",
        z.unknown(),
        "POST",
        { hostId, remotePath: path, name },
        signal,
      );
      await refresh();
      return path;
    });
  }

  const close = () => {
    cancelOpen();
    onClose?.();
  };
  const closeProject = () => {
    cancelOpen();
    setProject(null);
    setError(null);
  };
  const describe = (status: keyof typeof hostConnectionMessages, host: Host) =>
    intl.formatMessage({ id: hostConnectionMessages[status] }, { host: host.name });
  const cards = (
    <div className="grid gap-3">
      {hosts.map((host) => {
        const active = entering === host.id;
        const connection = connections[host.id];
        const status = canceled === host.id && !active ? "canceled" : connection?.status;
        const progress = active
          ? status === "mfaRequired" || status === "connected" || hostConnectionPending(status)
            ? status
            : "connecting"
          : status;
        return (
          <section key={host.id} className="rounded-lg border border-card-border bg-card p-3">
            <div className="flex min-w-0 items-center gap-3">
              <WorkspaceAvatar value={host.avatar} />
              <div className="min-w-0 flex-1">
                <h2 className="break-words text-ui-base font-medium">{host.name}</h2>
                <p className="break-words text-ui-sm text-foreground-subtle">
                  {host.username ? host.username + "@" : ""}
                  {host.sshHost}
                  {host.port ? " · " + host.port : ""}
                </p>
              </div>
              {host.id === currentHostId ? (
                <span className="text-ui-xs text-foreground-subtle">
                  {t("selfhost.ssh.current")}
                </span>
              ) : null}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {active ? (
                <Button size="sm" variant="outline" onClick={cancelOpen}>
                  {t("selfhost.ssh.cancelConnection")}
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={entering !== null}
                  onClick={() => void enter(host)}
                  data-testid={
                    status === "mfaRequired" ? "selfhost-catalog-ssh-connect" : undefined
                  }
                  data-host-id={host.id}
                >
                  {t(
                    status === "mfaRequired"
                      ? connection?.challenge
                        ? "selfhost.network.sshVerify"
                        : "selfhost.network.sshConnect"
                      : "selfhost.enter",
                  )}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={entering !== null}
                onClick={() => {
                  setProject(host);
                  setError(null);
                  setCanceled(null);
                }}
              >
                {t("selfhost.ssh.openDirectory")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={entering !== null}
                onClick={() => setForm(host)}
              >
                {t("selfhost.ssh.editAction")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={entering !== null}
                onClick={() => {
                  setRemove(host);
                  setError(null);
                }}
              >
                {t("selfhost.ssh.deleteAction")}
              </Button>
              {!active && hostConnectionPending(status) ? (
                <Button size="sm" variant="ghost" onClick={() => cancelConnection(host.id)}>
                  {t("selfhost.ssh.cancelConnection")}
                </Button>
              ) : null}
            </div>
            {progress && (progress !== "connected" || active) && (
              <p role="status" className="mt-2 break-words text-ui-sm text-foreground-subtle">
                {progress === "connected"
                  ? t("selfhost.ssh.openingDirectory")
                  : describe(progress, host)}
              </p>
            )}
            {error?.hostId === host.id && !project && !remove ? (
              <p role="alert" className="mt-1 break-words text-ui-sm text-destructive">
                {error.message}
              </p>
            ) : null}
          </section>
        );
      })}
      {!hosts.length ? (
        <p className="text-ui-sm text-foreground-subtle">{t("selfhost.ssh.empty")}</p>
      ) : null}
    </div>
  );

  return (
    <>
      {onClose ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) close();
          }}
        >
          <DialogContent
            data-testid="selfhost-ssh-catalog"
            className="max-h-[90dvh] gap-3 overflow-y-auto sm:max-w-lg"
          >
            <DialogHeader>
              <DialogTitle>{t("selfhost.hosts")}</DialogTitle>
              <DialogDescription className="sr-only">
                {t("selfhost.ssh.chooseHost")}
              </DialogDescription>
            </DialogHeader>
            {cards}
            <DialogFooter>
              <Button variant="outline" onClick={close}>
                {t("selfhost.ssh.done")}
              </Button>
              <Button disabled={entering !== null} onClick={() => setForm(null)}>
                {t("selfhost.ssh.add")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : (
        <main
          className="min-h-dvh bg-background px-4 py-8 text-foreground"
          data-testid="selfhost-ssh-catalog"
        >
          <div className="mx-auto max-w-xl">
            <header className="mb-5 flex flex-wrap items-center gap-2">
              <ZCodeAppLogo className="size-8" />
              <h1 className="flex-1 text-ui-xl font-medium">{t("selfhost.hosts")}</h1>
              <Button variant="ghost" onClick={account}>
                {t("selfhost.account")}
              </Button>
              <Button variant="ghost" onClick={logout}>
                {t("app.logout")}
              </Button>
              <Button disabled={entering !== null} onClick={() => setForm(null)}>
                {t("selfhost.ssh.add")}
              </Button>
            </header>
            {cards}
          </div>
        </main>
      )}
      {form !== undefined ? (
        <HostForm
          host={form}
          gateway={gateway}
          onClose={() => setForm(undefined)}
          finish={refresh}
        />
      ) : null}
      {remove ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !deleting) setRemove(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {intl.formatMessage({ id: "selfhost.ssh.removeTitle" }, { host: remove.name })}
              </DialogTitle>
              <DialogDescription>{t("selfhost.ssh.removeHint")}</DialogDescription>
            </DialogHeader>
            {error ? (
              <p role="alert" className="text-ui-sm text-destructive">
                {error.message}
              </p>
            ) : null}
            <DialogFooter>
              <Button variant="ghost" disabled={deleting} onClick={() => setRemove(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="destructive"
                disabled={deleting}
                onClick={async () => {
                  setDeleting(true);
                  try {
                    await gateway.request("/api/hosts/" + remove.id, z.unknown(), "DELETE");
                    await refresh();
                    setRemove(null);
                  } catch (cause) {
                    setError({
                      hostId: remove.id,
                      message: cause instanceof Error ? cause.message : String(cause),
                    });
                  } finally {
                    setDeleting(false);
                  }
                }}
              >
                {t("selfhost.ssh.removeHost")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
      {project ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) closeProject();
          }}
        >
          <DialogContent className="max-h-[90dvh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {intl.formatMessage({ id: "selfhost.ssh.openTitle" }, { host: project.name })}
              </DialogTitle>
              <DialogDescription className="sr-only">
                {t("selfhost.ssh.chooseDirectory")}
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={submitDirectory} className="grid gap-3">
              <label className="grid gap-1 text-ui-sm text-foreground-subtle">
                {t("selfhost.ssh.absolutePath")}
                <Input
                  name="path"
                  required
                  pattern="/.*"
                  autoFocus
                  placeholder="/home/user/project"
                  readOnly={entering !== null}
                />
              </label>
              <label className="grid gap-1 text-ui-sm text-foreground-subtle">
                {t("selfhost.ssh.projectName")}
                <Input name="name" readOnly={entering !== null} />
              </label>
              {entering === project.id || canceled === project.id ? (
                <p role="status" className="text-ui-sm">
                  {t(
                    canceled === project.id
                      ? "selfhost.network.sshCanceled"
                      : connections[project.id]?.status === "connected"
                        ? "selfhost.ssh.openingDirectory"
                        : "selfhost.loading",
                  )}
                </p>
              ) : null}
              {error ? (
                <p role="alert" className="break-words text-ui-sm text-destructive">
                  {error.message}
                </p>
              ) : null}
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={entering !== null ? cancelOpen : closeProject}
                >
                  {t(entering !== null ? "selfhost.ssh.cancelConnection" : "common.cancel")}
                </Button>
                <Button type="submit" disabled={entering !== null}>
                  {t("selfhost.ssh.open")}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
