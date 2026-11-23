import "./bootstrap.js";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { Root, ZCodeIntlProvider, AppErrorBoundary, Button } from "@zcode/ui";
import { Input } from "@zcode/ui/input";
import { z } from "zod";
import { createWebPlatform } from "#src/platform/index.js";
import { WebLoginPage } from "../auth/index.js";
import { ConversationShareReadonlyTimeline } from "@zcode/ui/conversation-share-readonly";
import { projectThread, str } from "./threadProjection.js";
import { Catalog } from "./Catalog.js";
import { Gateway, type Host, type Project } from "./gateway.js";
import { openWorkspace } from "./services.js";
import "../styles.css";

const tokenKey = "selfhost.auth";
function Login({ onLogin }: { onLogin: (token: string) => void }) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      onLogin(await Gateway.login(String(form.get("username")), String(form.get("password"))));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <WebLoginPage
      local={{
        title: "登录",
        description: "使用中心服务器账号登录 Codex 工作区。",
        form: (
          <form onSubmit={submit} className="grid gap-3">
            <label className="grid gap-1 text-ui-xs">
              用户名
              <Input autoFocus name="username" autoComplete="username" required />
            </label>
            <label className="grid gap-1 text-ui-xs">
              密码
              <Input type="password" name="password" autoComplete="current-password" required />
            </label>
            {error && (
              <p className="text-ui-xs text-destructive" role="alert">
                {error}
              </p>
            )}
            <Button disabled={busy}>登录</Button>
          </form>
        ),
      }}
    />
  );
}
function Workbench({ gateway, logout }: { gateway: Gateway; logout: () => void }) {
  const [catalog, setCatalog] = useState<{ hosts: Host[]; projects: Project[] } | null>(null);
  const [route, setRoute] = useState(location.search);
  const [mobile, setMobile] = useState(() => matchMedia("(max-width: 767px)").matches);
  useEffect(() => {
    const query = matchMedia("(max-width: 767px)");
    const change = () => setMobile(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  const [opened, setOpened] = useState<Awaited<ReturnType<typeof openWorkspace>> | null>(null);
  const [error, setError] = useState("");
  const query = new URLSearchParams(route),
    hostId = Number(query.get("host")),
    cwd = query.get("cwd") ?? "",
    thread = query.get("thread") ?? undefined;
  const host = catalog?.hosts.find((h) => h.id === hostId);
  const refresh = useCallback(async () => {
    setCatalog(await gateway.config());
  }, [gateway]);
  const navigate = useCallback((params: URLSearchParams) => {
    const search = params.toString();
    history.pushState({}, "", location.pathname + (search ? "?" + search : ""));
    setRoute(location.search);
    setError("");
  }, []);
  const manage = useCallback(() => navigate(new URLSearchParams({ manage: "1" })), [navigate]);
  const select = useCallback(
    (h: Host, path: string) => {
      navigate(new URLSearchParams({ host: String(h.id), cwd: path }));
      void gateway
        .request("/api/selfhost/settings", z.unknown(), "PATCH", {
          selfhostLastProject: { hostId: h.id, cwd: path },
        })
        .catch(() => {});
    },
    [gateway, navigate],
  );
  useEffect(() => {
    if (route || !catalog) return;
    let canceled = false;
    void gateway
      .request(
        "/api/selfhost/settings",
        z.object({
          selfhostLastProject: z.object({ hostId: z.number(), cwd: z.string() }).optional(),
        }),
      )
      .then((v) => {
        const last = v.selfhostLastProject;
        if (
          !canceled &&
          last &&
          catalog.projects.some((p) => p.hostId === last.hostId && p.remotePath === last.cwd)
        )
          navigate(new URLSearchParams({ host: String(last.hostId), cwd: last.cwd }));
      })
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, [route, catalog, gateway, navigate]);
  useEffect(() => {
    const pop = () => setRoute(location.search);
    window.addEventListener("popstate", pop);
    window.addEventListener("zcode-selfhost-manage", manage);
    return () => {
      window.removeEventListener("popstate", pop);
      window.removeEventListener("zcode-selfhost-manage", manage);
    };
  }, [manage]);
  useEffect(() => {
    let active = true;
    void refresh().catch((e) => active && setError(String(e)));
    void gateway.connect().catch((e) => active && setError(String(e)));
    const off = gateway.on((m) => {
      if (m.type === "config.catalog.changed")
        void refresh().catch((e) => active && setError(String(e)));
    });
    return () => {
      active = false;
      off();
    };
  }, [gateway, refresh]);
  useEffect(() => {
    let active = true;
    let resource: Awaited<ReturnType<typeof openWorkspace>> | undefined;
    setOpened(null);
    if (host && cwd) {
      void openWorkspace(gateway, host, cwd, manage).then(
        (r) => {
          resource = r;
          if (active) setOpened(r);
          else r.dispose();
        },
        (e) => {
          if (active) setError(String(e));
        },
      );
    }
    return () => {
      active = false;
      resource?.dispose();
    };
  }, [gateway, host?.id, cwd, manage]);
  const platform = useMemo(
    () => ({
      ...createWebPlatform(),
      activateOrSetWorkspace: async (path: string) => {
        if (host) {
          navigate(new URLSearchParams({ host: String(host.id), cwd: path }));
          return { activated: true };
        }
        return { activated: false };
      },
    }),
    [host?.id, navigate],
  );
  if (error)
    return (
      <WebLoginPage
        local={{
          title: "连接工作区失败",
          description: error,
          form: (
            <div className="flex gap-2">
              <Button onClick={() => location.reload()}>重试</Button>
              <Button variant="outline" onClick={manage}>
                选择主机
              </Button>
              <Button variant="ghost" onClick={logout}>
                退出
              </Button>
            </div>
          ),
        }}
      />
    );
  if (!catalog || (host && cwd && !opened))
    return (
      <WebLoginPage
        local={{
          title: "正在打开工作区",
          description: host?.name ?? "正在读取服务器配置…",
          form: null,
        }}
      />
    );
  if (!host || !cwd || !opened)
    return (
      <Catalog gateway={gateway} {...catalog} refresh={refresh} logout={logout} select={select} />
    );
  const services = opened.services;
  const switcher: NonNullable<Parameters<typeof Root>[0]["webRemoteControlWorkspaceSwitcher"]> = {
    deviceNavigation: { deviceName: host.name, devicePlatform: "linux", chooseOtherDevice: manage },
    async listWorkspaces() {
      const { projects } = await gateway.config();
      return {
        workspaces: projects
          .filter((p) => p.hostId === host.id)
          .map((p) => ({ workspacePath: p.remotePath, label: p.name, kind: "local" as const })),
        activeWorkspaceKey: cwd,
        activeTaskId: thread,
      };
    },
    async switchWorkspace(key, opts) {
      const params = new URLSearchParams({ host: String(host.id), cwd: key });
      const id = opts?.taskId ?? opts?.fileTreeTaskId;
      if (id) params.set("thread", id);
      navigate(params);
    },
    async startDraft(key) {
      navigate(new URLSearchParams({ host: String(host.id), cwd: key }));
    },
    async reconnectWorkspace() {
      location.reload();
    },
  };
  return (
    <ZCodeIntlProvider
      settingService={services.settingService}
      broadcastService={services.broadcastService}
    >
      <Root
        key={host.id + " " + cwd + " " + (thread ?? "")}
        initialWebRemoteControlMobileNavigationIntent={mobile && thread ? "chat" : undefined}
        webRemoteControlWorkspaceSwitcher={mobile ? switcher : undefined}
        services={services}
        platform={platform}
        initialWorkspaceAbsPath={cwd}
        initialTaskId={thread}
        composerClientNamespace={"ssh:" + host.id + ":" + cwd}
        restoreSession={false}
        allowOpenWorkspace={false}
        allowRemoteWorkspace={false}
        preferDirectoryBrowser
        supportsEmbeddedBrowser={false}
        webRemoteControlFeatureEnabled={false}
      />
    </ZCodeIntlProvider>
  );
}
function PrivateShare({ gateway, id }: { gateway: Gateway; id: string }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    void gateway
      .request("/api/selfhost/shares", z.record(z.string(), z.unknown()), "POST", {
        operation: "read",
        id,
      })
      .then(setData, (e) => setError(String(e)));
  }, [gateway, id]);
  if (!data)
    return (
      <WebLoginPage
        local={{
          title: "私有分享",
          description: error || "读取中…",
          form: <a href="/">返回工作区</a>,
        }}
      />
    );
  const snapshot = projectThread(
    { history: data.history, thread: { name: data.title } },
    str(data.sessionId),
    id,
    1,
    [],
    new Map(),
  );
  return (
    <main className="mx-auto min-h-dvh max-w-4xl bg-background p-6 text-foreground">
      <h1 className="mb-4 text-ui-xl">{str(data.title)}</h1>
      <ConversationShareReadonlyTimeline rows={snapshot.rows.window} />
    </main>
  );
}
function App() {
  const [token, setToken] = useState(() => localStorage.getItem(tokenKey) || "");
  const gateway = useMemo(() => (token ? new Gateway(token) : null), [token]);
  const logout = useCallback(() => {
    localStorage.removeItem(tokenKey);
    setToken("");
  }, []);
  useEffect(() => {
    if (!gateway) return;
    let active = true;
    void gateway.request("/api/auth/me", z.unknown()).catch((e) => {
      if (active && /unauthorized|invalid bearer|401/i.test(String(e))) logout();
    });
    return () => {
      active = false;
      gateway.close();
    };
  }, [gateway, logout]);
  const share = new URLSearchParams(location.search).get("share");
  if (gateway && share) return <PrivateShare gateway={gateway} id={share} />;
  return gateway ? (
    <Workbench
      gateway={gateway}
      logout={() => {
        void gateway.request("/api/auth/logout", z.unknown(), "POST").finally(logout);
      }}
    />
  ) : (
    <Login
      onLogin={(value) => {
        localStorage.setItem(tokenKey, value);
        setToken(value);
      }}
    />
  );
}
document.title = "ZCode · Codex";
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </ZCodeIntlProvider>,
);
