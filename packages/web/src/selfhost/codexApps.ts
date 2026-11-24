import {
  codexAppDetailsSchema,
  codexAppsListSchema,
  codexAppWriteResultSchema,
} from "@zcode/shared";
import type { ICodexAppsService } from "@zcode/shared";
import type { Gateway } from "./gateway.js";

export function createCodexAppsService(gateway: Gateway, hostId: number): ICodexAppsService {
  const endpoint = "/api/selfhost/apps";
  return {
    list: (force, cursor) =>
      gateway.request(endpoint, codexAppsListSchema, "POST", {
        hostId,
        operation: "list",
        force,
        cursor,
      }),
    detail: (id) =>
      gateway.request(endpoint, codexAppDetailsSchema, "POST", { hostId, operation: "detail", id }),
    setEnabled: (id, enabled, tool) =>
      gateway.request(endpoint, codexAppWriteResultSchema, "POST", {
        hostId,
        operation: "setEnabled",
        id,
        enabled,
        tool,
      }),
  };
}
