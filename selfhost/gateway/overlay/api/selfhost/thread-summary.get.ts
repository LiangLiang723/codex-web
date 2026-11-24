import { getValidatedQuery } from "h3";
import { z } from "zod";
import { gatewayThreadFromAppServer } from "../../utils/gateway/protocol/gateway-thread";
import { defineGatewayEventHandler } from "../../utils/gateway/http/errors";
import { requireRecord } from "../../utils/gateway/http/validation/common";
import { hostStore } from "../../utils/gateway/state/hosts";
import { readSelfhostThreadSummary } from "../../utils/selfhost-thread-summary";

export default defineGatewayEventHandler(async (event) => {
  const { hostId, threadId } = await getValidatedQuery(event, (query) =>
    z
      .object({ hostId: z.coerce.number().int().positive(), threadId: z.string().min(1) })
      .parse(query),
  );
  const host = requireRecord(hostStore.getWithSecret(hostId), "Host not found");
  const thread = await readSelfhostThreadSummary(host, threadId);
  return { thread: thread ? gatewayThreadFromAppServer(hostId, thread) : null };
});
