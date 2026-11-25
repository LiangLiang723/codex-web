/* eslint-disable max-lines */
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeProvider } from "@zcode/shared";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { createPortal } from "react-dom";
import {
  FileSearch,
  FolderOpen,
  GoalIcon,
  Lightbulb,
  PaletteIcon,
  PaperclipIcon,
} from "lucide-react";
import type { AppSlashCommand } from "@/slashCommandHelpers.js";
import { selfHostedBuild } from "@zcode/shared/runtimeEnv";
import {
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  BLUR_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_LOW,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
} from "lexical";
import { useZCodeIntl } from "../i18n/IntlProvider.js";
import {
  extractActivePromptInputTrigger,
  getActivePromptInputTokenTailLength,
  getPromptInputTriggerSignature,
  type ActivePromptInputTrigger,
} from "../lib/promptInputTriggers.js";
import {
  ContextMentionOptionContent,
  AppOrSkillMentionOptionContent,
} from "@/mentions/components/ContextMentionOptionContent.js";
import { PluginMentionOptionContent } from "@/mentions/components/PluginMentionOptionContent.js";
import {
  MentionPanel,
  visibleMentionPanelOptions,
  type MentionPanelOption,
  type MentionPanelSection,
} from "./components/MentionPanel.js";
import {
  buildVisibleMentionGroups,
  hasMentionQuery,
  MENTION_DEFAULT_GROUP_PREVIEW_LIMIT,
  MENTION_FILES_ONLY_DEFAULT_PREVIEW_LIMIT,
  type MentionResultGroup,
} from "./mentionSearch.js";
import {
  getMentionPanelGroupOrder,
  getSessionMentionWorkspaceScope,
  type MentionPanelGroupId,
} from "./mentionPanelRouting.js";
import { $createPromptMentionNode } from "./nodes/PromptMentionNode.js";
import {
  ExtensionMentionOptionContent,
  useExtensionMentionGroups,
} from "@/extension-slots/index.js";
import { useFileMentionProvider } from "./providers/fileMentionProvider.js";
import {
  useCodexAppsMentionProvider,
  usePluginsMentionProvider,
} from "./providers/pluginsMentionProvider.js";
import { useSessionsMentionProvider } from "./providers/sessionsMentionProvider.js";
import { useSkillsMentionProvider } from "./providers/skillsMentionProvider.js";
import { useWhiteboardMentionProvider } from "./providers/whiteboardMentionProvider.js";
import type { MentionItem } from "./mentionTypes.js";
import {
  getActivePromptInputTokenReplacementRange,
  reconcileActivePromptInputTokenSnapshot,
  type ActivePromptInputTokenSnapshot,
} from "./activePromptInputToken.js";
import { getCurrentTextNodeSelection } from "./mentionHelpers.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

export interface ComposerAdditionMenu {
  open: boolean;
  onClose: () => void;
  attachmentAction?: { onSelect: () => void };
  onSelectGoal?: () => void;
  onOpenRemoteFilePicker?: () => void;
}

interface MentionPluginProps {
  container?: HTMLElement | null;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 已有 Session 的 id；null/undefined = 新建草稿。决定 Plugins 分组的 catalog authority。 */
  sessionId?: string | null;
  /** 自托管 Codex 的实际 Thread，草稿预热目录不传此值。 */
  nativeThreadId?: string | null;
  disabled?: boolean;
  additionMenu?: ComposerAdditionMenu;
  appCommands?: readonly AppSlashCommand[];
  onWhiteboardMentionSelected?: (boardId: string) => void | Promise<void>;
}

export function getWrappedMentionIndex(
  currentIndex: number,
  delta: number,
  itemCount: number,
): number {
  if (itemCount <= 0) {
    return 0;
  }

  // mention 面板的上下键导航以前会把边界直接 clamp 到首/尾项。
  // 这里改成循环取模，保证按上键能从第一项跳到最后一项，按下键也能从最后一项回到第一项。
  return (currentIndex + delta + itemCount) % itemCount;
}

/**
 * 在循环导航的基础上跳过禁选项（V1 同名 Plugin 冲突项）。
 * 全部禁选时保持原地不动，Enter/Tab 的选择守卫会拒绝插入。
 */
export function getNextEnabledMentionIndex(
  currentIndex: number,
  delta: number,
  items: ReadonlyArray<Pick<MentionItem, "disabled">>,
): number {
  if (items.length === 0) {
    return 0;
  }
  let next = getWrappedMentionIndex(currentIndex, delta, items.length);
  for (let step = 0; step < items.length; step++) {
    if (!items[next]?.disabled) {
      return next;
    }
    next = getWrappedMentionIndex(next, delta >= 0 ? 1 : -1, items.length);
  }
  return currentIndex;
}

/**
 * 候选首次出现或异步分组更新时，把选中项收敛到可选条目。
 * 根因：冲突 Plugin 保持可见后可能占据 flatItems[0]；若仍默认选中 0，
 * 第一次 Enter/Tab 会命中禁选项并回落编辑器默认行为，而不是继续键盘导航。
 */
export function coerceEnabledMentionIndex(
  currentIndex: number,
  items: ReadonlyArray<Pick<MentionItem, "disabled">>,
): number {
  if (items.length === 0) {
    return 0;
  }
  const boundedIndex = Math.min(Math.max(currentIndex, 0), items.length - 1);
  if (!items[boundedIndex]?.disabled) {
    return boundedIndex;
  }
  const firstEnabledIndex = items.findIndex((item) => !item.disabled);
  return firstEnabledIndex >= 0 ? firstEnabledIndex : boundedIndex;
}

/**
 * IME 组合期间（拼音未上屏）是否冻结 @ 面板重算：中间态字母会被当作 query 逐字过滤一轮，
 * 面板闪烁且中间态结果错误；composition 提交后 Lexical 会再派发一次 update 完成重算。
 * Android 例外：Chrome + Gboard 对拉丁词也走 composition（整词到空格才 compositionend），
 * 冻结会让手机 Web 的 @ 面板失去逐字过滤，因此 Android 保持实时重算。
 */
export function shouldFreezeMentionRecalcWhileComposing(
  isComposing: boolean,
  userAgent: string,
): boolean {
  return isComposing && !/Android/i.test(userAgent);
}

function $selectMentionToken(token: ActivePromptInputTokenSnapshot | null, candidates: string[]) {
  const selectionState = getCurrentTextNodeSelection();
  if (!selectionState) return null;

  const range = getActivePromptInputTokenReplacementRange(token, selectionState);
  const trigger = range ? token : extractActivePromptInputTrigger(selectionState.textBeforeCursor);
  if (!trigger || (trigger.trigger !== "@" && trigger.trigger !== "$" && trigger.trigger !== "#")) {
    return null;
  }

  const start = range?.start ?? selectionState.cursorOffset - trigger.query.length - 1;
  const end =
    range?.end ??
    selectionState.cursorOffset +
      getActivePromptInputTokenTailLength(trigger, selectionState.textAfterCursor, candidates);
  selectionState.selection.setTextNodeRange(selectionState.node, start, selectionState.node, end);
  return selectionState.selection;
}

export function MentionPlugin({
  workspacePath,
  workspaceIdentity,
  sessionId,
  nativeThreadId,
  provider,
  container,
  disabled = false,
  additionMenu,
  appCommands,
  onWhiteboardMentionSelected,
}: MentionPluginProps & { provider: ZCodeProvider }) {
  const [editor] = useLexicalComposerContext();
  const { intl } = useZCodeIntl();
  const draftProjectId = useZCodeSessionStore(
    (state) => state.getWorkspaceState(workspacePath, workspaceIdentity).draftProjectId,
  );
  const [activeTrigger, setActiveTrigger] = useState<ActivePromptInputTrigger | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const dismissedSignatureRef = useRef<string | null>(null);
  const activeTokenRef = useRef<ActivePromptInputTokenSnapshot | null>(null);
  const additionOpen = additionMenu?.open === true;
  const closeAdditionMenu = additionMenu?.onClose;
  const trigger = additionOpen ? "@" : activeTrigger?.trigger;
  const activeQuery = additionOpen ? "" : (activeTrigger?.query ?? "");
  // 候选过滤会在渲染线程扫描大型 workspace；输入框与搜索共用同一个 query
  // 时，快速输入/删除会让每次按键都同步承担搜索成本。deferred query 只延后候选派生，
  // 不延后编辑器 token、触发器和最终插入，因此输入始终跟手，结果最终收敛到最新 query。
  const deferredActiveQuery = useDeferredValue(activeQuery);
  const hasActiveQuery = hasMentionQuery(activeQuery);
  const activeSignature = useMemo(
    () => (additionOpen ? "+" : getPromptInputTriggerSignature(activeTrigger)),
    [activeTrigger, additionOpen],
  );
  const isOpen = !disabled && (trigger === "@" || trigger === "$" || trigger === "#");
  const isContextTrigger = trigger === "@";
  const isSessionTrigger = trigger === "#";
  const isSkillTrigger = trigger === "$";
  const showNativeReferences = selfHostedBuild && isContextTrigger;
  const appsResult = useCodexAppsMentionProvider(
    workspacePath,
    workspaceIdentity,
    nativeThreadId ?? null,
    deferredActiveQuery,
    isOpen && (isSkillTrigger || showNativeReferences),
  );

  // 修复说明：之前把 @ 面板拆成了两层，导致用户输入 query 后还要再确认一次，
  // 实际感受像“按回车之后才开始搜”。现在改成单层分组面板，query 一变化就直接展示各分组结果。
  const skillsResult = useSkillsMentionProvider(
    workspacePath,
    workspaceIdentity,
    sessionId ?? null,
    provider,
    deferredActiveQuery,
    isOpen && (isSkillTrigger || showNativeReferences),
    false,
    intl.formatMessage({ id: "chat.mention.skills.empty" }),
    intl.formatMessage({ id: "chat.mention.skills.title" }),
  );
  const fileDefaultPreviewLimit = !hasActiveQuery
    ? MENTION_FILES_ONLY_DEFAULT_PREVIEW_LIMIT
    : MENTION_DEFAULT_GROUP_PREVIEW_LIMIT;
  const fileResult = useFileMentionProvider(
    workspacePath,
    workspaceIdentity,
    deferredActiveQuery,
    isOpen && isContextTrigger,
    intl.formatMessage({ id: "chat.mention.files.empty" }),
    intl.formatMessage({ id: "chat.mention.files.title" }),
    fileDefaultPreviewLimit,
    { sessionId, projectId: draftProjectId },
  );
  const whiteboardResult = useWhiteboardMentionProvider(
    workspacePath,
    workspaceIdentity,
    deferredActiveQuery,
    isOpen && isContextTrigger && !selfHostedBuild && Boolean(onWhiteboardMentionSelected),
    intl.formatMessage({ id: "chat.mention.whiteboards.empty" }),
    intl.formatMessage({ id: "chat.mention.whiteboards.title" }),
  );
  const sessionsResult = useSessionsMentionProvider(
    provider,
    workspacePath,
    workspaceIdentity,
    deferredActiveQuery,
    isOpen && (isContextTrigger || isSessionTrigger),
    getSessionMentionWorkspaceScope(trigger),
    intl.formatMessage({ id: "chat.mention.sessions.empty" }),
    intl.formatMessage({ id: "chat.mention.sessions.title" }),
    intl.formatMessage({ id: "project.tasks" }),
  );
  // Plugins 分组：新建草稿（sessionId=null）读 workspace
  // 当前 catalog，已有 Session 读 session-owned 冻结 catalog；冲突项由 provider 标记禁选。
  const pluginsResult = usePluginsMentionProvider(
    workspacePath,
    workspaceIdentity,
    sessionId ?? null,
    deferredActiveQuery,
    isOpen && isContextTrigger,
    intl.formatMessage({ id: "chat.mention.plugins.empty" }),
    intl.formatMessage({ id: "chat.mention.plugins.title" }),
  );

  // 插件 composer.mention 条目的分组（docs/plugins/extension-host.md §16.6）：只在 `@` 面板，
  // 作用域与 Plugins 分组相同（草稿为预热会话）。没有扩展门面（Web、手机远控）时为空。
  const extensionGroups = useExtensionMentionGroups({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    sessionId: sessionId ?? null,
    // 用即时 query 而不是 deferred：插件按 query 远程查询，延后没有收益；面板刚打开时 deferred 值
    // 还是上一次的空串，会多发一次查询，tool 条目还会因此多弹一次审批（运行时日志：同一次输入先查 "" 再查 "qx"）。
    query: activeQuery,
    enabled: isOpen && isContextTrigger && !selfHostedBuild,
  });

  const panelGroups = useMemo<MentionResultGroup<MentionItem>[]>(() => {
    if (trigger === "#" && sessionsResult.groups?.length) {
      return buildVisibleMentionGroups(
        sessionsResult.groups.map((group) => ({
          ...group,
          emptyText: sessionsResult.emptyText,
          loading: sessionsResult.loading,
          errorText: sessionsResult.error?.message ?? null,
        })),
      );
    }
    const groupsById = {
      files: {
        id: "files",
        title: fileResult.title,
        items: fileResult.items,
        loading: fileResult.loading,
        errorText: fileResult.error?.message ?? null,
        emptyText: fileResult.emptyText,
      },
      plugins: {
        id: "plugins",
        title: pluginsResult.title,
        items: pluginsResult.items,
        loading: pluginsResult.loading,
        errorText: pluginsResult.error?.message ?? null,
        emptyText: pluginsResult.emptyText,
      },
      sessions: {
        id: "sessions",
        title: sessionsResult.title,
        items: sessionsResult.items,
        loading: sessionsResult.loading,
        errorText: sessionsResult.error?.message ?? null,
        emptyText: sessionsResult.emptyText,
      },
      skills: {
        id: "skills",
        title: skillsResult.title,
        items: skillsResult.items,
        loading: skillsResult.loading,
        errorText: skillsResult.error?.message ?? null,
        emptyText: skillsResult.emptyText,
      },
      whiteboards: {
        id: "whiteboards",
        title: whiteboardResult.title,
        items: whiteboardResult.items,
        loading: whiteboardResult.loading,
        errorText: whiteboardResult.error?.message ?? null,
        emptyText: whiteboardResult.emptyText,
      },
    } satisfies Record<MentionPanelGroupId, MentionResultGroup<MentionItem>>;

    if (selfHostedBuild) {
      const apps = {
        id: "apps",
        title: appsResult.title,
        items: appsResult.items,
        loading: appsResult.loading,
        errorText: appsResult.error?.message ?? null,
        emptyText: appsResult.emptyText,
      };
      if (trigger === "$") return [groupsById.skills, apps];
      if (trigger === "@") {
        const groups = [
          groupsById.plugins,
          apps,
          groupsById.skills,
          groupsById.files,
          groupsById.sessions,
        ];
        if (hasActiveQuery) return buildVisibleMentionGroups(groups);
        return groups
          .filter((group) => group.id === "apps" || buildVisibleMentionGroups([group]).length > 0)
          .map((group) => ({
            ...group,
            items: group.items.slice(
              0,
              group.id === "files"
                ? MENTION_FILES_ONLY_DEFAULT_PREVIEW_LIMIT
                : MENTION_DEFAULT_GROUP_PREVIEW_LIMIT,
            ),
          }));
      }
    }
    return buildVisibleMentionGroups([
      ...getMentionPanelGroupOrder(trigger).map((groupId) => groupsById[groupId]),
      ...(trigger === "@" ? extensionGroups : []),
    ]);
  }, [
    extensionGroups,
    fileResult.emptyText,
    fileResult.error,
    fileResult.items,
    fileResult.loading,
    fileResult.title,
    trigger,
    hasActiveQuery,
    appsResult.emptyText,
    appsResult.error,
    appsResult.items,
    appsResult.loading,
    appsResult.title,
    pluginsResult.emptyText,
    pluginsResult.error,
    pluginsResult.items,
    pluginsResult.loading,
    pluginsResult.title,
    sessionsResult.emptyText,
    sessionsResult.error,
    sessionsResult.items,
    sessionsResult.groups,
    sessionsResult.loading,
    sessionsResult.title,
    whiteboardResult.emptyText,
    whiteboardResult.error,
    whiteboardResult.items,
    whiteboardResult.loading,
    whiteboardResult.title,
    skillsResult.emptyText,
    skillsResult.error,
    skillsResult.items,
    skillsResult.loading,
    skillsResult.title,
  ]);

  const { attachmentAction, onSelectGoal, onOpenRemoteFilePicker } = additionMenu ?? {};
  const showAddActions = selfHostedBuild && isOpen && isContextTrigger && !hasActiveQuery;
  const addActions = useMemo(() => {
    if (!showAddActions) return [];
    const project = appCommands?.find((command) => command.value === "project");
    const plan = appCommands?.find((command) => command.value === "plan");
    return [
      ...(attachmentAction
        ? [
            {
              id: "add-attachment",
              label: intl.formatMessage({ id: "selfhost.composer.add" }),
              description: "",
              Icon: PaperclipIcon,
              run: attachmentAction.onSelect,
            },
          ]
        : []),
      ...(project
        ? [{ ...project, id: "add-project", label: project.label ?? "/project", Icon: FolderOpen }]
        : []),
      ...(onSelectGoal
        ? [
            {
              id: "add-goal",
              label: intl.formatMessage({ id: "chat.goalBanner.label" }),
              description: intl.formatMessage({ id: "selfhost.composer.goal" }),
              Icon: GoalIcon,
              run: onSelectGoal,
            },
          ]
        : []),
      ...(plan ? [{ ...plan, id: "add-plan", label: plan.label ?? "/plan", Icon: Lightbulb }] : []),
      ...(onOpenRemoteFilePicker
        ? [
            {
              id: "add-files",
              label: intl.formatMessage({ id: "selfhost.composer.files" }),
              description: "",
              Icon: FileSearch,
              run: onOpenRemoteFilePicker,
            },
          ]
        : []),
    ];
  }, [appCommands, attachmentAction, intl, onOpenRemoteFilePicker, onSelectGoal, showAddActions]);

  const panelSections = useMemo<MentionPanelSection[]>(
    () => [
      ...(addActions.length
        ? [
            {
              id: "add",
              title: intl.formatMessage({ id: "chat.composer.addSection" }),
              emptyText: "",
              showHeader: true,
              options: addActions.map(({ id, label, description, Icon }) => ({
                id,
                label,
                description,
                content: (
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <Icon className="size-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
                    <span className="shrink-0 text-ui-base font-medium text-foreground">
                      {label}
                    </span>
                    {description ? (
                      <span className="min-w-0 truncate text-ui-sm text-foreground-subtle">
                        {description}
                      </span>
                    ) : null}
                  </span>
                ),
              })),
            },
          ]
        : []),
      ...panelGroups.map((group) => ({
        id: group.id,
        title: group.title,
        showHeader: selfHostedBuild || trigger === "#" || group.showHeader === true,
        options: group.items.map<MentionPanelOption>((item) => ({
          id: item.id,
          label: item.displayLabel ?? item.label,
          description: item.description,
          // 冲突 Plugin 等禁选项：面板可见但不可选择，行内展示原因（V1 fail closed）。
          disabled: item.disabled,
          disabledReason: item.disabledReason,
          // @ 面板之前只用 label/description 自己拼文件行，导致图标、文件名和路径展示
          // 跟输入框里的 mention token 不一致。这里统一复用 fileDisplay，让面板和 token 使用同一套文件语义展示。
          content:
            item.category === "files" ? (
              <ContextMentionOptionContent item={item} workspacePath={workspacePath} />
            ) : item.category === "skills" || item.category === "apps" ? (
              <AppOrSkillMentionOptionContent item={item} />
            ) : item.category === "whiteboards" ? (
              <span className="min-w-0 flex flex-1 items-center gap-2">
                <PaletteIcon className="size-3.5 shrink-0 text-foreground" />
                <span className="shrink-0 whitespace-nowrap text-ui-base font-medium text-foreground">
                  {item.label}
                </span>
                <span className="min-w-0 truncate text-ui-xs text-foreground-subtlest">
                  {intl.formatMessage(
                    { id: "chat.mention.whiteboards.strokeCount" },
                    { count: item.description },
                  )}
                </span>
              </span>
            ) : item.category === "sessions" ? (
              <ContextMentionOptionContent item={item} workspacePath={workspacePath} />
            ) : item.category === "plugins" ? (
              <PluginMentionOptionContent item={item} />
            ) : item.category === "extensions" ? (
              <ExtensionMentionOptionContent item={item} />
            ) : undefined,
        })),
        loading: group.loading,
        loadingText: intl.formatMessage({
          id: "chat.mention.category.loading",
        }),
        errorText: group.errorText,
        noticeText: group.noticeText ?? null,
        emptyText: group.emptyText,
      })),
    ],
    [addActions, intl, panelGroups, workspacePath, trigger],
  );
  const flatItems = useMemo(
    () => panelSections.flatMap(visibleMentionPanelOptions),
    [panelSections],
  );

  useEffect(() => {
    setSelectedIndex(0);
  }, [activeSignature]);

  useEffect(() => {
    setSelectedIndex((current) => coerceEnabledMentionIndex(current, flatItems));
  }, [flatItems]);

  useEffect(() => {
    if (!disabled) {
      return;
    }

    closeAdditionMenu?.();
    setActiveTrigger(null);
    setSelectedIndex(0);
    activeTokenRef.current = null;
  }, [closeAdditionMenu, disabled]);

  useEffect(() => {
    return editor.registerUpdateListener(
      ({ dirtyElements, dirtyLeaves, editorState, prevEditorState }) => {
        if (disabled) return;
        const selectionOnly = dirtyElements.size === 0 && dirtyLeaves.size === 0;
        // 加号打开时光标仍属于 Lexical。正文发生编辑后关闭加号，让新输入的触发符接管面板。
        if (
          additionOpen &&
          !selectionOnly &&
          editorState.read(() => $getRoot().getTextContent()) !==
            prevEditorState.read(() => $getRoot().getTextContent())
        ) {
          closeAdditionMenu?.();
        }
        if (
          shouldFreezeMentionRecalcWhileComposing(
            editor.isComposing(),
            typeof navigator === "undefined" ? "" : navigator.userAgent,
          )
        ) {
          return;
        }
        editorState.read(() => {
          const selectionState = getCurrentTextNodeSelection();
          const token = selectionState
            ? reconcileActivePromptInputTokenSnapshot(
                activeTokenRef.current,
                selectionState,
                selectionOnly,
              )
            : null;
          if (!token || (token.trigger !== "@" && token.trigger !== "$" && token.trigger !== "#")) {
            activeTokenRef.current = null;
            dismissedSignatureRef.current = null;
            setActiveTrigger(null);
            return;
          }
          activeTokenRef.current = token;
          if (dismissedSignatureRef.current === getPromptInputTriggerSignature(token)) return;
          dismissedSignatureRef.current = null;

          setActiveTrigger((current) =>
            current?.trigger === token.trigger && current.query === token.query
              ? current
              : { query: token.query, trigger: token.trigger },
          );
        });
      },
    );
  }, [additionOpen, closeAdditionMenu, disabled, editor]);

  const dismissPanel = useCallback(() => {
    dismissedSignatureRef.current = getPromptInputTriggerSignature(activeTokenRef.current);
    activeTokenRef.current = null;
    closeAdditionMenu?.();
    setActiveTrigger(null);
    setSelectedIndex(0);
  }, [closeAdditionMenu]);

  const selectOption = useCallback(
    (index: number) => {
      const option = flatItems[index];
      if (!option || option.disabled) return false;
      const action = addActions.find(({ id }) => id === option.id);
      const item = panelGroups.flatMap(({ items }) => items).find(({ id }) => id === option.id);
      const whiteboardId =
        item?.category === "whiteboards" && onWhiteboardMentionSelected ? item.value : null;
      const token = activeTokenRef.current;
      const hasAction = Boolean(action?.run);
      // 先提交 @ 的移除，避免目标前置或弹窗回调读取带旧触发符的草稿。
      editor.update(
        () => {
          if (hasAction || whiteboardId) {
            if (!additionOpen) $selectMentionToken(token, [])?.removeText();
            return;
          }
          if (!item) return;
          const selection = additionOpen
            ? ($getSelection() ?? $getRoot().selectEnd())
            : $selectMentionToken(token, [item.label, item.value, item.markdown]);
          if (!$isRangeSelection(selection)) return;

          const trailingWhitespace = $createTextNode(" ");
          selection.insertNodes([$createPromptMentionNode(item), trailingWhitespace]);
          trailingWhitespace.selectEnd();
        },
        // Lexical 的 discrete 只接受 true，普通引用插入沿用默认批处理。
        hasAction ? { discrete: true } : undefined,
      );

      dismissPanel();
      // 焦点在回调前恢复。项目和设置等回调会自行接管焦点。
      if (action?.run) {
        editor.focus();
        void action.run();
      } else if (whiteboardId) {
        void onWhiteboardMentionSelected?.(whiteboardId);
        requestAnimationFrame(() => editor.focus());
      } else {
        requestAnimationFrame(() => editor.focus());
      }
      return true;
    },
    [
      addActions,
      additionOpen,
      dismissPanel,
      editor,
      flatItems,
      onWhiteboardMentionSelected,
      panelGroups,
    ],
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const unregisterDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => {
        if (flatItems.length === 0) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        setSelectedIndex((prev) => getNextEnabledMentionIndex(prev, 1, flatItems));
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => {
        if (flatItems.length === 0) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        setSelectedIndex((prev) => getNextEnabledMentionIndex(prev, -1, flatItems));
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (!selectOption(selectedIndex)) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterTab = editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => {
        if (!selectOption(selectedIndex)) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterEscape = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      (event) => {
        event?.preventDefault();
        event?.stopPropagation();

        dismissPanel();
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterBlur = editor.registerCommand(
      BLUR_COMMAND,
      () => {
        dismissPanel();
        dismissedSignatureRef.current = null;
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );

    return () => {
      unregisterDown();
      unregisterUp();
      unregisterEnter();
      unregisterTab();
      unregisterEscape();
      unregisterBlur();
    };
  }, [dismissPanel, editor, flatItems, isOpen, selectOption, selectedIndex]);

  const panelTitle = intl.formatMessage({
    id: showAddActions ? "chat.composer.addSection" : "chat.mention.title",
  });
  const panelDescription =
    selfHostedBuild || hasActiveQuery
      ? ""
      : trigger === "#"
        ? intl.formatMessage({ id: "chat.mention.sessions.searchHint" })
        : trigger === "$"
          ? intl.formatMessage({ id: "chat.mention.skills.searchHint" })
          : intl.formatMessage({ id: "chat.mention.searchHint" });
  const panelEmptyText = hasActiveQuery
    ? intl.formatMessage({ id: "chat.mention.emptyResults" })
    : "";

  if (!isOpen || !container) {
    return null;
  }

  return createPortal(
    <MentionPanel
      title={panelTitle}
      description={panelDescription}
      footer={
        showAddActions ? (
          <p className="border-t border-border px-3 py-1.5 text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "selfhost.composer.searchHint" })}
          </p>
        ) : undefined
      }
      compact={selfHostedBuild}
      trigger={additionOpen ? "+" : (trigger ?? "@")}
      sections={panelSections}
      emptyText={panelEmptyText}
      selectedIndex={selectedIndex}
      selectionScope={activeSignature}
      hasActiveQuery={hasActiveQuery}
      onSelect={selectOption}
    />,
    container,
  );
}
