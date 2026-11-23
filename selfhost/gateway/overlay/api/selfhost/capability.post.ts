import { readValidatedBody } from "h3";
import { z } from "zod";
import { threadBroker } from "../../utils/gateway/runtime/broker";
import { hostStore } from "../../utils/gateway/state/hosts";
import { defineGatewayEventHandler } from "../../utils/gateway/http/errors";
import { requireRecord } from "../../utils/gateway/http/validation/common";
const methods = z.enum([
  "skills/list",
  "skills/config/write",
  "plugin/list",
  "plugin/installed",
  "plugin/read",
  "plugin/install",
  "plugin/uninstall",
  "marketplace/add",
  "marketplace/remove",
  "marketplace/upgrade",
  "mcpServerStatus/list",
  "thread/archive",
  "thread/unarchive",
  "thread/name/set",
  "thread/compact/start",
]);
const body = z
  .object({
    hostId: z.number().int().positive(),
    method: methods,
    params: z.record(z.string(), z.unknown()),
  })
  .strict();
export default defineGatewayEventHandler(async (event) => {
  const { hostId, method, params } = await readValidatedBody(event, (v) => body.parse(v));
  const host = requireRecord(hostStore.getWithSecret(hostId), "Host not found");
  return { value: await threadBroker.selfhostCapability(host, method, params) };
});
