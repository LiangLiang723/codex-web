import "./bootstrap.js";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { createRoot } from "react-dom/client";
import { AppErrorBoundary } from "@zcode/ui/error-boundary";
import { ZCodeAppLogo } from "@zcode/ui/app-logo";
import { Button } from "@zcode/ui/button";
import { Input } from "@zcode/ui/input";
import { applyTheme, resolveTheme, type Theme } from "@zcode/ui/useTheme";
import { z } from "zod";
import { WebLoginPage } from "../auth/index.js";
import { Gateway, accountProfileSchema, type AccountProfile } from "./gateway.js";
import { flushBrowserState, openAccountBrowserState } from "./browserState.js";
import { prepareWorkspaceStartup, type WorkspaceStartup } from "./workspaceStartup.js";
import "../styles.css";

const tokenKey = "selfhost.auth";
const restoredToken = localStorage.getItem(tokenKey) || "";
const loadWorkspaceLocale = () =>
  import("@zcode/ui/i18n")
    .then(({ preloadPreferredLocaleMessages }) => preloadPreferredLocaleMessages())
    .catch(() => {});
let workbenchModule: Promise<typeof import("./Workbench.js")> | undefined;
const loadWorkbench = () =>
  (workbenchModule ??= Promise.all([import("./Workbench.js"), loadWorkspaceLocale()]).then(
    ([route]) => route,
  ));
const loadPrivateShare = () => import("./PrivateShare.js");
const Workbench = lazy(loadWorkbench);
const PrivateShare = lazy(loadPrivateShare);
const AccountSettings = lazy(() =>
  import("./AccountSettings.js").then(({ AccountSettingsRoute }) => ({
    default: AccountSettingsRoute,
  })),
);

const loadingWorkspace = (
  <div className="zcode-boot-loading" role="status" aria-busy="true" aria-label="Loading…">
    <span className="zcode-boot-loading__mark" aria-hidden="true">
      <ZCodeAppLogo className="size-full" animated />
    </span>
  </div>
);

function removeStartupScreen() {
  document.getElementById("zcode-boot-screen")?.remove();
}

function applyStartupTheme(storage: Storage) {
  const saved = storage.getItem("zcode-theme");
  const theme: Theme =
    saved === "system" || saved === "light" || saved === "dark" ||
    saved === "zai-light" || saved === "zai-dark" ? saved : "zai-dark";
  document.documentElement.dataset.zcodeBootstrapTheme = resolveTheme(theme);
  applyTheme(theme);
}

function BrowserStateFailure({ boot, retry }: { boot: boolean; retry: () => void }) {
  const chinese = (boot ? navigator.language : document.documentElement.lang).startsWith("zh");
  const message = boot
    ? chinese ? "读取账号设置失败" : "Could not load account settings"
    : chinese ? "账号设置或草稿尚未保存" : "Account settings or drafts are unsaved";
  return (
    <div className="fixed inset-x-3 top-3 z-50 mx-auto flex w-fit items-center gap-3 rounded-lg border border-border bg-popover p-3 text-ui-sm text-popover-foreground shadow-sm" role="alert">
      {message}
      <Button size="sm" variant="outline" data-testid="selfhost-browser-state-retry" onClick={retry}>
        {chinese ? "重试" : "Retry"}
      </Button>
    </div>
  );
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
        description: "使用网页账号登录 Codex 工作区。",
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
function App() {
  const [token, setToken] = useState(restoredToken);
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountResult, setAccountResult] = useState<{
    gateway: Gateway;
    profile?: AccountProfile;
    error?: string;
  }>();
  const showAccount = useCallback(() => setAccountOpen(true), []);
  const logout = useCallback(() => {
    // 旧请求可能在新登录后才收到 401；只清理发起该请求的令牌。
    const stored = localStorage.getItem(tokenKey);
    if (stored === token) {
      localStorage.removeItem(tokenKey);
      // 共享工作台含模块级草稿与恢复线索，登录切换时清除原账号的页面内存。
      location.reload();
    } else if (!stored) {
      setToken((current) => current === token ? "" : current);
    }
  }, [token]);
  const gateway = useMemo(() => (token ? new Gateway(token, logout) : null), [token, logout]);
  const share = new URLSearchParams(location.search).get("share");
  const [browserState, setBrowserState] = useState<{
    gateway: Gateway;
    startup?: WorkspaceStartup;
    failed?: boolean;
  }>();
  const [saveFailed, setSaveFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  useLayoutEffect(() => {
    if (!gateway) removeStartupScreen();
  }, [gateway]);
  useEffect(() => {
    if (!gateway) return;
    const controller = new AbortController();
    // 目录与账号状态并行读取。草稿和待确认投递在工作台模块加载时读取已装配的存储。
    const startup = share ? undefined : prepareWorkspaceStartup(gateway, location.search);
    void openAccountBrowserState(gateway, token === restoredToken, controller.signal, setSaveFailed).then(
      (storage) => {
        if (controller.signal.aborted) return;
        // 新账号初始化后才广播令牌，其他标签页不会用新令牌认领旧账号的浏览器数据。
        if (token !== restoredToken) localStorage.setItem(tokenKey, token);
        applyStartupTheme(storage);
        setBrowserState({ gateway, startup });
        const loadRoute = share ? loadPrivateShare : loadWorkbench;
        void loadRoute().then(removeStartupScreen, removeStartupScreen);
      },
      () => {
        if (controller.signal.aborted) return;
        removeStartupScreen();
        setBrowserState({ gateway, failed: true });
      },
    );
    return () => {
      startup?.dispose();
      controller.abort();
    };
  }, [gateway, loadAttempt, share, token]);

  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === tokenKey) {
        location.reload();
      }
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  const endSession = useCallback(async () => {
    if (!gateway) return;
    await flushBrowserState(gateway)?.catch(() => {});
    await gateway.request("/api/auth/logout", z.unknown(), "POST").then(logout, logout);
  }, [gateway, logout]);
  useEffect(() => {
    if (!gateway) return;
    const controller = new AbortController();
    void gateway
      .request(
        "/api/auth/me",
        z.object({ user: accountProfileSchema }),
        "GET",
        undefined,
        controller.signal,
      )
      .then(
        ({ user }) => {
          if (!controller.signal.aborted) setAccountResult({ gateway, profile: user });
        },
        (error: Error) => {
          if (!controller.signal.aborted) setAccountResult({ gateway, error: error.message });
        },
      );
    return () => {
      controller.abort();
      gateway.close();
    };
  }, [gateway]);
  const currentAccount = accountResult?.gateway === gateway ? accountResult : undefined;
  if (gateway && (browserState?.gateway !== gateway || browserState.failed)) {
    if (browserState?.gateway !== gateway) return loadingWorkspace;
    return <BrowserStateFailure boot retry={() => {
      setBrowserState(undefined);
      setLoadAttempt((attempt) => attempt + 1);
    }} />;
  }
  const persistenceNotice = gateway && saveFailed ? (
    <BrowserStateFailure boot={false} retry={() => { void flushBrowserState(gateway)?.catch(() => {}); }} />
  ) : null;
  if (gateway && share) {
    return (
      <Suspense fallback={loadingWorkspace}>
        <PrivateShare gateway={gateway} id={share} fallback={loadingWorkspace} />
        {persistenceNotice}
      </Suspense>
    );
  }
  return gateway ? (
    <>
      {persistenceNotice}
      <Suspense fallback={loadingWorkspace}>
        {browserState?.startup ? (
          <Workbench
            gateway={gateway}
            startup={browserState.startup}
            logout={endSession}
            account={showAccount}
            profile={currentAccount?.profile}
            fallback={loadingWorkspace}
          />
        ) : (
          loadingWorkspace
        )}
      </Suspense>
      {accountOpen && (
        <Suspense fallback={null}>
          <AccountSettings
            gateway={gateway}
            profile={currentAccount?.profile}
            loadError={currentAccount?.error}
            onAvatarSaved={(avatar) => {
              setAccountResult((current) =>
                current?.gateway === gateway && current.profile
                  ? { gateway, profile: { ...current.profile, avatar } }
                  : current,
              );
            }}
            close={() => setAccountOpen(false)}
            signOut={logout}
          />
        </Suspense>
      )}
    </>
  ) : (
    <Login onLogin={setToken} />
  );
}

createRoot(document.getElementById("zcode-web-app")!).render(
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>,
);
