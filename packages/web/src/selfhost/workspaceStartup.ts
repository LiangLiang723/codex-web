import { readWorkspaceSettings, type Gateway } from "./gateway.js";

interface StartupReads {
  route: string;
  catalog?: ReturnType<Gateway["config"]>;
  preferences?: ReturnType<typeof readWorkspaceSettings>;
}

export function prepareWorkspaceStartup(gateway: Gateway, route: string) {
  const controller = new AbortController();
  const query = new URLSearchParams(route);
  let pending: StartupReads | undefined = {
    route,
    catalog: gateway.config(controller.signal),
    preferences:
      !route || (query.has("host") && query.get("cwd"))
        ? readWorkspaceSettings(gateway, controller.signal)
        : undefined,
  };
  void pending.catalog?.catch(() => {});
  void pending.preferences?.catch(() => {
    if (pending) pending.preferences = undefined;
  });

  // 工作台模块尚在加载时也接收目录变动。交接之后由工作台处理后续事件。
  const unsubscribe = gateway.on(({ type }) => {
    if (pending && (type === "config.catalog.changed" || type === "disconnected")) {
      pending.catalog = undefined;
    }
  });
  void gateway.connect().catch(() => {});

  return {
    gateway,
    take() {
      const reads = pending;
      pending = undefined;
      unsubscribe();
      return reads;
    },
    dispose() {
      pending = undefined;
      unsubscribe();
      controller.abort();
    },
  };
}

export type WorkspaceStartup = ReturnType<typeof prepareWorkspaceStartup>;
