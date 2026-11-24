import type { AppDetailsProps } from "./contract.js";

// 变更一个工具后，同步列表中的可调用状态和当前工具详情。
export async function refreshAfterToolChange(
  { app, service, refreshApps }: AppDetailsProps,
  name: string,
  enabled: boolean,
) {
  await service.setEnabled(app.id, enabled, name);
  const [detail] = await Promise.all([service.detail(app.id), refreshApps()]);
  return detail;
}
