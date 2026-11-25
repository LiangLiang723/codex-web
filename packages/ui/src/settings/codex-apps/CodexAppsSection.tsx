import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CodexApp, CodexAppDetails } from "@zcode/shared";
import type { ICodexAppsService } from "@zcode/shared";
import { useCodexAppsDirectory } from "./useCodexAppsDirectory.js";
import type { AppDetailsProps } from "./contract.js";
import { ArrowLeft, Cable, ExternalLink, RefreshCw } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { buildCodexAppMention } from "@/mentions/mentionMarkdown.js";
import { SegmentPill } from "../PluginStoreListView.js";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { PluginIcon } from "@/components/PluginIcon.js";
import { SettingsSearchInput } from "../SettingsSearchInput.js";
import { SettingsResourceGroupHeader, SettingsResourceList } from "../SettingsResourceGroup.js";

type DetailsState = { data: CodexAppDetails | null; busy: boolean; issue: string };
function mayUseApp(app: CodexApp) {
  return (
    app.callable === true ||
    // 只有缺少运行快照的旧协议才按可访问和启用推断。已知未安装的目录项不能预填。
    (app.installed === null && app.callable === null && app.accessible === true && app.enabled === true)
  );
}
function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function useAppDetails(service: ICodexAppsService, id: string) {
  const [state, setState] = useState<DetailsState>({ data: null, busy: true, issue: "" });
  const { current: requests } = useRef({ generation: 0 });
  const refresh = useCallback(async () => {
    const generation = ++requests.generation;
    setState((current) => ({ ...current, busy: true, issue: "" }));
    try {
      const data = await service.detail(id);
      if (requests.generation === generation) setState({ data, busy: false, issue: "" });
    } catch (error) {
      if (requests.generation === generation)
        setState((current) => ({ ...current, busy: false, issue: errorText(error) }));
    }
  }, [service, id, requests]);
  useEffect(() => {
    void refresh();
    return () => {
      requests.generation++;
    };
  }, [refresh, requests]);
  return { ...state, refresh };
}

function AppDetails({
  app,
  service,
  back,
  refreshApps,
  openingConnection,
  startDraft,
}: AppDetailsProps) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const { data, busy, issue, refresh } = useAppDetails(service, app.id);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const change = async (name: string, on: boolean) => {
    setPending(name);
    setNotice("");
    try {
      const result = await service.setEnabled(app.id, on, name);
      if (result.overridden) setNotice(result.message || t("settings.codexApps.overridden"));
      await Promise.all([refresh(), refreshApps()]);
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setPending(null);
    }
  };
  const plugins = data?.plugins.length ? data.plugins : app.plugins;
  const connectUrl = data?.installUrl ?? app.installUrl;
  const status = (value: boolean | null, yes: string, no: string) =>
    t("settings.codexApps." + (value === null ? "unknown" : value ? yes : no));
  const facts = [
    ["account", status(app.accessible ?? data?.accessible ?? null, "accessible", "inaccessible")],
    ["installation", status(app.installed, "installed", "notInstalled")],
    ["configuration", status(app.enabled, "enabled", "disabled")],
    ["runtime", status(app.callable, "callable", "notCallable")],
  ];
  return (
    <div className="min-w-0 space-y-4">
      <Button variant="ghost" onClick={back}>
        <ArrowLeft />
        {t("settings.codexApps.back")}
      </Button>
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 break-words text-lg font-semibold">
          <PluginIcon
            src={data?.iconUrl ?? app.iconUrl ?? undefined}
            className="size-9"
            fallbackIcon={<Cable className="size-4" />}
          />
          {data?.name || app.name}
        </h3>
        {(data?.description || app.description) && (
          <p className="break-words text-ui-sm text-foreground-muted">
            {data?.description || app.description}
          </p>
        )}
        {plugins.length > 0 && (
          <p className="text-ui-sm text-foreground-muted">
            {t("settings.plugins.title")} · {plugins.join(" · ")}
          </p>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl bg-surface px-4 py-3">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt className="text-ui-sm text-foreground-muted">{t("settings.codexApps." + label)}</dt>
            <dd className="text-ui-base text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
      {startDraft && mayUseApp(app) && (
        <Button onClick={() => startDraft({ ...app, name: data?.name || app.name })}>
          {t("settings.codexApps.useInChat")}
        </Button>
      )}
      {connectUrl && (
        <a
          className="inline-flex items-center gap-1 text-ui-base text-primary underline"
          href={connectUrl}
          onClick={openingConnection}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t("settings.codexApps.manageConnection")}
          <ExternalLink className="size-3.5" />
        </a>
      )}
      {notice && (
        <p role="status" className="text-ui-sm text-foreground-muted">
          {notice}
        </p>
      )}
      {(issue || data?.configIssue) && (
        <div role="alert">
          {issue || data?.configIssue}{" "}
          <Button variant="ghost" onClick={() => void refresh()}>
            {t("common.retry")}
          </Button>
        </div>
      )}
      {data?.tools && (
        <SettingsResourceGroupHeader
          title={t("settings.codexApps.tools")}
          count={data.tools.length}
        />
      )}
      {data?.tools?.length === 0 && (
        <p className="text-ui-sm text-foreground-muted">{t("settings.codexApps.noTools")}</p>
      )}
      {busy && !data && <p role="status">{t("common.loading")}</p>}
      {data?.tools === null && (
        <p role="status" className="text-ui-sm text-foreground-muted">
          {t("settings.codexApps.unknownTools")}
        </p>
      )}
      <SettingsResourceList
        items={data?.tools ?? []}
        getKey={(item) => item.name}
        renderItem={(tool) => (
          <div className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="break-words text-ui-base font-medium">{tool.title || tool.name}</div>
              {tool.description && (
                <p className="break-words text-ui-sm text-foreground-muted">{tool.description}</p>
              )}
              {tool.readOnly === true && (
                <span className="text-ui-sm text-foreground-subtle">
                  {t("settings.codexApps.readOnly")}
                </span>
              )}
              {tool.disabledReason && (
                <p className="text-ui-sm text-foreground-muted">{tool.disabledReason}</p>
              )}
            </div>
            {tool.enabled !== null && (
              <Switch
                checked={tool.enabled}
                disabled={pending !== null || busy || tool.configurable === false}
                aria-label={tool.title || tool.name}
                onCheckedChange={(value) => void change(tool.name, value)}
              />
            )}
          </div>
        )}
      />
    </div>
  );
}

interface CollectionProps {
  service: ICodexAppsService;
  installedOnly: boolean;
  onScopeChange: (installed: boolean) => void;
  startDraft?: (app: CodexApp) => void;
}
function AppManager({ service, installedOnly, onScopeChange, startDraft }: CollectionProps) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const { data, busy, issue, refresh, more } = useCodexAppsDirectory(service, installedOnly);
  const [query, setQuery] = useState(""),
    [limit, setLimit] = useState(50);
  const [active, setActive] = useState<string | null>(null),
    [pending, setPending] = useState<string | null>(null),
    [notice, setNotice] = useState("");
  const awaitingConnection = useRef(false);
  const openingConnection = () => {
    awaitingConnection.current = true;
  };
  useEffect(() => {
    const onReturn = () => {
      if (document.hidden || !awaitingConnection.current) return;
      awaitingConnection.current = false;
      void refresh(true);
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [refresh]);
  const selected = data?.apps.find((item) => item.id === active);
  const rows = useMemo(() => {
    const term = query.trim().toLowerCase();
    return (data?.apps ?? [])
      .filter(
        (app) =>
          !term ||
          [app.name, app.id, ...app.plugins].some((value) => value.toLowerCase().includes(term)),
      )
      .sort(
        (a, b) =>
          Number(b.installed === true) - Number(a.installed === true) ||
          Number(b.accessible === true) - Number(a.accessible === true) ||
          a.name.localeCompare(b.name),
      );
  }, [data, query]);
  useEffect(() => {
    // 命中后交回用户选择；旧条件会继续把五千余项目录翻完，导致开关一直忙碌。
    if (!active && query.trim() && rows.length === 0 && data?.nextCursor && !busy && !issue) {
      void more();
    }
  }, [active, query, rows.length, data?.nextCursor, busy, issue, more]);
  const change = async (app: CodexApp, on: boolean) => {
    setPending(app.id);
    setNotice("");
    try {
      const result = await service.setEnabled(app.id, on);
      if (result.overridden) setNotice(result.message || t("settings.codexApps.overridden"));
      await refresh(true);
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setPending(null);
    }
  };
  if (selected)
    return (
      <AppDetails
        key={JSON.stringify([
          selected.id,
          selected.installed,
          selected.accessible,
          selected.callable,
        ])}
        app={selected}
        service={service}
        back={() => setActive(null)}
        refreshApps={() => refresh(true)}
        openingConnection={openingConnection}
        startDraft={data?.runtimeIssue ? undefined : startDraft}
      />
    );
  return (
    <div className="min-w-0 space-y-3" data-testid="codex-app-settings">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          <SegmentPill
            active={installedOnly}
            onClick={() => onScopeChange(true)}
            testId="codex-apps-installed"
            label={t("settings.codexApps.installed")}
          />
          <SegmentPill
            active={!installedOnly}
            onClick={() => onScopeChange(false)}
            testId="codex-apps-browse"
            label={t("settings.codexApps.browse")}
          />
        </div>
        <SettingsSearchInput
          containerClassName="min-w-32 flex-1"
          aria-label={t("settings.codexApps.search")}
          placeholder={t("settings.codexApps.search")}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setLimit(50);
          }}
          onClear={() => setQuery("")}
        />
        <Button variant="outline" disabled={busy} onClick={() => void refresh(true)}>
          <RefreshCw />
          {t("common.refresh")}
        </Button>
      </div>
      {busy && (!data || (query && rows.length === 0)) && (
        <p role="status">{t("common.loading")}</p>
      )}
      {(issue || data?.directoryIssue || data?.runtimeIssue) && (
        <p role="alert" className="break-words text-ui-sm text-foreground-muted">
          {[issue, data?.directoryIssue, data?.runtimeIssue].filter(Boolean).join(" · ")}
        </p>
      )}
      {notice && (
        <p role="status" className="text-ui-sm text-foreground-muted">
          {notice}
        </p>
      )}
      {data?.emptyReason && !busy && (
        <div className="space-y-2 rounded-xl bg-surface p-4" role="status">
          <p>
            {t(
              data.emptyReason === "disabled"
                ? "settings.codexApps.featureDisabled"
                : "settings.codexApps.loginRequired",
            )}
          </p>
          <code className="select-all text-ui-sm">
            {data.emptyReason === "disabled"
              ? "codex features enable apps"
              : "codex login --device-auth"}
          </code>
        </div>
      )}
      {data && !data.emptyReason && !rows.length && !busy && !data.nextCursor && (
        <p className="py-6 text-center text-ui-sm text-foreground-muted">
          {t(
            query
              ? "settings.codexApps.noMatches"
              : installedOnly
                ? "settings.codexApps.emptyInstalled"
                : "settings.codexApps.empty",
          )}
        </p>
      )}
      <SettingsResourceList
        items={rows.slice(0, limit)}
        getKey={(item) => item.id}
        renderItem={(app) => {
          const canConfigure = app.accessible === true || app.installed === true;
          const flags = [
            app.installed === true ? t("settings.codexApps.installed") : null,
            app.accessible === false ? t("settings.codexApps.inaccessible") : null,
            app.callable === null
              ? null
              : t(app.callable ? "settings.codexApps.callable" : "settings.codexApps.notCallable"),
          ].filter(Boolean);
          return (
            <div data-testid={`codex-app-${app.id}`} className="flex items-center gap-3 px-4 py-3">
              <PluginIcon
                src={app.iconUrl ?? undefined}
                fallbackIcon={<Cable className="size-4" />}
                className="size-8 shrink-0"
              />
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  className="block max-w-full truncate text-left text-ui-base font-medium hover:underline"
                  onClick={() => setActive(app.id)}
                >
                  {app.name}
                </button>
                <div className="line-clamp-2 text-ui-sm text-foreground-muted">
                  {flags.join(" · ") || app.description}
                </div>
              </div>
              {startDraft && !data?.runtimeIssue && mayUseApp(app) && (
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label={intl.formatMessage(
                    { id: "settings.codexApps.useApp" },
                    { app: app.name },
                  )}
                  onClick={() => startDraft(app)}
                >
                  {t("settings.codexApps.use")}
                </Button>
              )}
              {canConfigure && app.enabled !== null ? (
                <Switch
                  checked={app.enabled}
                  disabled={pending !== null || busy}
                  aria-label={app.name}
                  onCheckedChange={(value) => void change(app, value)}
                />
              ) : app.installUrl ? (
                <a
                  className="shrink-0 text-ui-sm text-primary underline"
                  href={app.installUrl}
                  onClick={openingConnection}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("settings.codexApps.viewConnection")}
                </a>
              ) : null}
            </div>
          );
        }}
      />
      {(rows.length > limit || data?.nextCursor) && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            if (rows.length <= limit) void more();
            setLimit((count) => count + 50);
          }}
        >
          {t("settings.codexApps.showMore")}
        </Button>
      )}
    </div>
  );
}

export function CodexAppsSection({
  onCreateTask,
}: {
  onCreateTask?: (request?: CreateTaskRequest) => void;
}) {
  const { codexAppsService } = useServices();
  const [installedOnly, setInstalledOnly] = useState(true);
  const startDraft =
    onCreateTask &&
    ((app: CodexApp) => {
      const mention = buildCodexAppMention(app);
      onCreateTask({ initialPrompt: `${mention.markdown} `, initialPromptMention: mention });
    });
  return codexAppsService ? (
    <AppManager
      key={String(installedOnly)}
      service={codexAppsService}
      installedOnly={installedOnly}
      onScopeChange={setInstalledOnly}
      startDraft={startDraft}
    />
  ) : null;
}
