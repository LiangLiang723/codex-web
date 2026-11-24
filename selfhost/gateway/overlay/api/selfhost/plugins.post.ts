import { readValidatedBody } from "h3";
import { defineGatewayEventHandler } from "../../utils/gateway/http/errors";
import { requireRecord } from "../../utils/gateway/http/validation/common";
import { hostStore } from "../../utils/gateway/state/hosts";
import {
  manageNativePlugins,
  nativePluginRequestSchema,
} from "../../utils/selfhost-native-plugins";

export default defineGatewayEventHandler(async (event) => {
  const request = await readValidatedBody(event, (value) => nativePluginRequestSchema.parse(value));
  const host = requireRecord(hostStore.getWithSecret(request.hostId), "Host not found");
  return { value: await manageNativePlugins(host, request) };
});
