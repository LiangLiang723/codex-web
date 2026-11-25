import { useMemo } from "react";
import { DEFAULT_LOCALE, type Locale, type SkillScope } from "@zcode/shared";
import type { ZCodeProvider, ZCodeSkillReferenceCatalogEntry } from "@zcode/shared";
import { selfHostedBuild } from "@zcode/shared/runtimeEnv";
import type { MentionCategoryResult, MentionItem } from "@/mentions/mentionTypes.js";
import { filterMentionItemsWithOptions } from "@/mentions/mentionSearch.js";
import { buildSkillMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import { useSkills } from "@/hooks/useSkills.js";
import { filterSkillsForProvider } from "@/lib/skillSourceFilter.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { LOCALE_MESSAGES } from "@/i18n/localeMessages.js";
import { resolveSkillDisplayDescription, resolveSkillSourceLabel } from "@/lib/builtinSkillI18n.js";

export function mapSkillsToMentionItemsForTest(
  skills: Array<
    Pick<
      ZCodeSkillReferenceCatalogEntry,
      | "id"
      | "name"
      | "description"
      | "displayName"
      | "shortDescription"
      | "path"
      | "scope"
      | "pluginName"
      | "pluginId"
      | "codexScope"
    >
  >,
  locale?: Locale,
): MentionItem[] {
  const uniqueSkillsByName = new Map<string, (typeof skills)[number]>();
  const nativeNameCounts = new Map<string, number>();
  const scopePriority: Record<SkillScope, number> = {
    workspace: 0,
    plugin: 1,
    user: 2,
  };
  for (const skill of skills) {
    const key = (selfHostedBuild ? (skill.displayName ?? skill.name) : skill.name)
      .trim()
      .toLowerCase();
    if (selfHostedBuild) {
      nativeNameCounts.set(key, (nativeNameCounts.get(key) ?? 0) + 1);
      continue;
    }
    const current = uniqueSkillsByName.get(key);
    // `$` 面板是执行入口，不是来源管理页。
    // 同名技能如果来自 workspace/user/plugin 多个路径，继续全部展示会让用户看到“同一个 skill”重复刷屏。
    // 这里按名称折叠，并优先选择 workspace，其次 plugin，最后 user；Settings 页仍保留完整来源列表用于管理。
    if (!current || scopePriority[skill.scope] < scopePriority[current.scope]) {
      uniqueSkillsByName.set(key, skill);
    }
  }
  const visibleSkills = selfHostedBuild ? skills : [...uniqueSkillsByName.values()];

  return visibleSkills.map((skill) => {
    const messages = LOCALE_MESSAGES[locale ?? DEFAULT_LOCALE];
    const codexSource =
      skill.pluginId ??
      (skill.codexScope === "system"
        ? messages["settings.skills.codexSystem"]
        : skill.codexScope === "admin"
          ? messages["settings.skills.codexAdmin"]
          : undefined);
    const sourceLabel =
      (selfHostedBuild ? codexSource : undefined) ?? resolveSkillSourceLabel(skill.scope, locale);
    const displayLabel = selfHostedBuild ? skill.displayName : undefined;
    const description = selfHostedBuild
      ? (skill.shortDescription ?? skill.description)
      : resolveSkillDisplayDescription(skill, locale);
    const duplicateName =
      (nativeNameCounts.get((displayLabel ?? skill.name).trim().toLowerCase()) ?? 0) > 1;
    return {
      id: `skill:${skill.id}`,
      category: "skills",
      label: skill.name,
      displayLabel,
      description: [sourceLabel, duplicateName ? skill.path : description]
        .filter(Boolean)
        .join(" · "),
      value: skill.name,
      markdown: buildSkillMentionMarkdown(skill.name, skill.path),
      keywords: [
        ...new Set([
          displayLabel ?? skill.name,
          skill.name,
          skill.description,
          description,
          sourceLabel,
          skill.scope,
        ]),
      ],
      data: {
        path: skill.path,
        scope: skill.scope,
      },
    };
  });
}

export function useSkillsMentionProvider(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  sessionId: string | null,
  provider: ZCodeProvider,
  query: string,
  enabled: boolean,
  requireQuery: boolean,
  emptyText: string,
  title: string,
): MentionCategoryResult {
  const { locale } = useZCodeIntl();
  const { skills, loading, error } = useSkills({
    workspacePath,
    workspaceIdentity,
    sessionId,
    enabled,
  });

  const allItems = useMemo(
    () =>
      mapSkillsToMentionItemsForTest(
        (selfHostedBuild ? skills : filterSkillsForProvider(skills, provider)).filter(
          (skill) => skill.enabled,
        ),
        locale,
      ),
    [locale, provider, skills],
  );

  const items = useMemo(
    () =>
      filterMentionItemsWithOptions(allItems, query, {
        requireQuery,
      }),
    [allItems, query, requireQuery],
  );

  return {
    items: enabled ? items : [],
    loading,
    error: error ? new Error(error) : null,
    emptyText,
    title,
  };
}
