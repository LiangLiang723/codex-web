import { catalogEvents } from "./gateway/config/pinned-thread-events";
import { userConfigMutationService } from "./gateway/config/user-config-mutation-service";
import { gatewayLog } from "./gateway/logging";
import { gatewayEventStore } from "./gateway/state/gateway-events";
import { currentGatewayUserId } from "./gateway/state/memory";
import { remoteHosts } from "./gateway/state/remote-hosts";
import { runtimeConfigStore } from "./gateway/state/runtime-config";
import { threadMetadataStore } from "./gateway/state/thread-metadata";
import { threadSnapshotStore } from "./gateway/state/thread-snapshots";
import { clearDeletedThreadUnread } from "./selfhost-thread-organization";

function discardAccountThread(hostId: number, threadId: string) {
  const userId = currentGatewayUserId();
  if (userId === null) return;
  try {
    clearDeletedThreadUnread(userId, hostId, threadId);
    threadMetadataStore.delete(hostId, threadId);
    const { pinnedThreads } = runtimeConfigStore.export();
    const remaining = pinnedThreads.filter(
      (pin) => pin.hostId !== hostId || pin.threadId !== threadId,
    );
    if (remaining.length !== pinnedThreads.length)
      userConfigMutationService.commit(userId, () =>
        runtimeConfigStore.replacePinnedThreads(remaining),
      );
  } catch {
    // 原生删除已经完成，派生组织数据清理错误不应让浏览器继续显示原会话。
    gatewayLog("warn", "gateway", "could not clear deleted thread navigation metadata");
  } finally {
    catalogEvents.publish(userId, { hostId, threadId });
  }
}

export function discardSelfhostThread(hostId: number, threadId: string) {
  if (currentGatewayUserId() === null) return;
  threadSnapshotStore.delete(hostId, threadId);
  gatewayEventStore.delete(hostId, threadId);
  const remoteKey = remoteHosts.key(hostId);
  if (remoteKey === null) discardAccountThread(hostId, threadId);
  else remoteHosts.forEachAlias(remoteKey, (aliasId) => discardAccountThread(aliasId, threadId));
}
