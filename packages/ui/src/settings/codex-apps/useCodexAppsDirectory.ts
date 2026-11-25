import { useCallback, useEffect, useRef, useState } from "react";
import type { CodexAppsList, ICodexAppsService } from "@zcode/shared";

export function useCodexAppsDirectory(service: ICodexAppsService, installedOnly: boolean) {
  const [data, setData] = useState<CodexAppsList | null>(null);
  const [busy, setBusy] = useState(false),
    [issue, setIssue] = useState("");
  const { current: requests } = useRef({
    generation: 0,
    seen: new Set<string>(),
    inFlight: false,
    next: null as string | null,
  });
  const load = useCallback(
    async (force: boolean, append: boolean) => {
      if (append && (!requests.next || requests.inFlight)) return;
      const cursor = append ? (requests.next ?? undefined) : undefined;
      if (!append) {
        requests.generation++;
        requests.seen.clear();
      }
      const generation = requests.generation;
      requests.inFlight = true;
      setBusy(true);
      setIssue("");
      try {
        const page = installedOnly
          ? await service.listInstalled(force)
          : await service.list(force, cursor);
        if (requests.generation !== generation) return;
        if (cursor) requests.seen.add(cursor);
        if (page.nextCursor && requests.seen.has(page.nextCursor))
          throw Error("Codex returned a repeated app cursor");
        requests.next = page.nextCursor;
        setData((previous) => {
          if (!append || !previous) return page;
          const merged = new Map(previous.apps.map((app) => [app.id, app]));
          for (const app of page.apps) {
            const known = merged.get(app.id);
            // 运行态字段来自首屏的 app/installed；后续目录元数据不能覆盖其有效状态。
            merged.set(app.id, {
              ...app,
              installed: known?.installed ?? (previous.runtimeKnown ? false : null),
              callable: known?.callable ?? app.callable,
              enabled: known?.installed ? known.enabled : app.enabled,
            });
          }
          return {
            ...previous,
            apps: [...merged.values()],
            nextCursor: page.nextCursor,
            directoryIssue: page.directoryIssue ?? previous.directoryIssue,
          };
        });
      } catch (error) {
        if (requests.generation === generation) {
          setIssue(error instanceof Error ? error.message : String(error));
          // 目录页读取失败等用户重试，避免正在输入搜索词时循环请求同一游标。
          if (!append) requests.next = null;
        }
      } finally {
        if (requests.generation === generation) {
          requests.inFlight = false;
          setBusy(false);
        }
      }
    },
    [installedOnly, requests, service],
  );
  const refresh = useCallback((force: boolean) => load(force, false), [load]);
  const more = useCallback(() => load(false, true), [load]);
  useEffect(() => {
    void refresh(false);
    return () => {
      requests.generation++;
    };
  }, [refresh, requests]);
  return { data, busy, issue, refresh, more };
}
