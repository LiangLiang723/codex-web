import { useMemo } from "react";
import {
  Box,
  Brain,
  Cable,
  FilePlus,
  FolderOpen,
  Goal,
  Lightbulb,
  ListChecks,
  PanelTop,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { selfHostedBuild } from "@zcode/shared/runtimeEnv";
import { isAppSlashCommandSuggestion } from "@/slashCommandHelpers.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { PromptInputSuggestionItem } from "@/lib/promptInputTriggers.js";
import {
  type MentionPanelOption,
  type MentionPanelSection,
} from "@/mentions/components/MentionPanel.js";

const SELFHOST_COMMAND_ICONS: Partial<Record<string, LucideIcon>> = {
  mcp: Cable,
  review: ListChecks,
  init: FilePlus,
  project: FolderOpen,
  reasoning: Brain,
  model: Box,
  goal: Goal,
  plan: Lightbulb,
  compact: PanelTop,
};

export function useSlashCommandMentionPanelSections(
  intl: IntlInstance,
  commandsLength: number,
  filteredCommandSuggestions: PromptInputSuggestionItem[],
  filteredSkillSuggestions: PromptInputSuggestionItem[],
  skillsLoading: boolean,
  skillsError: string | null,
  filteredSubagentSuggestions: PromptInputSuggestionItem[],
  subagentsLoading: boolean,
  subagentsError: string | null,
): MentionPanelSection[] {
  return useMemo(() => {
    const sections: MentionPanelSection[] = [
      {
        id: "commands",
        title: intl.formatMessage({ id: "chat.slash.commands.title" }),
        options: filteredCommandSuggestions.map<MentionPanelOption>((suggestion) => {
          const label =
            selfHostedBuild || isAppSlashCommandSuggestion(suggestion)
              ? suggestion.label
              : `/${suggestion.value}`;
          const shortcut = `/${suggestion.value}`;
          const Icon = SELFHOST_COMMAND_ICONS[suggestion.value] ?? Terminal;
          return {
            id: suggestion.id,
            label,
            description: suggestion.description,
            content: (
              <span className="min-w-0 flex-1 flex items-center gap-2">
                {selfHostedBuild ? (
                  <Icon className="size-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
                ) : null}
                <span className="truncate text-ui-base font-medium text-foreground max-w-[40%]">
                  {label}
                </span>
                <span className="truncate text-ui-sm text-foreground-subtlest flex-1">
                  {suggestion.description}
                </span>
                {selfHostedBuild && label !== shortcut ? (
                  <span className="shrink-0 text-ui-xs text-foreground-subtle">{shortcut}</span>
                ) : null}
              </span>
            ),
          };
        }),
        loading: false,
        emptyText:
          commandsLength === 0
            ? intl.formatMessage({ id: "chat.slash.emptyUnavailable" })
            : intl.formatMessage({ id: "chat.slash.emptyResults" }),
      },
      {
        id: "skills",
        title: intl.formatMessage({ id: "chat.slash.skills.title" }),
        options: filteredSkillSuggestions.map<MentionPanelOption>((suggestion) => ({
          id: suggestion.id,
          label: `$${suggestion.value}`,
          description: suggestion.description,
          content: (
            <span className="min-w-0 flex-1 flex items-center gap-2">
              <span className="truncate text-ui-base font-medium text-foreground max-w-[40%]">
                {`$${suggestion.value}`}
              </span>
              <span className="truncate text-ui-base text-foreground-subtlest flex-1">
                {suggestion.description}
              </span>
            </span>
          ),
        })),
        loading: skillsLoading,
        loadingText: intl.formatMessage({ id: "chat.mention.category.loading" }),
        emptyText: intl.formatMessage({ id: "chat.slash.skills.empty" }),
        errorText: skillsError,
      },
      ...(!selfHostedBuild
        ? [
            {
              id: "subagents",
              title: intl.formatMessage({ id: "chat.slash.subagents.title" }),
              options: filteredSubagentSuggestions.map<MentionPanelOption>((suggestion) => ({
                id: suggestion.id,
                label: suggestion.value,
                description: suggestion.description,
                content: (
                  <span className="min-w-0 flex-1 flex items-center gap-2">
                    <span className="truncate text-ui-base font-medium text-foreground max-w-[40%]">
                      {suggestion.value}
                    </span>
                    <span className="truncate text-ui-base text-foreground-subtlest flex-1">
                      {suggestion.description}
                    </span>
                  </span>
                ),
              })),
              loading: subagentsLoading,
              emptyText: intl.formatMessage({ id: "chat.slash.subagents.empty" }),
              errorText: subagentsError,
            },
          ]
        : []),
    ];
    return selfHostedBuild
      ? sections.filter((section) => section.options.length || section.loading || section.errorText)
      : sections;
  }, [
    commandsLength,
    filteredCommandSuggestions,
    filteredSkillSuggestions,
    filteredSubagentSuggestions,
    intl,
    skillsError,
    skillsLoading,
    subagentsError,
    subagentsLoading,
  ]);
}
