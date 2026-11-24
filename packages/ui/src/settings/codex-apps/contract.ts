import type { CodexApp, ICodexAppsService } from "@zcode/shared";

export interface AppDetailsProps {
  app: CodexApp;
  service: ICodexAppsService;
  back(): void;
  refreshApps(): Promise<void>;
  openingConnection(): void;
}
