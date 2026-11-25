import { useEffect, useMemo, useState } from "react";
import { selfHostedBuild } from "@zcode/shared/runtimeEnv";
import {
  sortPluginStoreEntries,
  isPublicStoreMarketplaceId,
  type PluginStoreModeOrder,
  resolvePluginDisplayName,
  resolveLocalizedText,
  type ZCodePluginReferenceCatalogEntry,
} from "@zcode/shared";
import type { MentionCategoryResult, MentionItem } from "@/mentions/mentionTypes.js";
import { filterMentionItemsWithOptions } from "@/mentions/mentionSearch.js";
import { buildCodexAppMention, buildPluginMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import { usePluginReferenceCatalog } from "@/hooks/usePluginReferenceCatalog.js";
import { usePluginStoreOrder } from "@/hooks/usePluginStoreOrder.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";

export interface PluginMentionLabels {
  conflictReason: string;
}

const EMPTY_APP_ITEMS: MentionItem[] = [];

// - 只展示 catalog 中 enabled 的 Plugin；disabled 条目不可被引用，不进入候选。
// - 同名 manifest 冲突（conflictingPluginIds 非空）保持可见但禁选，展示冲突原因（V1 fail closed）。
// - markdown 载体固定 `[@Label](plugin://stable-id)`；label 仅展示，身份在 destination。
//   面板展示名 displayLabel 按当前 locale 走全 app 统一的 resolvePluginDisplayName；label 与
//   载体 label 固定 entry.name，chip/canonical text/reminder 不随 locale 变化（chip 节点复用
//   item.label，若本地化 label 会与按 markdown 重建的消息气泡文案分裂）。
// - keywords 并入 listing 的全部语言显示名（无论当前 locale）：英文界面下打中文
//   也能搜到官方插件（插件 @ 引用中文搜索）。
export function mapPluginCatalogToMentionItemsForTest(
  entries: ZCodePluginReferenceCatalogEntry[],
  labels: PluginMentionLabels,
  locale: string,
  order?: PluginStoreModeOrder,
): MentionItem[] {
  const sorted =
    order && entries.some((entry) => entry.category !== undefined)
      ? [
          ...sortPluginStoreEntries(
            entries.filter((entry) => isPublicStoreMarketplaceId(entry.marketplace)),
            (entry) => ({
              id: entry.pluginId,
              category: entry.category,
              displayName: resolvePluginDisplayName(
                {
                  name: entry.name,
                  listing: {
                    displayName: entry.displayName,
                    displayNameI18n: entry.displayNameI18n,
                  },
                },
                locale,
              ),
            }),
            locale,
            order,
          ),
          ...entries.filter((entry) => !isPublicStoreMarketplaceId(entry.marketplace)),
        ]
      : entries;
  const enabled = sorted
    .filter((entry) => entry.enabled)
    .map((entry) => ({
      entry,
      displayLabel: resolvePluginDisplayName(
        {
          name: entry.name,
          listing: { displayName: entry.displayName, displayNameI18n: entry.displayNameI18n },
        },
        locale,
      ),
    }));
  const nameCounts = new Map<string, number>();
  if (selfHostedBuild) {
    for (const { displayLabel } of enabled) {
      const key = displayLabel.trim().toLowerCase();
      nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
    }
  }
  return enabled.map(({ entry, displayLabel }) => {
    const conflicted = entry.conflictingPluginIds.length > 0;
    const description =
      resolveLocalizedText(locale, entry.description, entry.descriptionI18n) ?? "";
    const showMarketplace = (nameCounts.get(displayLabel.trim().toLowerCase()) ?? 0) > 1;
    return {
      id: `plugin:${entry.pluginId}`,
      category: "plugins" as const,
      label: entry.name,
      displayLabel,
      description: showMarketplace
        ? [entry.marketplace, description].filter(Boolean).join(" · ")
        : description,
      value: entry.pluginId,
      markdown: buildPluginMentionMarkdown(entry.name, entry.pluginId),
      keywords: [
        entry.name,
        entry.pluginId,
        entry.marketplace,
        ...(entry.displayName ? [entry.displayName] : []),
        ...Object.values(entry.displayNameI18n ?? {}),
      ],
      data: {
        pluginId: entry.pluginId,
        ...(entry.icon ? { icon: entry.icon } : {}),
      },
      ...(conflicted
        ? {
            disabled: true,
            disabledReason: labels.conflictReason,
          }
        : {}),
    };
  });
}

export function usePluginsMentionProvider(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  sessionId: string | null,
  query: string,
  enabled: boolean,
  emptyText: string,
  title: string,
): MentionCategoryResult {
  const { intl, locale } = useZCodeIntl();
  const { order } = usePluginStoreOrder(enabled);
  const isOfficeMode = useIsOfficeMode();
  const modeOrder = isOfficeMode ? order?.work : order?.code;
  const catalog = usePluginReferenceCatalog(workspacePath, workspaceIdentity, sessionId, enabled);

  const allItems = useMemo(
    () =>
      mapPluginCatalogToMentionItemsForTest(
        catalog.entries,
        {
          conflictReason: intl.formatMessage({ id: "chat.mention.plugins.conflict" }),
        },
        locale,
        modeOrder,
      ),
    [catalog.entries, intl, locale, modeOrder],
  );

  const items = useMemo(
    () =>
      filterMentionItemsWithOptions(allItems, query, {
        requireQuery: false,
      }),
    [allItems, query],
  );

  return {
    items: enabled ? items : [],
    loading: catalog.loading,
    error: catalog.error ? new Error(catalog.error) : null,
    emptyText,
    title,
  };
}

export function useCodexAppsMentionProvider(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  threadId: string | null,
  query: string,
  enabled: boolean,
): MentionCategoryResult {
  const { intl } = useZCodeIntl();
  const { services, remoteSessionId, rpcReady } = useWorkspaceServicesResolution(
    workspacePath,
    undefined,
    workspaceIdentity,
  );
  const service = rpcReady ? services.codexAppsService : undefined;
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const active = Boolean(selfHostedBuild && enabled && workspacePath);
  const scope = useMemo(
    () => ({ service, threadId, active, workspaceKey, remoteSessionId }),
    [active, remoteSessionId, service, threadId, workspaceKey],
  );
  const [result, setResult] = useState<{
    scope: typeof scope;
    items: MentionItem[];
    error: Error | null;
  } | null>(null);

  useEffect(() => {
    if (!scope.active || !scope.service) return;
    let cancelled = false;
    void scope.service.listForComposer(scope.threadId ?? undefined).then(
      (apps) => {
        if (!cancelled) setResult({ scope, items: apps.map(buildCodexAppMention), error: null });
      },
      (error: unknown) => {
        if (cancelled) return;
        setResult({
          scope,
          items: [],
          error: error instanceof Error ? error : new Error(String(error)),
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [scope]);

  // 已经切换工作区或 Thread 时，不能在下一次请求前展示上一目标的可调用应用。
  const current = active && result?.scope === scope ? result : null;
  const candidates = current?.items ?? EMPTY_APP_ITEMS;
  const items = useMemo(
    () => filterMentionItemsWithOptions(candidates, query, { requireQuery: false }),
    [candidates, query],
  );
  return {
    items,
    loading: active && (!rpcReady || Boolean(service && !current)),
    error: current?.error ?? null,
    emptyText: intl.formatMessage({
      id:
        current && candidates.length === 0
          ? "chat.mention.apps.unavailable"
          : "chat.mention.apps.empty",
    }),
    title: intl.formatMessage({ id: "chat.mention.apps.title" }),
  };
}
