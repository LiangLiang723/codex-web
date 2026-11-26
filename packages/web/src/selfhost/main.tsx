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
import { Button } from "@zcode/ui/button";
import { Input } from "@zcode/ui/input";
import { z } from "zod";
import { WebLoginPage } from "../auth/index.js";
import { Gateway, accountProfileSchema, type AccountProfile } from "./gateway.js";
import { prepareWorkspaceStartup, type WorkspaceStartup } from "./workspaceStartup.js";
import "../styles.css";

const tokenKey = "selfhost.auth";
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
      <span className="zcode-boot-loading__logo" />
    </span>
  </div>
);

function removeStartupScreen() {
  document.getElementById("zcode-boot-screen")?.remove();
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
  const [token, setToken] = useState(() => localStorage.getItem(tokenKey) || "");
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountResult, setAccountResult] = useState<{
    gateway: Gateway;
    profile?: AccountProfile;
    error?: string;
  }>();
  const showAccount = useCallback(() => setAccountOpen(true), []);
  const logout = useCallback(() => {
    // 旧请求可能在新登录后才收到 401；只清理发起该请求的令牌。
    if (localStorage.getItem(tokenKey) === token) localStorage.removeItem(tokenKey);
    setToken((current) => (current === token ? "" : current));
    setAccountOpen(false);
  }, [token]);
  const gateway = useMemo(() => (token ? new Gateway(token, logout) : null), [token, logout]);
  const share = new URLSearchParams(location.search).get("share");
  const [workspaceStartup, setWorkspaceStartup] = useState<WorkspaceStartup>();
  useLayoutEffect(() => {
    if (!gateway) removeStartupScreen();
  }, [gateway]);
  useEffect(() => {
    if (!gateway || share) return;
    // 路由模块和词典尚在加载时，当前登录已可并行读取启动数据。
    const startup = prepareWorkspaceStartup(gateway, location.search);
    void loadWorkbench().catch(() => {});
    setWorkspaceStartup(startup);
    return () => startup.dispose();
  }, [gateway, share]);

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
  if (gateway && share) {
    return (
      <Suspense fallback={loadingWorkspace}>
        <PrivateShare gateway={gateway} id={share} fallback={loadingWorkspace} />
      </Suspense>
    );
  }
  return gateway ? (
    <>
      <Suspense fallback={loadingWorkspace}>
        {workspaceStartup?.gateway === gateway ? (
          <Workbench
            gateway={gateway}
            startup={workspaceStartup}
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
    <Login
      onLogin={(value) => {
        localStorage.setItem(tokenKey, value);
        setToken(value);
      }}
    />
  );
}
// 首次 React 提交先发出已认证请求，HTML 启动壳继续播放到路由资源准备完成。
if (localStorage.getItem(tokenKey)) {
  const share = new URLSearchParams(location.search).get("share");
  const loadRoute = share ? loadPrivateShare : loadWorkbench;
  void loadRoute().then(removeStartupScreen, removeStartupScreen);
}

createRoot(document.getElementById("zcode-web-app")!).render(
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>,
);
