import { createContext } from "react";

/** 菜单持有切换意图；输入框只投影当前草稿是否允许提交，不保存第二份草稿。 */
export const ComposerSubmissionPendingContext = createContext<((pending: boolean) => void) | null>(
  null,
);

/** 将菜单的按钮和输入框快捷操作接到同一个开关。 */
export const ComposerProjectPickerContext = createContext<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
} | null>(null);
