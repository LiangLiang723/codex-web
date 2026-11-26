import "@fortawesome/fontawesome-free/css/all.min.css";
import { useCallback, useEffect, useMemo, useState, useRef, type ReactNode } from "react";
import { Root, ZCodeIntlProvider, useZCodeIntl, Button } from "@zcode/ui";
import { z } from "zod";
import { createWebPlatform } from "#src/platform/index.js";
import { WebLoginPage } from "../auth/index.js";
import { Catalog } from "./Catalog.js";
import { type Gateway, type AccountProfile, type Host, type Project } from "./gateway.js";
import {
  hostConnectionMessages,
  hostConnectionPending,
  HostMfaDialog,
  useHostConnections,
} from "./HostConnection.js";
import { openWorkspace, readWorkspaceSettings } from "./services.js";

type WorkspaceDraft = NonNullable<Parameters<typeof Root>[0]["initialTaskDraft"]>;
type DraftHandoff = { identity: string; draft: WorkspaceDraft };
const lastProjectSchema = z.object({ hostId: z.number(), cwd: z.string() });

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

function Workbench({
  gateway,
  logout,
  account,
  profile,
  fallback,
}: {
  gateway: Gateway;
  logout: () => void;
  account: () => void;
  profile?: AccountProfile;
  fallback: ReactNode;
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
  const startupSettings = useRef<{
    gateway: Gateway;
    navigation: number;
    result: ReturnType<typeof readWorkspaceSettings>;
  } | null>(null);
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
    let disposed = false;
    let disconnected = false;
    const initialRoute = new URLSearchParams(location.search);
    if (!location.search || (initialRoute.has("host") && initialRoute.get("cwd"))) {
      const result = readWorkspaceSettings(gateway);
      startupSettings.current = { gateway, navigation: navigationVersion.current, result };
      void result.catch(() => {
        // 弱网导致首次读取失败时，后续导航或重试应重新读取。
        if (startupSettings.current?.result === result) startupSettings.current = null;
      });
    }
    const initialCatalog = refresh();
    void initialCatalog.catch(() => {});
    const off = gateway.on((message) => {
      if (message.type === "config.catalog.changed") void refresh().catch(() => {});
      else if (message.type === "disconnected") {
        disconnected = true;
        setWebReconnecting(true);
      } else if (message.type === "ready") {
        setWebReconnecting(false);
        if (disconnected) {
          disconnected = false;
          void refresh().catch(() => {});
        } else {
          // 首次连接和 HTTP 目录读取同时开始，成功时复用这次读取。
          void initialCatalog.catch(() => {
            if (!disposed) void refresh().catch(() => {});
          });
        }
        void gateway.send({ type: "host.lifecycle.subscribe" }).catch(() => {});
      }
    });
    // 已打开的工作区应在实时连接恢复时继续使用原会话。
    void gateway.connect().catch(() => {});
    return () => {
      disposed = true;
      if (startupSettings.current?.gateway === gateway) startupSettings.current = null;
      catalogReads.generation++;
      off();
    };
  }, [gateway, refresh, catalogReads]);
  useEffect(() => {
    if (route || !catalog) return;
    let canceled = false;
    const navigation = navigationVersion.current;
    const initial = startupSettings.current;
    const result =
      initial?.gateway === gateway && initial.navigation === navigation
        ? initial.result
        : readWorkspaceSettings(gateway);
    void result
      .then((settings) => {
        if (canceled || navigationVersion.current !== navigation) return;
        const last = lastProjectSchema.safeParse(settings.selfhostLastProject);
        if (
          last.success &&
          catalog.projects.some(
            (project) =>
              project.hostId === last.data.hostId && project.remotePath === last.data.cwd,
          )
        ) {
          navigate(new URLSearchParams({ host: String(last.data.hostId), cwd: last.data.cwd }));
          // 把这次读取交给刚恢复的路由。手动导航有自己的世代。
          startupSettings.current = { gateway, navigation: navigationVersion.current, result };
        } else if (startupSettings.current === initial) {
          startupSettings.current = null;
        }
      })
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, [route, catalog, gateway, navigate]);
  useEffect(() => {
    let active = true;
    let resource: Awaited<ReturnType<typeof openWorkspace>> | undefined;
    setMounted(null);
    if (selectedId !== undefined && identity && cwd) {
      const initial = startupSettings.current;
      const preferences =
        initial?.gateway === gateway && initial.navigation === navigationVersion.current
          ? initial.result
          : undefined;
      if (preferences) startupSettings.current = null;
      void openWorkspace(
        gateway,
        selectedId,
        cwd,
        manage,
        (threadId) => {
          const current = new URLSearchParams(location.search);
          if (
            !active ||
            Number(current.get("host")) !== selectedId ||
            current.get("thread") !== threadId
          )
            return;
          current.delete("thread");
          navigationVersion.current++;
          history.replaceState({}, "", location.pathname + "?" + current);
          setRoute(location.search);
        },
        preferences,
      ).then(
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
              profile: profile
                ? { username: profile.username, avatarUrl: profile.avatar ?? undefined }
                : undefined,
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
    [selectedId, selectedName, selectedAvatar, navigate, manage, account, logout, profile],
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
      fallback={fallback}
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

export default function WorkspaceRoute(props: Parameters<typeof Workbench>[0]) {
  return (
    <ZCodeIntlProvider fallback={props.fallback}>
      <Workbench {...props} />
    </ZCodeIntlProvider>
  );
}
