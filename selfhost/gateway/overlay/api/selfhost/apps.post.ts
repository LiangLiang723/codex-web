import { readValidatedBody } from "h3";
import { remoteHostIdentity } from "~~/shared/utils/workspace";
import { defineGatewayEventHandler } from "../../utils/gateway/http/errors";
import { requireRecord } from "../../utils/gateway/http/validation/common";
import { threadBroker } from "../../utils/gateway/runtime/broker";
import { hostStore } from "../../utils/gateway/state/hosts";
import { remoteHosts } from "../../utils/gateway/state/remote-hosts";
import { appRequest, manageCodexApps } from "../../utils/selfhost-apps";

export default defineGatewayEventHandler(async (event) => {
  const body = await readValidatedBody(event, (value) => appRequest.parse(value));
  const host = requireRecord(hostStore.getWithSecret(body.hostId), "Host not found");
  const client = await threadBroker.getHostClient(host);
  const verified = remoteHosts.verifiedIdentityKey(host.id);
  if (!verified) throw Error("SSH host identity is not verified");
  return manageCodexApps((method, params) => {
    if (method === "config/value/write") {
      // 目录读取和配置写入之间，用户可能删除或替换主机。对同一已验证身份提交修改。
      const current = hostStore.getWithSecret(host.id);
      if (
        !current ||
        current.createdAt !== host.createdAt ||
        remoteHostIdentity(current) !== remoteHostIdentity(host) ||
        remoteHosts.verifiedIdentityKey(host.id) !== verified
      ) {
        throw Error("The SSH host changed. Reopen the workspace to update its apps.");
      }
    }
    return client.request(method, params);
  }, body);
});
