import { useRef, useEffect, useState, type FormEvent } from "react";
import { Button } from "@zcode/ui/button";
import { Input } from "@zcode/ui/input";
import { Textarea } from "@zcode/ui/textarea";
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
import { Gateway, type Host, type Project } from "./gateway.js";

function HostForm({
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
  const [mode, setMode] = useState<Host["authMode"]>(host?.authMode ?? "agent");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const field = (key: string) => String(form.get(key) ?? "").trim();
    const body = {
      name: field("name"),
      sshHost: field("address"),
      port: Number(field("port")),
      username: field("user"),
      authMode: mode,
      hostKeyType: field("algorithm"),
      hostKeyFingerprint: field("fingerprint") || null,
      proxyUrl: field("proxy") || null,
      ...(mode === "privateKey" && field("key") ? { privateKey: field("key") + "\n" } : {}),
      ...(mode === "privateKey" && field("path") ? { privateKeyPath: field("path") } : {}),
      ...(mode === "privateKey" && form.get("passphrase")
        ? { passphrase: String(form.get("passphrase")) }
        : {}),
      ...(mode === "password" && form.get("password")
        ? { password: String(form.get("password")) }
        : {}),
    };
    setBusy(true);
    setError("");
    try {
      await gateway.request(
        "/api/hosts" + (host ? "/" + host.id : ""),
        z.unknown(),
        host ? "PATCH" : "POST",
        body,
      );
      await finish();
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }
  const label = "grid gap-1 text-ui-xs text-foreground-subtle";
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{host ? "编辑 SSH 主机" : "添加 SSH 主机"}</DialogTitle>
          <DialogDescription>
            连接从中心服务器发起。请使用从服务器控制台核对的主机指纹，或由管理员配置 known_hosts。
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={save}>
          <label className={label}>
            名称
            <Input required name="name" defaultValue={host?.name} />
          </label>
          <div className="grid grid-cols-[1fr_6rem] gap-3">
            <label className={label}>
              SSH 地址
              <Input required name="address" defaultValue={host?.sshHost} />
            </label>
            <label className={label}>
              端口
              <Input
                type="number"
                name="port"
                required
                min={1}
                max={65535}
                defaultValue={host?.port ?? 22}
              />
            </label>
          </div>
          <label className={label}>
            用户
            <Input name="user" required defaultValue={host?.username ?? ""} />
          </label>
          <label className={label}>
            认证方式
            <select
              className="rounded-md border border-input-border bg-input p-2"
              value={mode}
              onChange={(v) => setMode(v.currentTarget.value as Host["authMode"])}
            >
              <option value="agent">中心服务器 SSH Agent</option>
              <option value="privateKey">SSH 私钥</option>
              <option value="password">SSH 密码</option>
            </select>
          </label>
          {mode === "privateKey" && (
            <>
              <label className={label}>
                服务端私钥路径
                <Input
                  name="path"
                  defaultValue={host?.privateKeyPath ?? ""}
                  placeholder="/run/ssh-keys/build"
                />
              </label>
              <label className={label}>
                或粘贴私钥
                <Textarea
                  autoComplete="off"
                  name="key"
                  placeholder={host ? "留空保留已保存的密钥" : undefined}
                />
              </label>
              <label className={label}>
                私钥口令
                <Input type="password" name="passphrase" autoComplete="new-password" />
              </label>
            </>
          )}
          {mode === "password" && (
            <label className={label}>
              SSH 密码
              <Input name="password" type="password" autoComplete="new-password" required={!host} />
            </label>
          )}
          <label className={label}>
            主机密钥类型
            <select
              name="algorithm"
              defaultValue={host?.hostKeyType ?? "ssh-ed25519"}
              className="rounded-md border border-input-border bg-input p-2"
            >
              {[
                "ssh-ed25519",
                "ecdsa-sha2-nistp256",
                "ecdsa-sha2-nistp384",
                "ecdsa-sha2-nistp521",
                "ssh-rsa",
              ].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label className={label}>
            主机 SHA256 指纹
            <Input
              name="fingerprint"
              defaultValue={host?.hostKeyFingerprint ?? ""}
              placeholder="SHA256:…"
            />
          </label>
          <label className={label}>
            SOCKS5 隧道（可选）
            <Input
              name="proxy"
              defaultValue={host?.proxyUrl ?? ""}
              placeholder="socks5h://127.0.0.1:1080"
            />
          </label>
          {error && (
            <p role="alert" className="text-ui-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button disabled={busy}>保存</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
type Props = {
  gateway: Gateway;
  hosts: Host[];
  projects: Project[];
  refresh: () => Promise<void>;
  select: (h: Host, cwd: string) => void;
  logout: () => void;
};
export function Catalog({ gateway, hosts, projects, refresh, select, logout }: Props) {
  const [form, setForm] = useState<Host | null | undefined>(),
    [remove, setRemove] = useState<Host | null>(null),
    [project, setProject] = useState<Host | null>(null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const attempted = useRef(new Set<number>());
  const [syncing, setSyncing] = useState<number | null>(null);
  const [syncError, setSyncError] = useState("");
  async function syncProjects(id: number, force: boolean) {
    setSyncing(id);
    setSyncError("");
    try {
      await gateway.projects(id, force);
      await refresh();
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : String(error));
    } finally {
      setSyncing(null);
    }
  }
  useEffect(() => {
    const solo = hosts.length === 1 ? hosts[0] : undefined;
    if (solo && !attempted.current.has(solo.id)) {
      attempted.current.add(solo.id);
      void syncProjects(solo.id, false);
    }
  }, [hosts]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!project) return;
    const f = new FormData(e.currentTarget);
    const path = String(f.get("path") ?? "").trim();
    setError("");
    setBusy(true);
    try {
      const { value } = await gateway.request(
        "/api/selfhost/workspace",
        z.object({ value: z.object({ type: z.string() }) }),
        "POST",
        { hostId: project.id, channel: "file", method: "stat", args: [{ path }] },
      );
      if (value.type !== "directory") throw Error("请选择远程目录");
      await gateway.request("/api/projects", z.unknown(), "POST", {
        hostId: project.id,
        remotePath: path,
        name: String(f.get("name") || path.split("/").filter(Boolean).pop() || path),
      });
      await refresh();
      select(project, path);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="min-h-dvh bg-background px-4 py-12 text-foreground">
      <div className="mx-auto max-w-2xl">
        <header className="mb-7 flex items-center gap-3">
          <ZCodeAppLogo className="size-9" />
          <h1 className="flex-1 text-ui-xl font-medium">SSH 工作区</h1>
          <Button variant="ghost" onClick={logout}>
            退出登录
          </Button>
          <Button onClick={() => setForm(null)}>添加主机</Button>
        </header>
        {hosts.map((host) => (
          <section key={host.id} className="mb-3 rounded-lg border border-card-border bg-card p-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="mr-auto">
                <h2 className="text-ui-base font-medium">{host.name}</h2>
                <p className="text-ui-xs text-foreground-subtle">
                  {host.username}@{host.sshHost} · {host.port ?? 22}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                disabled={syncing === host.id}
                onClick={() => void syncProjects(host.id, true)}
              >
                {syncing === host.id ? "正在同步" : "同步项目"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setForm(host)}>
                编辑
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRemove(host)}>
                删除
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setProject(host);
                  setError("");
                }}
              >
                打开目录
              </Button>
            </div>
            {projects
              .filter((p) => p.hostId === host.id)
              .map((p) => (
                <button
                  key={p.remotePath}
                  className="mt-2 flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-ui-sm hover:bg-hover"
                  onClick={() => select(host, p.remotePath)}
                >
                  <span className="font-medium">{p.name}</span>
                  <span className="truncate text-foreground-subtle">{p.remotePath}</span>
                </button>
              ))}
          </section>
        ))}
        {syncError && (
          <p role="alert" className="text-ui-xs text-destructive">
            {syncError}
          </p>
        )}
        {!hosts.length && (
          <p className="text-ui-sm text-foreground-subtle">
            添加第一台 SSH 主机后即可打开远程项目。
          </p>
        )}
        {form !== undefined && (
          <HostForm
            host={form}
            gateway={gateway}
            onClose={() => setForm(undefined)}
            finish={refresh}
          />
        )}
        {remove && (
          <Dialog open onOpenChange={() => setRemove(null)}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>删除 {remove.name}？</DialogTitle>
                <DialogDescription>
                  移除此主机的中心配置。远程服务器上的文件和 Codex 历史保留。
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setRemove(null)}>
                  取消
                </Button>
                <Button
                  variant="destructive"
                  onClick={async () => {
                    try {
                      await gateway.request("/api/hosts/" + remove.id, z.unknown(), "DELETE");
                      await refresh();
                      setRemove(null);
                    } catch (err) {
                      setError(String(err));
                    }
                  }}
                >
                  删除主机
                </Button>
              </DialogFooter>
              {error && <p role="alert">{error}</p>}
            </DialogContent>
          </Dialog>
        )}
        {project && (
          <Dialog open onOpenChange={() => setProject(null)}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>打开 {project.name} 上的目录</DialogTitle>
              </DialogHeader>
              <form onSubmit={submit} className="grid gap-3">
                <label className={labelClass}>
                  远程绝对路径
                  <Input
                    name="path"
                    required
                    pattern="/.*"
                    autoFocus
                    placeholder="/home/user/project"
                  />
                </label>
                <label className={labelClass}>
                  项目名称（可选）
                  <Input name="name" />
                </label>
                {error && (
                  <p role="alert" className="text-ui-xs text-destructive">
                    {error}
                  </p>
                )}
                <DialogFooter>
                  <Button type="button" variant="ghost" onClick={() => setProject(null)}>
                    取消
                  </Button>
                  <Button disabled={busy}>打开</Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        )}
      </div>
    </main>
  );
}
const labelClass = "grid gap-1 text-ui-xs text-foreground-subtle";
