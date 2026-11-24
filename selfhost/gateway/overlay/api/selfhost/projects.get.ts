import { getValidatedQuery } from "h3";
import { z } from "zod";
import { allKnownProjects, refreshProjects } from "../../utils/selfhost-projects";
import { hostStore } from "../../utils/gateway/state/hosts";
import { defineGatewayEventHandler } from "../../utils/gateway/http/errors";
import { requireRecord } from "../../utils/gateway/http/validation/common";
export default defineGatewayEventHandler(async (event) => {
  const { hostId, refresh, organization } = await getValidatedQuery(event, (v) =>
    z
      .object({
        hostId: z.coerce.number().int().positive().optional(),
        refresh: z.literal("1").optional(),
        organization: z.literal("1").optional(),
      })
      .parse(v),
  );
  const user = event.context.auth!.user.id;
  if (!hostId) return allKnownProjects(user);
  const catalog = await refreshProjects(
    user,
    requireRecord(hostStore.getWithSecret(hostId), "Host not found"),
    refresh === "1",
  );
  return organization ? catalog : catalog.items;
});
