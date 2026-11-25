import { readValidatedBody } from "h3";
import { z } from "zod";
import { defineGatewayEventHandler } from "../../utils/gateway/http/errors";
import { requireRecord } from "../../utils/gateway/http/validation/common";
import { hostStore } from "../../utils/gateway/state/hosts";
import { callWorkspace } from "../../utils/selfhost-workspace";
const request = z
  .object({
    hostId: z.number().int().positive(),
    channel: z.enum([
      "file",
      "git",
      "system",
      "skills",
      "commands",
      "memory",
      "output-style",
      "workflows",
      "user-instructions",
    ]),
    method: z.string().regex(/^[a-z][A-Za-z0-9]{0,80}$/),
    args: z.array(z.unknown()).max(8),
  })
  .strict();
export default defineGatewayEventHandler(async (event) => {
  const { hostId, ...rpc } = await readValidatedBody(event, (value) => request.parse(value));
  const host = requireRecord(hostStore.getWithSecret(hostId), "Host not found");
  return { value: await callWorkspace(host, rpc) };
});
