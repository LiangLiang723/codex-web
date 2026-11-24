/**
 * codex-apps-settings 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const codexAppsSettingsModule = {
  id: "codex-apps-settings",
  requires: ["shared", "ui"],
  provides: ["codex-apps-settings"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
