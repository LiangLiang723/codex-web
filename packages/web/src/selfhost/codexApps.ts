import {
  codexAppSchema,
  codexAppDetailsSchema,
  codexAppsListSchema,
  codexAppWriteResultSchema,
} from "@zcode/shared";
import { z } from "zod";
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
    listInstalled: (force) =>
      gateway.request(endpoint, codexAppsListSchema, "POST", {
        hostId,
        operation: "installed",
        force,
      }),
    listForComposer: async (threadId) => {
      const { apps } = await gateway.request(
        endpoint,
        z.object({ apps: z.array(codexAppSchema) }),
        "POST",
        {
          hostId,
          operation: "available",
          threadId,
        },
      );
      return apps;
    },
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
