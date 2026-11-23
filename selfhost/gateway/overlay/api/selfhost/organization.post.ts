import { readValidatedBody } from "h3";
import { z } from "zod";
import { taskGroups, automations } from "../../utils/selfhost-organization";
import { defineGatewayEventHandler } from "../../utils/gateway/http/errors";
import { hostStore } from "../../utils/gateway/state/hosts";
import { requireRecord } from "../../utils/gateway/http/validation/common";
const input = z.object({
  hostId: z.number().int().positive(),
  cwd: z.string().startsWith("/"),
  channel: z.enum(["task-groups", "zcode-agent"]),
  method: z.string().max(64),
  args: z.array(z.unknown()).max(4),
});
export default defineGatewayEventHandler(async (event) => {
  const p = await readValidatedBody(event, (v) => input.parse(v));
  requireRecord(hostStore.get(p.hostId), "Host not found");
  const user = event.context.auth!.user.id;
  return {
    value:
      p.channel === "task-groups"
        ? taskGroups(user, p.hostId, p.method, p.args)
        : await automations(user, p.hostId, p.cwd, p.method, p.args),
  };
});
