import { readValidatedBody } from "h3";
import { z } from "zod";
import { threadBroker } from "../../utils/gateway/runtime/broker";
import { hostStore } from "../../utils/gateway/state/hosts";
import { defineGatewayEventHandler } from "../../utils/gateway/http/errors";
import { requireRecord } from "../../utils/gateway/http/validation/common";
const methods = z.enum([
  "skills/list",
  "skills/config/write",
  "plugin/installed",
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
  if (method === "thread/name/set") {
    const { threadId, name } = z
      .object({
        threadId: z.string().trim().min(1),
        name: z.string().trim().min(1).max(200),
      })
      .parse(params);
    return { value: await threadBroker.renameThread(host, threadId, name) };
  }
  if (method === "skills/config/write") {
    const skill = z.object({ path: z.string().startsWith("/").max(4096), enabled: z.boolean() })
      .strict().parse(params);
    return { value: await threadBroker.selfhostCapability(host, method, skill) };
  }
  return { value: await threadBroker.selfhostCapability(host, method, params) };
});
