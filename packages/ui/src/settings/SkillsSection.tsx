/* eslint-disable max-lines -- 技能管理面板需共享筛选、安装与开关交互状态，集中维护更便于一致性 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Import,
  Plus,
  Trash2,
  UploadCloud,
  WandSparkles,
} from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { Switch } from "@/components/ui/switch.js";
import type {
  ZCodeProvider,
  SkillDiagnosticCode,
  SkillSummary,
  SkillsListResult,
  RemoteTarget,
} from "@zcode/shared";
import type { IFileService, IServiceAccessor } from "@zcode/services";
import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import { selfHostedBuild } from "@zcode/shared/runtimeEnv";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useConfigWorkspaceServicesResolution as useWorkspaceServicesResolution } from "@/workspace-config-catalog/index.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { buildSkillMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import { filterSkillsForProvider } from "@/lib/skillSourceFilter.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { PluginStoreAvatar } from "@/settings/PluginStoreAvatar.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import {
  SettingsResourceGroupHeader,
  SettingsResourceList,
} from "@/settings/SettingsResourceGroup.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import {
  PluginInstallEmptyState,
  PluginLoadingState,
  PluginSearchEmptyState,
} from "@/settings/PluginInstallEmptyState.js";
import {
  resolvePluginDisplayName,
  resolveUniquePluginListingByName,
} from "@/settings/pluginStoreListing.js";
import { groupSkillsByPlugin } from "@/settings/pluginManagedResourceGroups.js";
import { SkillsImportDialog } from "@/settings/ExternalAgentImportDialog.js";
import {
  formatRemoteSyncTargetLabel,
  shouldShowRemoteSyncActions,
  useSettingsDataSyncEntry,
} from "@/data-sync/index.js";
import { refreshSharedSkillStoreForWorkspace } from "@/lib/skillStoreRefresh.js";
import { buildSourceSettingsProjectionKey } from "@/settings/settingsSourceWorkspace.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import {
  groupScopedSkillsBySource,
  selectPluginsForScope,
  selectSkillsForScope,
} from "@/settings/pluginCapabilityProjection.js";

const EMPTY_SKILL_LIST: Pick<SkillsListResult, "skills" | "diagnostics"> = {
  skills: [],
  diagnostics: [],
};

function getWorkspaceBasename(workspacePath: string | null): string {
  if (!workspacePath) return "";
  return workspacePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? workspacePath;
}

function formatSkillPublishedAt(timestamp: number | undefined): string | null {
  if (timestamp === undefined) {
    return null;
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

function SkillDetailField({
  label,
  value,
  mono = false,
  className = "",
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
  className?: string;
}) {
  if (!value) {
    return null;
  }
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="text-ui-base font-medium text-foreground">{label}</div>
      <div
        className={[
          "mt-1 break-words text-ui-base text-foreground-subtle",
          mono ? "break-all font-mono" : "",
        ].join(" ")}
      >
        {value}
      </div>
    </div>
  );
}

function SkillPathDetailField({
  label,
  path,
  openLabel,
  onOpen,
  openTestId,
  opening = false,
}: {
  label: string;
  path: string;
  openLabel: string;
  onOpen: () => void;
  openTestId?: string;
  opening?: boolean;
}) {
  return (
    <div className="min-w-0 col-span-2">
      <div className="text-ui-base font-medium text-foreground">{label}</div>
      <div className="mt-1">
        <Button
          type="button"
          variant="link"
          size="sm"
          aria-label={openLabel}
          data-testid={openTestId}
          disabled={opening}
          title={openLabel}
          className="inline-flex h-auto max-w-full items-baseline gap-1.5 whitespace-normal break-all px-0 py-0 text-left align-baseline font-mono text-ui-base font-normal text-foreground-subtle underline-offset-2 hover:text-foreground hover:underline"
          onClick={onOpen}
        >
          <span>{path}</span>
          <ExternalLink className="relative top-px size-3 shrink-0" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

function CodexSkillFilePreview({
  path,
  readTextFile,
}: {
  path: string;
  readTextFile: IFileService["readTextFile"];
}) {
  const { intl } = useZCodeIntl();
  const [preview, setPreview] = useState<
    | { kind: "loading" }
    | { kind: "ready"; content: string; truncated: boolean }
    | { kind: "error"; message: string }
    | null
  >(null);
  const openPreview = async () => {
    setPreview({ kind: "loading" });
    try {
      // Web 无法在浏览器本机打开 SSH 绝对路径，使用同一目标文件服务读取已发现的 SKILL.md。
      const { content, truncated, isBinary } = await readTextFile({ path, length: 256 * 1024 });
      if (isBinary) throw Error(intl.formatMessage({ id: "settings.skills.codexPreviewBinary" }));
      setPreview({ kind: "ready", content, truncated });
    } catch (error) {
      setPreview({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  return (
    <div className="col-span-2 min-w-0 space-y-3">
      <SkillPathDetailField
        label={intl.formatMessage({ id: "settings.skills.detail.path" })}
        path={path}
        openLabel={intl.formatMessage({ id: "settings.skills.detail.openPath" })}
        openTestId="native-skill-preview"
        opening={preview?.kind === "loading"}
        onOpen={() => void openPreview()}
      />
      {preview?.kind === "loading" ? (
        <p role="status" className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "common.loading" })}
        </p>
      ) : null}
      {preview?.kind === "error" ? (
        <div className="space-y-2">
          <p role="alert" className="break-words text-ui-sm text-destructive">
            {preview.message}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => void openPreview()}>
            {intl.formatMessage({ id: "common.retry" })}
          </Button>
        </div>
      ) : null}
      {preview?.kind === "ready" ? (
        <>
          <pre
            data-testid="native-skill-body"
            className="whitespace-pre-wrap break-words rounded-lg border border-border bg-surface p-3 font-mono text-ui-sm text-foreground"
          >
            {preview.content}
          </pre>
          {preview.truncated ? (
            <p className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "settings.skills.diagnostics.code.skill_too_large" })}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

interface SkillsSectionProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  isWebRemoteControl?: boolean;
  scopeFilter: "user" | "workspace";
  searchQuery: string;
  onVisibleCountChange?: (count: number) => void;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onDetailOpenChange?: (open: boolean) => void;
  onOpenPluginStore?: () => void;
  showMarketplaceBreadcrumb?: boolean;
  reportDetailBreadcrumb?: boolean;
  /** Scope 选中在线远端设备的「用户」时为该设备；同步按钮只在此时显示。 */
  dataSyncSourceServerId?: string | null;
  unscopedServices?: IServiceAccessor;
  cacheAuthorityKey?: string;
}

export function SkillsSection({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  remoteTarget,
  isWebRemoteControl = false,
  scopeFilter,
  searchQuery,
  onVisibleCountChange,
  onCreateTask,
  onDetailOpenChange,
  onOpenPluginStore,
  showMarketplaceBreadcrumb = false,
  reportDetailBreadcrumb = false,
  dataSyncSourceServerId,
  unscopedServices,
  cacheAuthorityKey,
}: SkillsSectionProps) {
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const plugins = usePluginManagementStore((state) => state.plugins);
  const installedPlugins = usePluginManagementStore((state) => state.installedPlugins);
  const availablePlugins = usePluginManagementStore((state) => state.availablePlugins);
  const pluginListingById = useMemo(
    () => new Map(availablePlugins.map((plugin) => [plugin.id, plugin.listing])),
    [availablePlugins],
  );
  const pluginWorkspacePath = usePluginManagementStore((state) => state.workspacePath);
  const pluginWorkspaceIdentity = usePluginManagementStore((state) => state.workspaceIdentity);
  const pluginConfigScope = usePluginManagementStore((state) => state.configScope);
  const initializePlugins = usePluginManagementStore((state) => state.initialize);
  const confirmDialog = useConfirmDialog();
  const activeWorkspacePath = workspacePath ?? null;
  const activeWorkspaceIdentity = workspaceIdentity;
  const targetServiceResolution = useWorkspaceServicesResolution(
    activeWorkspacePath,
    remoteSessionId,
    activeWorkspaceIdentity,
    remoteTarget,
    { unscopedServices, forceUnscoped: Boolean(cacheAuthorityKey || unscopedServices) },
  );
  // PluginsSection 已把 Scope target 传入，但 Skills 仍从当前 ServiceProvider
  // 取服务，导致跨远程 host 误路由。技能读写改用同一 target 解析结果。
  const { fileService, pluginManagementService, skillsService } = targetServiceResolution.services;
  const [listing, setListing] = useState<{ targetKey: string; result: SkillsListResult } | null>(
    null,
  );
  const [listFailure, setListFailure] = useState<{ targetKey: string; message: string } | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [writingSkill, setWritingSkill] = useState(false);
  const writingSkillRef = useRef(false);
  const query = searchQuery;
  const [selectedSkill, setSelectedSkill] = useState<SkillSummary | null>(null);
  useEffect(() => {
    onDetailOpenChange?.(selectedSkill !== null);
  }, [onDetailOpenChange, selectedSkill]);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const latestRequestIdRef = useRef(0);
  const activeSkillTargetKey = buildSourceSettingsProjectionKey(
    activeWorkspacePath,
    activeWorkspaceIdentity,
    cacheAuthorityKey,
  );
  const currentListing = listing?.targetKey === activeSkillTargetKey ? listing.result : null;
  const { skills, diagnostics } = currentListing ?? EMPTY_SKILL_LIST;
  const capability = currentListing?.capability;
  const directoryError = listFailure?.targetKey === activeSkillTargetKey ? listFailure : null;

  useEffect(() => {
    if (selfHostedBuild || !activeWorkspacePath || !targetServiceResolution.rpcReady) return;
    void initializePlugins({
      workspacePath: activeWorkspacePath,
      workspaceIdentity: activeWorkspaceIdentity,
      authorityKey: cacheAuthorityKey,
      configScope: scopeFilter,
      pluginService: pluginManagementService,
    });
  }, [
    activeWorkspaceIdentity,
    activeWorkspacePath,
    cacheAuthorityKey,
    initializePlugins,
    pluginManagementService,
    scopeFilter,
    targetServiceResolution.rpcReady,
  ]);

  const workspaceLabel = getWorkspaceBasename(activeWorkspacePath);
  const connectedRemoteSyncTarget =
    targetServiceResolution.rpcReady &&
    shouldShowRemoteSyncActions({ remoteSessionId, remoteTarget, isWebRemoteControl }) &&
    activeWorkspacePath
      ? remoteTarget
      : null;
  const remoteSkillSyncTargetLabel = connectedRemoteSyncTarget
    ? formatRemoteSyncTargetLabel(connectedRemoteSyncTarget, activeWorkspacePath ?? "")
    : "";
  const dataSync = useSettingsDataSyncEntry({
    category: "skills",
    sourceServerId: dataSyncSourceServerId,
    onPushFinished: async () => {
      await Promise.all([refresh(), refreshSharedSkillStoreForCurrentWorkspace()]);
    },
  });

  const renderScopeLabel = useCallback(
    (skill: SkillSummary): string => {
      if (skill.codexScope === "system")
        return intl.formatMessage({
          id: "settings.skills.codexSystem",
        });
      if (skill.codexScope === "admin")
        return intl.formatMessage({
          id: "settings.skills.codexAdmin",
        });
      if (selfHostedBuild && skill.pluginId) return skill.pluginId;
      switch (skill.scope) {
        case "workspace":
          // workspace 作用域显示 workspace 名，没有 workspace 时退回到通用文案。
          return (
            workspaceLabel ||
            intl.formatMessage({
              id: "settings.skills.scope.workspaceFallback",
            })
          );
        case "plugin":
          return skill.pluginName?.trim()
            ? resolvePluginDisplayName(
                {
                  name: skill.pluginName,
                  listing:
                    (skill.pluginId ? pluginListingById.get(skill.pluginId) : undefined) ??
                    resolveUniquePluginListingByName(availablePlugins, skill.pluginName),
                },
                locale,
              )
            : intl.formatMessage({ id: "settings.skills.scope.plugin" });
        case "user":
        default:
          return intl.formatMessage({ id: "settings.skills.scope.personal" });
      }
    },
    [availablePlugins, intl, locale, pluginListingById, workspaceLabel],
  );

  const renderDiagnosticCodeLabel = useCallback(
    (code: SkillDiagnosticCode): string =>
      intl.formatMessage({ id: `settings.skills.diagnostics.code.${code}` }),
    [intl],
  );

  const loadSkills = useCallback(
    async (
      showBlockingLoading: boolean,
      expected?: { skillId: string; enabled: boolean; failureMessage: string },
    ) => {
      if (!targetServiceResolution.rpcReady) return;
      if (!activeWorkspacePath) {
        setListing(null);
        setListFailure(null);
        setError(null);
        setLoading(false);
        return;
      }
      setLoading(showBlockingLoading);
      setError(null);
      setListFailure(null);
      const requestId = ++latestRequestIdRef.current;
      try {
        const result = await skillsService.list({
          workspacePath: activeWorkspacePath,
          workspaceIdentity: activeWorkspaceIdentity,
          provider: ZCODE_AGENT_PROVIDER,
        });
        if (requestId !== latestRequestIdRef.current) {
          return;
        }
        setListing({ targetKey: activeSkillTargetKey, result });
        if (selfHostedBuild) {
          setSelectedSkill((skill) =>
            skill && result.skills.some((entry) => entry.id === skill.id) ? skill : null,
          );
        }
        setLoading(false);
        if (
          expected &&
          result.skills.find((skill) => skill.id === expected.skillId)?.enabled !== expected.enabled
        ) {
          setError(expected.failureMessage);
        }
      } catch (loadError) {
        if (requestId !== latestRequestIdRef.current) {
          return;
        }
        // 读取失败没有当前目标的目录证据，沿用上一份投影会误显示旧路径或已安装为空。
        setListFailure({
          targetKey: activeSkillTargetKey,
          message: loadError instanceof Error ? loadError.message : String(loadError),
        });
        setSelectedSkill(null);
        setLoading(false);
      }
    },
    [
      activeWorkspaceIdentity,
      activeWorkspacePath,
      activeSkillTargetKey,
      skillsService,
      targetServiceResolution.rpcReady,
    ],
  );

  useEffect(() => {
    if (!targetServiceResolution.rpcReady) {
      setLoading(false);
      setError(null);
      setImportDialogOpen(false);
      return;
    }
    // 首屏或切换 Scope target 时必须显示阻塞 loading；手动刷新仍走后台刷新，
    // 避免有当前 target 数据时整块闪烁。
    void loadSkills(true);
    return () => {
      latestRequestIdRef.current += 1;
    };
  }, [loadSkills, targetServiceResolution.rpcReady]);

  const refresh = useCallback(async () => {
    await loadSkills(false);
  }, [loadSkills]);

  const refreshSharedSkillStoreForCurrentWorkspace = useCallback(async () => {
    await refreshSharedSkillStoreForWorkspace({
      workspacePath: activeWorkspacePath,
      workspaceIdentity: activeWorkspaceIdentity,
      skillsService,
    });
  }, [activeWorkspaceIdentity, activeWorkspacePath, skillsService]);

  const setEnabled = useCallback(
    async (skillId: string, enabled: boolean) => {
      if (!activeWorkspacePath || writingSkillRef.current) {
        return;
      }
      writingSkillRef.current = true;
      setWritingSkill(true);
      // 移除三方来源后，技能状态统一写入 ZCode Agent 上下文，避免旧 provider 前缀带来分桶漂移。
      const targetSkill = skills.find((skill) => skill.id === skillId);
      const effectiveProvider: ZCodeProvider = ZCODE_AGENT_PROVIDER;
      try {
        await skillsService.setEnabled({
          workspacePath: activeWorkspacePath,
          workspaceIdentity: activeWorkspaceIdentity,
          provider: effectiveProvider,
          scope: targetSkill?.scope,
          skillId,
          enabled,
        });
        await invalidateDeferredDraftSessionForSkillChange({
          workspacePath: activeWorkspacePath,
          workspaceIdentity: activeWorkspaceIdentity,
          reason: "settings-skill-enabled",
        });
        await Promise.all([
          loadSkills(
            false,
            selfHostedBuild
              ? {
                  skillId,
                  enabled,
                  failureMessage: intl.formatMessage({
                    id: "settings.skills.codexEffectiveMismatch",
                  }),
                }
              : undefined,
          ),
          refreshSharedSkillStoreForCurrentWorkspace(),
        ]);
      } catch (setEnabledError) {
        if (selfHostedBuild) await loadSkills(false);
        setError(
          setEnabledError instanceof Error ? setEnabledError.message : String(setEnabledError),
        );
      } finally {
        writingSkillRef.current = false;
        setWritingSkill(false);
      }
    },
    [
      activeWorkspaceIdentity,
      activeWorkspacePath,
      intl,
      loadSkills,
      refreshSharedSkillStoreForCurrentWorkspace,
      skills,
      skillsService,
    ],
  );

  // 删除本地技能：plugin 作用域技能不可单独删除（由卸载插件管理），调用方已在 UI 层屏蔽其入口。
  // 复用应用根部已挂载的确认弹窗 store（useConfirmDialog），与子智能体删除流程保持一致。
  const handleDeleteSkill = useCallback(
    async (skill: SkillSummary) => {
      if (!activeWorkspacePath || skill.scope === "plugin") {
        return;
      }
      const confirmed = await confirmDialog({
        confirmVariant: "destructive",
        title: intl.formatMessage({ id: "settings.skills.delete.title" }),
        description: intl.formatMessage(
          { id: "settings.skills.delete.description" },
          { name: skill.name },
        ),
        confirmLabel: intl.formatMessage({ id: "common.delete" }),
      });
      if (!confirmed) {
        return;
      }
      try {
        await skillsService.deleteSkill({
          workspacePath: activeWorkspacePath,
          workspaceIdentity: activeWorkspaceIdentity,
          skillId: skill.id,
        });
        await invalidateDeferredDraftSessionForSkillChange({
          workspacePath: activeWorkspacePath,
          workspaceIdentity: activeWorkspaceIdentity,
          reason: "settings-skill-delete",
        });
        if (selectedSkill?.id === skill.id) {
          setSelectedSkill(null);
        }
        await loadSkills(false);
      } catch (deleteError) {
        setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
      }
    },
    [
      activeWorkspaceIdentity,
      activeWorkspacePath,
      confirmDialog,
      intl,
      loadSkills,
      selectedSkill,
      skillsService,
    ],
  );

  const scopedProviderSkills = useMemo(() => {
    // 原生技能表已经含有效插件归属。由插件管理目录再次过滤会丢失同名或处于独立来源的技能。
    if (selfHostedBuild)
      return skills.filter((skill) =>
        scopeFilter === "workspace" ? skill.codexScope === "repo" : skill.codexScope !== "repo",
      );
    const allProviderSkills = filterSkillsForProvider(skills, ZCODE_AGENT_PROVIDER);
    const pluginStoreMatchesTarget =
      (pluginWorkspaceIdentity?.trim() || pluginWorkspacePath || "") ===
        (activeWorkspaceIdentity?.trim() || activeWorkspacePath || "") &&
      pluginConfigScope === scopeFilter;
    return selectSkillsForScope(
      allProviderSkills,
      pluginStoreMatchesTarget ? selectPluginsForScope(plugins, installedPlugins, scopeFilter) : [],
      scopeFilter,
    );
  }, [
    activeWorkspaceIdentity,
    activeWorkspacePath,
    installedPlugins,
    pluginWorkspaceIdentity,
    pluginWorkspacePath,
    pluginConfigScope,
    plugins,
    scopeFilter,
    skills,
  ]);
  const groupedSkills = useMemo(() => {
    if (!selfHostedBuild) return groupSkillsByPlugin(scopedProviderSkills, query);
    const keyword = query.trim().toLowerCase();
    const local: SkillSummary[] = [];
    const plugin: SkillSummary[] = [];
    // SSH 主机的路径可能区分大小写。按原生路径去重已由适配器完成。
    for (const skill of scopedProviderSkills) {
      if (
        keyword &&
        ![
          skill.name,
          skill.displayName,
          skill.description,
          skill.shortDescription,
          renderScopeLabel(skill),
          skill.pluginId,
          skill.path,
        ].some((value) => value?.toLowerCase().includes(keyword))
      )
        continue;
      (skill.scope === "plugin" ? plugin : local).push(skill);
    }
    return { local, plugin };
  }, [query, renderScopeLabel, scopedProviderSkills]);
  const skillSourceGroups = useMemo(() => {
    return groupScopedSkillsBySource(
      [...groupedSkills.local, ...groupedSkills.plugin],
      scopeFilter === "user"
        ? intl.formatMessage({ id: "settings.scope.user" })
        : workspaceLabel || intl.formatMessage({ id: "settings.scope.workspace" }),
    );
  }, [groupedSkills.local, groupedSkills.plugin, intl, scopeFilter, workspaceLabel]);
  const filteredSkillCount = groupedSkills.local.length + groupedSkills.plugin.length;
  const systemSkills = groupedSkills.local.filter((skill) => skill.codexScope === "system");
  const adminSkills = groupedSkills.local.filter((skill) => skill.codexScope === "admin");
  const directSkills = selfHostedBuild
    ? groupedSkills.local.filter(
        (skill) => skill.codexScope !== "system" && skill.codexScope !== "admin",
      )
    : groupedSkills.local;
  const hasEmptySearchResult = Boolean(query.trim()) && filteredSkillCount === 0;
  const directInstalledSkillCount = scopedProviderSkills.filter(
    (skill) =>
      skill.scope !== "plugin" && skill.codexScope !== "system" && skill.codexScope !== "admin",
  ).length;
  const hideInstalledGroup = Boolean(query.trim()) && directSkills.length === 0;
  const pluginIconItemById = useMemo(
    () =>
      new Map(
        plugins.map((plugin) => [
          plugin.id,
          { name: plugin.name, listing: pluginListingById.get(plugin.id) },
        ]),
      ),
    [pluginListingById, plugins],
  );
  useEffect(() => {
    onVisibleCountChange?.(filteredSkillCount);
  }, [filteredSkillCount, onVisibleCountChange]);
  const startSkillDraft = (name: string, skill?: SkillSummary, prompt = "") => {
    if (!activeWorkspacePath || !onCreateTask) {
      return;
    }
    const markdown = buildSkillMentionMarkdown(name, skill?.path);

    // v4 迁移删除旧 pendingComposerPrefill 后，这个入口仍手工操作 session
    // store，只剩返回聊天页的导航，skill-creator 文本没有进入新 Composer。统一委托
    // Root 的新任务入口，让草稿持久化、workspaceIdentity 隔离和 Composer 插入保持单一路径。
    onCreateTask({
      provider: ZCODE_AGENT_PROVIDER,
      initialPrompt: `${markdown} ${prompt}`,
      ...(selfHostedBuild
        ? {
            targetWorkspace: {
              workspacePath: activeWorkspacePath,
              workspaceIdentity: activeWorkspaceIdentity,
            },
          }
        : {}),
      initialPromptMention: {
        id: `skill:${skill?.id ?? name}`,
        category: "skills",
        label: skill?.displayName ?? name,
        value: name,
        markdown,
        ...(skill?.description ? { description: skill.description } : {}),
        ...(skill
          ? {
              data: {
                path: skill.path,
                scope: skill.scope,
              },
            }
          : {}),
      },
    });
  };
  const isAvailableSystemSkill = (skill: SkillSummary, name: string) =>
    skill.codexScope === "system" &&
    skill.name === name &&
    skill.enabled &&
    skill.path.startsWith("/");
  const skillCreator = selfHostedBuild
    ? skills.find((skill) => isAvailableSystemSkill(skill, "skill-creator"))
    : filterSkillsForProvider(skills, ZCODE_AGENT_PROVIDER).find(
        (skill) => skill.name === "skill-creator",
      );
  const skillInstaller = selfHostedBuild
    ? skills.find((skill) => isAvailableSystemSkill(skill, "skill-installer"))
    : undefined;
  const handleCreateSkill = () => startSkillDraft("skill-creator", skillCreator);
  const canUseSkill = (skill: SkillSummary) =>
    selfHostedBuild &&
    Boolean(onCreateTask && activeWorkspacePath) &&
    skill.enabled &&
    skill.path.startsWith("/");
  const openSkillDraft = (skill: SkillSummary) => {
    setSelectedSkill(null);
    startSkillDraft(skill.name, skill);
  };

  const detailSkill = selectedSkill
    ? (skills.find((skill) => skill.id === selectedSkill.id) ?? selectedSkill)
    : null;
  const selectedSkillPublishedAt = formatSkillPublishedAt(detailSkill?.metadata?.publishedAt);
  const openSkillFilePath = useCallback(
    async (path: string) => {
      const result = await platform.openInFileManager(path);
      if (!result.success) {
        toast(intl.formatMessage({ id: "appHeader.openInFileManagerFailed" }));
      }
    },
    [intl, platform],
  );

  // 诊断条数不等于加载失败的技能数；同一次扫描可以返回可用技能和多个目录级警告。
  // 按严重级别展示真实统计，避免把 warning 误报成“所有技能加载失败”。
  const diagnosticErrorCount = diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  ).length;
  const diagnosticWarningCount = diagnostics.length - diagnosticErrorCount;
  const diagnosticsSummary =
    diagnostics.length > 0
      ? intl.formatMessage(
          { id: "settings.skills.diagnostics.summary" },
          {
            errorCount: String(diagnosticErrorCount),
            warningCount: String(diagnosticWarningCount),
          },
        )
      : "";
  const renderSkillRow = (skill: SkillSummary) => {
    const pluginIconItem = skill.pluginId
      ? pluginIconItemById.get(skill.pluginId)
      : skill.pluginName
        ? {
            name: skill.pluginName,
            listing: resolveUniquePluginListingByName(availablePlugins, skill.pluginName),
          }
        : undefined;
    return (
      <div
        key={skill.id}
        data-skill-path={selfHostedBuild ? skill.path : undefined}
        className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-hover"
      >
        {skill.scope === "plugin" && pluginIconItem ? (
          <PluginStoreAvatar item={pluginIconItem} className="size-9 bg-background" />
        ) : (
          <div
            className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-background text-foreground-subtle"
            aria-hidden="true"
          >
            <WandSparkles className="size-4" />
          </div>
        )}
        <div
          role="button"
          tabIndex={0}
          className="min-w-0 cursor-default rounded-md outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused focus-visible:ring-offset-2 focus-visible:ring-offset-card"
          onClick={() => setSelectedSkill(skill)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setSelectedSkill(skill);
            }
          }}
        >
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-ui-base font-medium text-foreground">
              {skill.displayName ?? skill.name}
            </span>
          </div>
          <div className="mt-0.5 truncate text-ui-sm text-foreground-subtle">
            {skill.shortDescription ||
              skill.description ||
              intl.formatMessage({
                id: "settings.skills.noDescription",
              })}
          </div>
          {selfHostedBuild ? (
            <div className="mt-0.5 truncate text-ui-sm text-foreground-subtle" title={skill.path}>
              {skill.path}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canUseSkill(skill) ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="native-skill-use-row"
              disabled={writingSkill}
              onClick={() => openSkillDraft(skill)}
            >
              {intl.formatMessage({ id: "settings.skills.codexUseShort" })}
            </Button>
          ) : null}
          {selfHostedBuild ? (
            skill.path.startsWith("/") && (
              <Switch
                checked={skill.enabled}
                disabled={writingSkill}
                aria-label={skill.name}
                onCheckedChange={(checked) => void setEnabled(skill.id, checked)}
              />
            )
          ) : skill.scope === "plugin" ? null : (
            <>
              <Switch
                checked={skill.enabled}
                disabled={writingSkill}
                onCheckedChange={(checked) => {
                  void setEnabled(skill.id, checked);
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0 text-foreground-subtle hover:bg-destructive/10 hover:text-destructive"
                aria-label={intl.formatMessage({ id: "common.delete" })}
                title={intl.formatMessage({ id: "common.delete" })}
                onClick={() => void handleDeleteSkill(skill)}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
              </Button>
            </>
          )}
        </div>
      </div>
    );
  };

  const renderSkillList = (groupSkills: SkillSummary[]) => (
    <SettingsResourceList
      items={groupSkills}
      getKey={(skill) => skill.id}
      renderItem={renderSkillRow}
    />
  );

  const skillHeaderActions = (
    <div className="flex flex-wrap items-center gap-2">
      {skillInstaller && onCreateTask ? (
        <Button
          type="button"
          variant="outline"
          data-testid="native-skill-discover"
          onClick={() =>
            startSkillDraft(
              skillInstaller.name,
              skillInstaller,
              intl.formatMessage({ id: "settings.skills.codexDiscoverPrompt" }),
            )
          }
        >
          {intl.formatMessage({ id: "settings.skills.codexDiscover" })}
        </Button>
      ) : null}
      <SettingsResourceHeaderActions
        onRefresh={() =>
          void Promise.all([refresh(), refreshSharedSkillStoreForCurrentWorkspace()])
        }
        refreshDisabled={selfHostedBuild && writingSkill}
        onImport={selfHostedBuild ? undefined : () => setImportDialogOpen(true)}
        onNew={selfHostedBuild && (!skillCreator || !onCreateTask) ? undefined : handleCreateSkill}
        newLabel={
          selfHostedBuild ? intl.formatMessage({ id: "settings.skills.create.open" }) : undefined
        }
        importDisabled={!capability?.userScopeAvailable}
        importActionId="settings.skills.import.open"
        newActionId="settings.skills.create.open"
      />
    </div>
  );
  const remoteSyncAction = dataSync.visible ? (
    <ControlHintTooltip title={intl.formatMessage({ id: "settings.skills.remoteSync.open" })}>
      <Button
        type="button"
        variant="outline"
        size="icon-lg"
        data-testid="data-sync-entry-skills"
        disabled={dataSync.disabled}
        aria-label={intl.formatMessage({
          id: "settings.skills.remoteSync.open",
        })}
        onClick={dataSync.open}
      >
        <UploadCloud className="size-3.5" aria-hidden="true" />
      </Button>
    </ControlHintTooltip>
  ) : null;

  return (
    <div className="space-y-4">
      {/* Bug 原因：独立 Skills 分区的详情是弹窗，不属于页面级导航；只有插件容器需要上报详情层级。 */}
      {reportDetailBreadcrumb && detailSkill ? (
        <SettingsBreadcrumbReporter
          items={
            showMarketplaceBreadcrumb
              ? [
                  {
                    label: intl.formatMessage({ id: "settings.plugins.title" }),
                    onSelect: () => setSelectedSkill(null),
                  },
                  { label: detailSkill.name },
                ]
              : [{ label: detailSkill.name }]
          }
          onSectionSelect={
            showMarketplaceBreadcrumb && onOpenPluginStore
              ? onOpenPluginStore
              : () => setSelectedSkill(null)
          }
        />
      ) : null}
      {remoteSyncAction ? <div className="flex justify-end">{remoteSyncAction}</div> : null}

      {connectedRemoteSyncTarget ? (
        <div className="rounded-lg border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle">
          {intl.formatMessage(
            { id: "settings.skills.remoteContext" },
            { target: remoteSkillSyncTargetLabel },
          )}
        </div>
      ) : null}

      {targetServiceResolution.rpcReady && !directoryError && diagnostics.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-amber-500/40 bg-amber-500/10 text-ui-base text-foreground">
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
            onClick={() => setDiagnosticsOpen((prev) => !prev)}
            aria-expanded={diagnosticsOpen}
            aria-label={
              diagnosticsOpen
                ? intl.formatMessage({
                    id: "settings.skills.diagnostics.collapse",
                  })
                : intl.formatMessage({
                    id: "settings.skills.diagnostics.expand",
                  })
            }
          >
            {diagnosticsOpen ? (
              <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
            )}
            <AlertTriangle className="size-3.5 shrink-0 text-amber-500" aria-hidden="true" />
            <span className="flex-1 truncate font-medium">{diagnosticsSummary}</span>
          </button>
          {diagnosticsOpen ? (
            <ul className="space-y-1 border-t border-amber-500/30 px-3 py-2">
              {diagnostics.map((diagnostic, index) => (
                <li
                  key={`${diagnostic.code}-${diagnostic.path ?? "no-path"}-${index}`}
                  className="min-w-0"
                >
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span
                      className={
                        diagnostic.severity === "error"
                          ? "shrink-0 text-ui-xs font-semibold uppercase tracking-wide text-destructive"
                          : "shrink-0 text-ui-xs font-semibold uppercase tracking-wide text-amber-500"
                      }
                    >
                      {diagnostic.severity}
                    </span>
                    <span className="font-medium text-foreground">
                      {renderDiagnosticCodeLabel(diagnostic.code)}
                    </span>
                    {diagnostic.skillName ? (
                      <span className="text-foreground-subtle">· {diagnostic.skillName}</span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 break-words text-foreground-subtle">
                    {diagnostic.message}
                  </div>
                  {diagnostic.path ? (
                    <div className="mt-0.5 break-all font-mono text-ui-xs text-foreground-subtle">
                      {diagnostic.path}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {!selfHostedBuild && targetServiceResolution.rpcReady && !capability?.userScopeAvailable ? (
        <div className="rounded-lg border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.skills.userScopeDesktopOnly" })}
        </div>
      ) : null}

      {targetServiceResolution.rpcReady && error ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive"
        >
          {error}
        </div>
      ) : null}

      {!targetServiceResolution.rpcReady ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.connecting" })} />
      ) : directoryError ? (
        <div
          data-testid={selfHostedBuild ? "native-skill-list-error" : undefined}
          className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2"
        >
          <p role="alert" className="break-words text-ui-base text-destructive">
            {directoryError.message}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              void Promise.all([loadSkills(true), refreshSharedSkillStoreForCurrentWorkspace()])
            }
          >
            {intl.formatMessage({ id: "common.retry" })}
          </Button>
        </div>
      ) : loading || (activeWorkspacePath && !currentListing) ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.loading" })} />
      ) : hasEmptySearchResult ? (
        <PluginSearchEmptyState
          label={intl.formatMessage({
            id: "settings.plugin.skills.searchEmpty",
          })}
        />
      ) : (
        <div className="space-y-6">
          <section className={hideInstalledGroup ? "hidden" : "space-y-4"}>
            <div data-skills-plugin-direct-actions="true">
              <SettingsResourceGroupHeader
                actions={skillHeaderActions}
                count={directSkills.length}
                title={intl.formatMessage({
                  id: "settings.plugin.skills.installed",
                })}
              />
            </div>
            {directSkills.length > 0 ? (
              renderSkillList(directSkills)
            ) : directInstalledSkillCount === 0 && !query.trim() && selfHostedBuild ? (
              <PluginSearchEmptyState
                label={intl.formatMessage({ id: "settings.plugin.skills.emptyInstalledTitle" })}
              />
            ) : directInstalledSkillCount === 0 && !query.trim() ? (
              <PluginInstallEmptyState
                title={intl.formatMessage({
                  id: "settings.plugin.skills.emptyInstalledTitle",
                })}
                description={intl.formatMessage({
                  id: "settings.plugin.skills.emptyInstalledDescription",
                })}
                actions={
                  <>
                    <Button type="button" variant="default" size="lg" onClick={handleCreateSkill}>
                      <Plus data-icon="inline-start" aria-hidden="true" />
                      {intl.formatMessage({
                        id: "settings.plugin.skills.newSkill",
                      })}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="lg"
                      disabled={!capability?.userScopeAvailable}
                      onClick={() => setImportDialogOpen(true)}
                    >
                      <Import data-icon="inline-start" aria-hidden="true" />
                      {intl.formatMessage({
                        id: "settings.skills.import.action",
                      })}
                    </Button>
                  </>
                }
              />
            ) : null}
          </section>
          {[
            { items: systemSkills, titleId: "settings.skills.codexSystem" },
            { items: adminSkills, titleId: "settings.skills.codexAdmin" },
          ].map(({ items, titleId }) =>
            items.length > 0 ? (
              <section key={titleId} className="space-y-4">
                <SettingsResourceGroupHeader
                  count={items.length}
                  title={intl.formatMessage({ id: titleId })}
                />
                {renderSkillList(items)}
              </section>
            ) : null,
          )}
          {skillSourceGroups
            .filter((group) => group.id.startsWith("plugin:"))
            .map((group) => (
              <section key={group.id} className="space-y-4">
                <SettingsResourceGroupHeader
                  count={group.skills.length}
                  title={
                    (selfHostedBuild && group.pluginId) ||
                    resolvePluginDisplayName(
                      {
                        name: group.label,
                        listing:
                          (group.pluginId ? pluginListingById.get(group.pluginId) : undefined) ??
                          resolveUniquePluginListingByName(availablePlugins, group.label),
                      },
                      locale,
                    )
                  }
                />
                {renderSkillList(group.skills)}
              </section>
            ))}
        </div>
      )}
      <Dialog
        open={selectedSkill !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedSkill(null);
          }
        }}
      >
        <DialogContent className="max-h-[min(80vh,640px)] max-w-xl overflow-hidden p-0">
          {detailSkill ? (
            <div className="flex min-h-0 flex-col">
              <DialogHeader className="border-b border-popover-border px-4 pt-4 pb-3">
                <DialogTitle className="truncate pr-8 text-ui-lg">
                  {detailSkill.displayName ?? detailSkill.name}
                </DialogTitle>
              </DialogHeader>
              <div className="min-h-0 space-y-4 overflow-auto px-4 py-5">
                <div className="grid gap-1.5">
                  <div className="text-ui-base font-medium text-foreground">
                    {intl.formatMessage({
                      id: "settings.skills.detail.description",
                    })}
                  </div>
                  <div className="max-h-40 overflow-auto whitespace-pre-wrap text-ui-base/relaxed text-foreground-subtle">
                    {detailSkill.description ||
                      intl.formatMessage({
                        id: "settings.skills.noDescription",
                      })}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                  {detailSkill.displayName && detailSkill.displayName !== detailSkill.name ? (
                    <SkillDetailField
                      label={intl.formatMessage({ id: "settings.skills.codexName" })}
                      value={detailSkill.name}
                      mono
                    />
                  ) : null}
                  <SkillDetailField
                    label={intl.formatMessage({
                      id: "settings.skills.detail.scope",
                    })}
                    value={renderScopeLabel(detailSkill)}
                  />
                  <SkillDetailField
                    label={intl.formatMessage({
                      id: "settings.skills.detail.status",
                    })}
                    value={
                      detailSkill.enabled
                        ? intl.formatMessage({
                            id: "settings.skills.detail.enabled",
                          })
                        : intl.formatMessage({
                            id: "settings.skills.detail.disabled",
                          })
                    }
                  />
                  <SkillDetailField
                    label={intl.formatMessage({
                      id: "settings.skills.detail.version",
                    })}
                    value={detailSkill.metadata?.version}
                    mono
                  />
                  <SkillDetailField
                    label={intl.formatMessage({
                      id: "settings.skills.detail.slug",
                    })}
                    value={detailSkill.metadata?.slug}
                    mono
                  />
                  <SkillDetailField
                    label={intl.formatMessage({
                      id: "settings.skills.detail.publishedAt",
                    })}
                    value={selectedSkillPublishedAt}
                    mono
                  />
                  <SkillDetailField
                    label={intl.formatMessage({
                      id: "settings.skills.detail.ownerId",
                    })}
                    value={detailSkill.metadata?.ownerId}
                    mono
                    className="col-span-2"
                  />
                  {selfHostedBuild && detailSkill.path.startsWith("/") ? (
                    <CodexSkillFilePreview
                      key={detailSkill.path}
                      path={detailSkill.path}
                      readTextFile={(params) => fileService.readTextFile(params)}
                    />
                  ) : selfHostedBuild ? (
                    <SkillDetailField
                      label={intl.formatMessage({ id: "settings.skills.detail.path" })}
                      value={detailSkill.path}
                      className="col-span-2"
                      mono
                    />
                  ) : (
                    <SkillPathDetailField
                      label={intl.formatMessage({
                        id: "settings.skills.detail.path",
                      })}
                      path={detailSkill.path}
                      openLabel={intl.formatMessage({
                        id: "settings.skills.detail.openPath",
                      })}
                      onOpen={() => void openSkillFilePath(detailSkill.path)}
                    />
                  )}
                </div>
                {detailSkill.codexToolDependencies?.length ? (
                  <div className="space-y-1">
                    <div className="text-ui-base font-medium text-foreground">
                      {intl.formatMessage({ id: "settings.skills.codexDependencies" })}
                    </div>
                    <ul className="space-y-1 text-ui-sm text-foreground-subtle">
                      {detailSkill.codexToolDependencies.map((tool, i) => (
                        <li key={`${tool.type}:${tool.value}:${i}`} className="break-words">
                          <span className="font-mono">
                            {tool.type} · {tool.value}
                          </span>
                          {tool.description ? (
                            <span className="block">{tool.description}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {canUseSkill(detailSkill) ? (
                  <Button
                    type="button"
                    data-testid="native-skill-use"
                    disabled={writingSkill}
                    onClick={() => openSkillDraft(detailSkill)}
                  >
                    {intl.formatMessage({ id: "settings.skills.codexUse" })}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
      <SkillsImportDialog
        open={importDialogOpen && targetServiceResolution.rpcReady}
        workspacePath={activeWorkspacePath}
        workspaceIdentity={activeWorkspaceIdentity}
        settingsSyncService={targetServiceResolution.services.settingsSyncService}
        onOpenChange={setImportDialogOpen}
        onImported={async () => {
          await invalidateDeferredDraftSessionForSkillChange({
            workspacePath: activeWorkspacePath,
            workspaceIdentity: activeWorkspaceIdentity,
            reason: "settings-skill-import",
          });
          await refresh();
        }}
      />
      {dataSync.dialog}
    </div>
  );
}
