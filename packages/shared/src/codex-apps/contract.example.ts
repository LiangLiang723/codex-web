import type { ICodexAppsService } from "./contract.js";

// 从同一主机的目录选择应用，再读取该应用实际公布的工具。
export async function firstCallableApp(service: ICodexAppsService) {
  const { apps } = await service.list(false);
  const app = apps.find((entry) => entry.callable === true);
  return app ? service.detail(app.id) : null;
}
