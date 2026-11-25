import "./bootstrap.js";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useRef,
  type FormEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { Root, ZCodeIntlProvider, useZCodeIntl, AppErrorBoundary, Button } from "@zcode/ui";
import { Input } from "@zcode/ui/input";
import { z } from "zod";
import { createWebPlatform } from "#src/platform/index.js";
import { WebLoginPage } from "../auth/index.js";
import { ConversationShareReadonlyTimeline } from "@zcode/ui/conversation-share-readonly";
import { projectThread, str } from "./threadProjection.js";
import { AccountSettings } from "./AccountSettings.js";
import { Catalog } from "./Catalog.js";
import { Gateway, type Host, type Project } from "./gateway.js";
import {
  hostConnectionMessages,
  hostConnectionPending,
  HostMfaDialog,
  useHostConnections,
} from "./HostConnection.js";
import { openWorkspace } from "./services.js";
import "../styles.css";

const tokenKey = "selfhost.auth";
type WorkspaceDraft = NonNullable<Parameters<typeof Root>[0]["initialTaskDraft"]>;
type DraftHandoff = { identity: string; draft: WorkspaceDraft };
function workspaceKey(host: Host, cwd: string) {
  return JSON.stringify([
    host.id,
    host.createdAt,
    host.sshHost,
    host.port,
    host.username,
    host.proxyUrl,
    host.hostKeyFingerprint,
    cwd,
  ]);
}

function Login({ onLogin }: { onLogin: (token: string) => void }) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const { username, password } = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setError("");
    try {
      if (typeof username !== "string" || typeof password !== "string")
        throw Error("请输入用户名和密码");
      onLogin(await Gateway.login({ username, password }));
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
function Workbench({
  gateway,
  logout,
  account,
}: {
  gateway: Gateway;
  logout: () => void;
  account: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [catalogSnapshot, setCatalogSnapshot] = useState<{
    gateway: Gateway;
    hosts: Host[];
    projects: Project[];
  } | null>(null);
  // 切换登录后，新主机挑战不能和上一账号目录中的同号主机匹配。
  const catalog = catalogSnapshot?.gateway === gateway ? catalogSnapshot : null;
  const [managing, setManaging] = useState(false);
  const [catalogTargetId, setCatalogTargetId] = useState<number | null>(null);
  const [workspaceAttempt, setWorkspaceAttempt] = useState(0);
  const [route, setRoute] = useState(location.search);
  const [mobile, setMobile] = useState(() => matchMedia("(max-width: 767px)").matches);
  useEffect(() => {
    const query = matchMedia("(max-width: 767px)");
    const change = () => setMobile(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  const [mounted, setMounted] = useState<{
    gateway: Gateway;
    identity: string;
    workspace: Awaited<ReturnType<typeof openWorkspace>>;
  } | null>(null);
  const [catalogIssue, setCatalogIssue] = useState("");
  const [draftHandoff, setDraftHandoff] = useState<DraftHandoff | null>(null);
  const navigationVersion = useRef(0);
  const [error, setError] = useState("");
  const [webReconnecting, setWebReconnecting] = useState(false);
  const {
    connections: hostConnections,
    connect: connectHost,
    cancel: cancelHostConnection,
    respond: respondToMfa,
  } = useHostConnections(gateway);
  const query = new URLSearchParams(route),
    hostId = Number(query.get("host")),
    cwd = query.get("cwd") ?? "",
    thread = query.get("thread") ?? undefined;
  const host = catalog?.hosts.find((h) => h.id === hostId);
  const selectedId = host?.id,
    selectedName = host?.name,
    selectedAvatar = host?.avatar;
  // 切换同目录的另一台 SSH 主机时，旧服务会存活到 effect cleanup；渲染前必须校验归属。
  const identity = host && workspaceKey(host, cwd);
  const opened =
    mounted?.gateway === gateway && mounted.identity === identity ? mounted.workspace : null;
  const { current: catalogReads } = useRef({ generation: 0 });
  const refresh = useCallback(async () => {
    const version = ++catalogReads.generation;
    try {
      const next = await gateway.config();
      if (version === catalogReads.generation) {
        setCatalogSnapshot({ gateway, ...next });
        setCatalogIssue("");
      }
    } catch (cause) {
      if (version === catalogReads.generation)
        setCatalogIssue(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
  }, [gateway, catalogReads]);
  const navigate = useCallback((params: URLSearchParams, handoff: DraftHandoff | null = null) => {
    navigationVersion.current++;
    setDraftHandoff(handoff);
    const search = params.toString();
    history.pushState({}, "", location.pathname + (search ? "?" + search : ""));
    setRoute(location.search);
    setManaging(false);
    setCatalogTargetId(null);
    setError("");
  }, []);
  const openProjectDraft = async (request: WorkspaceDraft) => {
    const target = request.targetWorkspace;
    if (
      !host ||
      !target ||
      target.workspaceIdentity ||
      (target.hostId && target.hostId !== "local" && target.hostId !== String(host.id))
    ) {
      throw Error(intl.formatMessage({ id: "project.primaryRootUnavailable" }));
    }
    const version = navigationVersion.current;
    const { hosts, projects } = await gateway.config();
    if (version !== navigationVersion.current || request.isCurrent?.() === false) return;
    const verified = hosts.find((item) => item.id === host.id);
    const project = projects.find(
      (item) =>
        item.hostId === host.id &&
        (item.remotePath === target.workspacePath ||
          item.roots?.includes(target.workspacePath) ||
          item.aliases?.includes(target.workspacePath)),
    );
    if (!verified || workspaceKey(verified, cwd) !== identity || !project)
      throw Error(intl.formatMessage({ id: "project.primaryRootUnavailable" }));
    const path = target.workspacePath;
    // 草稿只交给对应路由新建的服务；旧工作区的输入框和 native Thread 均不能接收。
    const draft: WorkspaceDraft = {
      ...request,
      projectId: project.id ?? project.remotePath,
      taskGroupId: request.taskGroupId ?? null,
      onComplete: () => {
        setDraftHandoff((pending) => (pending?.draft === draft ? null : pending));
        request.onComplete?.();
      },
    };
    navigate(new URLSearchParams({ host: String(host.id), cwd: path }), {
      identity: workspaceKey(verified, path),
      draft,
    });
  };
  const manage = useCallback(() => setManaging(true), []);
  const chooseHost = () => navigate(new URLSearchParams({ manage: "1" }));
  const select = useCallback(
    (h: Host, path: string) => {
      if (h.id !== hostId || path !== cwd)
        navigate(new URLSearchParams({ host: String(h.id), cwd: path }));
      else setManaging(false);
      void gateway
        .request("/api/selfhost/settings", z.unknown(), "PATCH", {
          selfhostLastProject: { hostId: h.id, cwd: path },
        })
        .catch(() => {});
    },
    [cwd, gateway, hostId, navigate],
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
    const pop = () => {
      navigationVersion.current++;
      setDraftHandoff(null);
      setManaging(false);
      setCatalogTargetId(null);
      setRoute(location.search);
    };
    window.addEventListener("popstate", pop);
    return () => {
      window.removeEventListener("popstate", pop);
    };
  }, []);
  useEffect(() => {
    void refresh().catch(() => {});
    const off = gateway.on((m) => {
      if (m.type === "config.catalog.changed") void refresh().catch(() => {});
      else if (m.type === "disconnected") {
        setWebReconnecting(true);
      } else if (m.type === "ready") {
        setWebReconnecting(false);
        void refresh().catch(() => {});
        void gateway.send({ type: "host.lifecycle.subscribe" }).catch(() => {});
      }
    });
    // 已打开的工作区应在实时连接恢复时继续使用原会话。
    void gateway.connect().catch(() => {});
    return () => {
      catalogReads.generation++;
      off();
    };
  }, [gateway, refresh, catalogReads]);
  useEffect(() => {
    let active = true;
    let resource: Awaited<ReturnType<typeof openWorkspace>> | undefined;
    setMounted(null);
    if (selectedId !== undefined && identity && cwd) {
      void openWorkspace(gateway, selectedId, cwd, manage).then(
        (r) => {
          resource = r;
          if (active) setMounted({ gateway, identity, workspace: r });
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
  }, [gateway, selectedId, identity, cwd, manage, workspaceAttempt]);
  const platform = useMemo(
    () => ({
      ...createWebPlatform(),
      ...(selectedId !== undefined && selectedName
        ? {
            sshWorkspace: {
              name: selectedName,
              avatar: selectedAvatar ?? "server",
              manage,
              account,
              logout,
            },
          }
        : {}),
      activateOrSetWorkspace: async (path: string) => {
        if (selectedId !== undefined) {
          navigate(new URLSearchParams({ host: String(selectedId), cwd: path }));
          return { activated: true };
        }
        return { activated: false };
      },
    }),
    [selectedId, selectedName, selectedAvatar, navigate, manage, account, logout],
  );
  const sshConnection = host && hostConnections[host.id];
  const sshStatus = sshConnection?.status;
  const noticeMessage = webReconnecting
    ? intl.formatMessage({ id: "selfhost.network.webReconnecting" })
    : host && cwd && !managing && sshStatus && sshStatus !== "connected"
      ? intl.formatMessage({ id: hostConnectionMessages[sshStatus] }, { host: host.name })
      : catalogIssue || null;
  const connectionNotice = noticeMessage && (
    <div className="pointer-events-none fixed inset-x-3 top-[max(0.5rem,env(safe-area-inset-top))] z-40 mx-auto flex w-fit max-w-[calc(100%_-_1.5rem)] flex-wrap items-center gap-2 rounded-lg border border-border bg-popover px-3 py-2 text-ui-sm text-popover-foreground shadow-sm">
      <div className="min-w-0 break-words" role="status">
        <p>{noticeMessage}</p>
        {!webReconnecting && !managing && sshStatus === "failed" && sshConnection?.message ? (
          <p className="max-w-lg text-ui-xs text-foreground-subtle">
            {sshConnection.message.slice(0, 240)}
          </p>
        ) : null}
        {sshConnection?.sendFailed ? (
          <p>{intl.formatMessage({ id: "selfhost.network.sshActionFailed" })}</p>
        ) : null}
      </div>
      {host &&
      !managing &&
      !webReconnecting &&
      (sshStatus === "canceled" ||
        sshStatus === "failed" ||
        (sshStatus === "mfaRequired" && !sshConnection?.challenge)) ? (
        <Button
          type="button"
          size="sm"
          className="pointer-events-auto"
          data-testid="selfhost-ssh-connect"
          onClick={() => connectHost(host.id)}
        >
          {intl.formatMessage({ id: "selfhost.network.sshConnect" })}
        </Button>
      ) : null}
      {host && !managing && !webReconnecting && hostConnectionPending(sshStatus) ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="pointer-events-auto"
          data-testid="selfhost-ssh-cancel"
          onClick={() => cancelHostConnection(host.id)}
        >
          {intl.formatMessage({ id: "selfhost.ssh.cancelConnection" })}
        </Button>
      ) : null}
    </div>
  );
  const challengeHost =
    catalogTargetId !== null
      ? catalog?.hosts.find((candidate) => candidate.id === catalogTargetId)
      : managing || !cwd
        ? undefined
        : host;
  const challenge = challengeHost && hostConnections[challengeHost.id]?.challenge;
  const connectionFeedback = (
    <>
      {connectionNotice}
      {challengeHost && challenge && !webReconnecting ? (
        <HostMfaDialog
          key={`${workspaceKey(challengeHost, cwd)}:${challenge.revision}`}
          hostName={challengeHost.name}
          challenge={challenge}
          onRespond={(code) => respondToMfa(challenge, code)}
        />
      ) : null}
    </>
  );
  const withConnectionFeedback = (content: ReactNode) => (
    <>
      {content}
      {connectionFeedback}
    </>
  );
  if (error || (!catalog && catalogIssue))
    return withConnectionFeedback(
      <WebLoginPage
        local={{
          title: "连接工作区失败",
          description: error || catalogIssue,
          form: (
            <div className="flex gap-2">
              <Button
                onClick={() => {
                  setError("");
                  if (catalog) setWorkspaceAttempt((current) => current + 1);
                  else void refresh().catch(() => {});
                }}
              >
                重试
              </Button>
              <Button variant="outline" onClick={chooseHost}>
                选择主机
              </Button>
              <Button variant="ghost" onClick={logout}>
                退出
              </Button>
            </div>
          ),
        }}
      />,
    );
  if (!catalog || (host && cwd && !opened))
    return withConnectionFeedback(
      <WebLoginPage
        local={{
          title: "正在打开工作区",
          description: host?.name ?? "正在读取服务器配置…",
          form: null,
        }}
      />,
    );
  const renderCatalog = (modal: boolean) => (
    <Catalog
      gateway={gateway}
      hosts={catalog.hosts}
      connections={hostConnections}
      currentHostId={modal ? host?.id : undefined}
      refresh={refresh}
      logout={logout}
      account={account}
      select={select}
      onConnecting={setCatalogTargetId}
      cancelConnection={cancelHostConnection}
      onClose={
        modal
          ? () => {
              setCatalogTargetId(null);
              setManaging(false);
            }
          : undefined
      }
    />
  );
  if (!host || !cwd || !opened) return withConnectionFeedback(renderCatalog(false));
  const services = opened.services;
  const switcher: NonNullable<Parameters<typeof Root>[0]["webRemoteControlWorkspaceSwitcher"]> = {
    deviceNavigation: { deviceName: host.name, chooseOtherDevice: manage },
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
      connectHost(host.id);
    },
  };
  return withConnectionFeedback(
    <ZCodeIntlProvider
      settingService={services.settingService}
      broadcastService={services.broadcastService}
    >
      <Root
        key={identity + " " + (thread ?? "")}
        initialWebRemoteControlMobileNavigationIntent={mobile && thread ? "chat" : undefined}
        webRemoteControlWorkspaceSwitcher={mobile ? switcher : undefined}
        services={services}
        platform={platform}
        initialWorkspaceAbsPath={cwd}
        onOpenProjectDraft={openProjectDraft}
        initialTaskDraft={draftHandoff?.identity === identity ? draftHandoff?.draft : undefined}
        initialTaskId={thread}
        composerClientNamespace={"ssh:" + host.id + ":" + cwd}
        restoreSession={false}
        allowOpenWorkspace={false}
        allowRemoteWorkspace={false}
        preferDirectoryBrowser
        supportsEmbeddedBrowser={false}
        webRemoteControlFeatureEnabled={false}
      />
      {managing ? renderCatalog(true) : null}
    </ZCodeIntlProvider>,
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
  const [accountOpen, setAccountOpen] = useState(false);
  const showAccount = useCallback(() => setAccountOpen(true), []);
  const logout = useCallback(() => {
    // 旧请求可能在新登录后才收到 401；只清理发起该请求的令牌。
    if (localStorage.getItem(tokenKey) === token) localStorage.removeItem(tokenKey);
    setToken((current) => (current === token ? "" : current));
    setAccountOpen(false);
  }, [token]);
  const gateway = useMemo(() => (token ? new Gateway(token, logout) : null), [token, logout]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === tokenKey) {
        setToken(event.newValue ?? "");
        setAccountOpen(false);
      }
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  const endSession = useCallback(() => {
    if (gateway) void gateway.request("/api/auth/logout", z.unknown(), "POST").then(logout, logout);
  }, [gateway, logout]);
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
    <>
      <Workbench gateway={gateway} logout={endSession} account={showAccount} />
      {accountOpen && (
        <AccountSettings gateway={gateway} close={() => setAccountOpen(false)} signOut={logout} />
      )}
    </>
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
