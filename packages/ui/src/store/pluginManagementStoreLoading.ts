import type { IPluginManagementService } from "@zcode/services";
import {
  remoteHostIdFromWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  type ZCodePluginsOverviewResult,
  type ZCodePluginScope,
} from "@zcode/shared";
import { selfHostedBuild } from "@zcode/shared/runtimeEnv";
import { logger } from "@/logger.js";
import type { PluginManagementState } from "@/store/pluginManagementStore.js";

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function buildWorkspaceKey(
  workspacePath: string,
  workspaceIdentity: string | null,
  authorityKey: string | null,
): string {
  return `${authorityKey?.trim() || "workspace"}\0${workspaceIdentity?.trim() || workspacePath}`;
}

// 只共享同服务、同身份、同配置投影的在途查询；每个视图仍独立写回和保存错误态。
type CatalogSource = "configured" | "account";
const catalogSources: readonly CatalogSource[] = ["configured", "account"];
type CatalogStatus = { status: "loading" | "loaded" } | { status: "error"; message: string };
export type NativeCatalogStatus = Record<CatalogSource, CatalogStatus>;
type CatalogSnapshots = Partial<Record<CatalogSource, ZCodePluginsOverviewResult>>;
type CatalogRead = { source: CatalogSource; task: Promise<ZCodePluginsOverviewResult> };
type PluginLoad = {
  task: Promise<Partial<PluginManagementState>>;
  catalogs: CatalogRead[];
  revision: number;
};
const loadsByService = new WeakMap<IPluginManagementService, Map<string, PluginLoad>>();
const nativeLoadByStore = new WeakMap<
  () => PluginManagementState,
  { key: string; snapshots: CatalogSnapshots }
>();
export interface PluginManagementChange {
  owner?: () => PluginManagementState;
  workspacePath: string;
  workspaceIdentity: string | null;
  authorityKey: string | null;
  scope: ZCodePluginScope;
}
const changeListeners = new Set<(change: PluginManagementChange) => void | Promise<void>>();
let revision = 0;
export const getPluginManagementRevision = () => revision;
export function subscribePluginManagementChanges(
  listener: (change: PluginManagementChange) => void | Promise<void>,
) {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}
export function notifyPluginManagementChange(change: PluginManagementChange): void {
  revision += 1;
  // 派生视图不能拖住已成功的写入；发布失效信号后，后台查询各自收口。
  for (const listener of changeListeners) {
    void Promise.resolve()
      .then(() => listener(change))
      .catch((error: unknown) => {
        logger.warn("[plugins] background projection refresh failed", {
          message: toMessage(error),
        });
      });
  }
}
export function isPluginManagementChangeRelevant(
  state: Pick<
    PluginManagementState,
    "workspacePath" | "workspaceIdentity" | "authorityKey" | "configScope"
  >,
  change: PluginManagementChange,
): boolean {
  if (!state.workspacePath) return false;
  if (change.scope === "workspace") {
    return (
      state.configScope !== "user" &&
      buildWorkspaceKey(state.workspacePath, state.workspaceIdentity, state.authorityKey) ===
        buildWorkspaceKey(change.workspacePath, change.workspaceIdentity, change.authorityKey)
    );
  }
  const hostKey = (target: { workspaceIdentity: string | null; authorityKey: string | null }) => {
    const identity = target.workspaceIdentity ?? "";
    const sourceServerId = parseRemoteWorkspaceIdentity(identity)?.sourceServerId;
    // Source 用户设置没有项目 identity，但和该 Source 下项目共享用户配置。
    return (
      target.authorityKey ??
      (sourceServerId
        ? `source-settings:${sourceServerId}`
        : (remoteHostIdFromWorkspaceIdentity(identity) ?? "local"))
    );
  };
  return hostKey(state) === hostKey(change);
}

// 单个 operationId 会被后一次安装覆盖；每次调用持有独立条目，完成时只移除自己。
// 通过条目身份清理，同名并发操作以及切换配置层后的新操作都不会被误清除。
export function beginPluginOperation(
  set: (partial: Partial<PluginManagementState>) => void,
  get: () => PluginManagementState,
  id: string,
): () => void {
  const entry = { id };
  set({
    activeOperations: [...get().activeOperations, entry],
    operationVersion: get().operationVersion + 1,
    error: null,
    lastFailedPluginId: null,
  });
  return () => {
    set({ activeOperations: get().activeOperations.filter((operation) => operation !== entry) });
  };
}

export async function runWorkspaceOperation(
  set: (partial: Partial<PluginManagementState>) => void,
  get: () => PluginManagementState,
  pluginService: IPluginManagementService,
  operationId: string,
  operation: (workspace: { workspacePath: string; workspaceIdentity?: string }) => Promise<void>,
  scope: ZCodePluginScope = "user",
): Promise<boolean> {
  const { workspacePath, workspaceIdentity, authorityKey, configScope } = get();
  if (!workspacePath) return false;
  const finish = beginPluginOperation(set, get, operationId);
  const operationVersion = get().operationVersion;
  const isCurrentContext = (): boolean => {
    const current = get();
    return (
      current.workspacePath === workspacePath &&
      current.workspaceIdentity === workspaceIdentity &&
      current.authorityKey === authorityKey &&
      current.configScope === configScope
    );
  };
  const ownsVisibleOperation = (): boolean =>
    isCurrentContext() && get().operationVersion === operationVersion;
  try {
    await operation({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    });
    // 并发刷新不能把已成功落盘的安装报告成失败；结果只受当前目标上下文约束。
    if (!isCurrentContext()) {
      await notifyPluginManagementChange({
        owner: get,
        workspacePath,
        workspaceIdentity,
        authorityKey,
        scope,
      });
      return false;
    }
    await loadInto(set, get, {
      workspacePath,
      workspaceIdentity,
      authorityKey,
      configScope,
      pluginService,
      fresh: true,
    });
    await notifyPluginManagementChange({
      owner: get,
      workspacePath,
      workspaceIdentity,
      authorityKey,
      scope,
    });
    return isCurrentContext();
  } catch (error) {
    // marketplace add/update 等通用操作失败：无插件目标，归属清空。
    logger.error("[plugins] operation failed", { operationId, error: toMessage(error) });
    // 旧操作不能覆盖同一配置层中新操作的错误态；只有最近发起的操作才回写。
    if (ownsVisibleOperation()) {
      set({ error: toMessage(error), lastFailedPluginId: null });
    }
    return false;
  } finally {
    finish();
  }
}

interface PluginLoadParams {
  workspacePath: string;
  workspaceIdentity: string | null;
  authorityKey: string | null;
  configScope: ZCodePluginScope | null;
  pluginService: IPluginManagementService;
  fresh?: boolean;
  background?: boolean;
}
export async function loadInto(
  set: (partial: Partial<PluginManagementState>) => void,
  get: () => PluginManagementState,
  params: PluginLoadParams,
): Promise<void> {
  let inFlightLoads = loadsByService.get(params.pluginService);
  if (!inFlightLoads) {
    inFlightLoads = new Map();
    loadsByService.set(params.pluginService, inFlightLoads);
  }
  const workspaceKey = buildWorkspaceKey(
    params.workspacePath,
    params.workspaceIdentity,
    params.authorityKey,
  );
  const loadKey = `${workspaceKey}\0${params.configScope ?? "effective"}`;
  const existing = inFlightLoads.get(loadKey);
  const needsFreshLoad =
    params.fresh || (params.background && (existing?.revision ?? revision) < revision);
  // 变更前启动的查询不能充当变更后的刷新；同一轮通知的新查询仍可共用。
  if (existing && needsFreshLoad && !selfHostedBuild) {
    await existing.task;
    return loadInto(set, get, { ...params, fresh: false });
  }
  const request = (needsFreshLoad ? undefined : existing) ?? {
    task: runLoadInto({ ...params, workspaceKey }),
    catalogs: selfHostedBuild
      ? catalogSources.map((source) => ({
          source,
          task: params.pluginService.getPluginsOverview({
            ...pluginView(params),
            codexCatalogSource: source,
          }),
        }))
      : [],
    revision,
  };
  inFlightLoads.set(loadKey, request);
  const isCurrent = () => {
    const current = get();
    return (
      current.workspacePath === params.workspacePath &&
      current.workspaceIdentity === params.workspaceIdentity &&
      current.authorityKey === params.authorityKey &&
      current.configScope === params.configScope
    );
  };
  const publish = (result: Partial<PluginManagementState>) => {
    if (!isCurrent()) return;
    const current = get();
    // 其它视图的成功操作只刷新数据，不能抹掉本视图尚未处理的操作错误。
    set(
      params.background && current.error
        ? { ...result, error: current.error, lastFailedPluginId: current.lastFailedPluginId }
        : result,
    );
  };
  const release = () => {
    if (inFlightLoads.get(loadKey) === request) inFlightLoads.delete(loadKey);
  };
  if (selfHostedBuild) {
    const key = `${loadKey}\0${params.workspacePath}`;
    const previous = nativeLoadByStore.get(get);
    const projection = { key, snapshots: previous?.key === key ? { ...previous.snapshots } : {} };
    nativeLoadByStore.set(get, projection);
    const catalogs = new Map<CatalogSource, PromiseSettledResult<ZCodePluginsOverviewResult>>();
    const ownsProjection = () => nativeLoadByStore.get(get) === projection && isCurrent();
    let installed: Awaited<typeof request.task> | undefined;
    if (ownsProjection())
      set({
        nativeCatalogStatus: { configured: { status: "loading" }, account: { status: "loading" } },
      });
    const publishCatalog = (initial: boolean) => {
      if (!installed || !ownsProjection()) return;
      const catalog = projectNativeCatalog(installed, projection.snapshots, catalogs);
      if (initial) {
        publish({
          ...installed,
          ...catalog,
          describeCache: invalidateChangedNativeDetails(get(), installed),
        });
      } else set(catalog);
    };
    const reads = request.catalogs.map(({ source, task }) =>
      task
        .then(
          (value) => {
            catalogs.set(source, { status: "fulfilled", value });
            const failed = new Set(
              value.marketplaces.filter((market) => market.refreshFailure).map(({ id }) => id),
            );
            const previousItems = projection.snapshots[source]?.availablePlugins ?? [];
            // 部分市场失败时，只保留失败来源的旧目录，成功来源使用本次读到的完整结果。
            projection.snapshots[source] = {
              ...value,
              availablePlugins: [
                ...value.availablePlugins,
                ...previousItems.filter(({ marketplace }) => failed.has(marketplace)),
              ],
            };
          },
          (reason: unknown) => catalogs.set(source, { status: "rejected", reason }),
        )
        .then(() => publishCatalog(false)),
    );
    // 配置写入和已安装管理只等有效状态。未完成的市场随后按当前工作区的查询世代回填。
    void Promise.allSettled([request.task, ...reads]).then(release);
    installed = await request.task;
    publishCatalog(true);
    return;
  }
  try {
    publish(await request.task);
  } finally {
    release();
  }
}

function pluginView(params: PluginLoadParams) {
  return {
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    ...(params.configScope ? { configScope: params.configScope } : {}),
  };
}

function projectNativeCatalog(
  installed: Partial<PluginManagementState>,
  snapshots: CatalogSnapshots,
  catalogs: Map<CatalogSource, PromiseSettledResult<ZCodePluginsOverviewResult>>,
): Partial<PluginManagementState> {
  const markets = new Map((installed.marketplaces ?? []).map((item) => [item.id, item]));
  const available = new Map((installed.availablePlugins ?? []).map((item) => [item.id, item]));
  const installedIds = new Set([
    ...(installed.plugins ?? []).map(({ id }) => id),
    ...(installed.installedPlugins ?? []).map(({ id }) => id),
  ]);
  const nativeCatalogStatus: NativeCatalogStatus = {
    configured: { status: "loading" },
    account: { status: "loading" },
  };
  for (const source of catalogSources) {
    const result = catalogs.get(source);
    const snapshot = snapshots[source];
    for (const item of snapshot?.marketplaces ?? []) {
      const native = markets.get(item.id);
      markets.set(item.id, { ...item, name: native?.name ?? item.name });
    }
    for (const item of snapshot?.availablePlugins ?? []) {
      const native = available.get(item.id);
      // 目录与 App Server 的快照可能出自不同时间。安装及启用态由已安装读取裁决。
      available.set(item.id, {
        ...item,
        ...native,
        installPolicy: item.installPolicy ?? native?.installPolicy,
        installed: installed.marketplaceAvailabilityKnown
          ? installedIds.has(item.id)
          : item.installed,
      });
    }
    if (result?.status === "rejected") {
      nativeCatalogStatus[source] = { status: "error", message: toMessage(result.reason) };
    } else if (result?.status === "fulfilled") {
      const message = result.value.diagnostics.map((diagnostic) => diagnostic.message).join("\n");
      nativeCatalogStatus[source] = message ? { status: "error", message } : { status: "loaded" };
    }
  }
  const counts = new Map<string, number>();
  for (const item of available.values())
    counts.set(item.marketplace, (counts.get(item.marketplace) ?? 0) + 1);
  return {
    marketplaces: [...markets.values()].map((market) => ({
      ...market,
      pluginCount: counts.get(market.id) ?? 0,
    })),
    availablePlugins: [...available.values()],
    marketplaceAvailabilityKnown: nativeCatalogStatus.configured.status === "loaded",
    nativeCatalogStatus,
  };
}

function invalidateChangedNativeDetails(
  previous: PluginManagementState,
  installed: Partial<PluginManagementState>,
): PluginManagementState["describeCache"] {
  const before = new Map(previous.installedPlugins.map((plugin) => [plugin.id, plugin]));
  const after = new Map(installed.installedPlugins?.map((plugin) => [plugin.id, plugin]));
  // 候选详情不含安装后才发现的技能，安装态或启用态变化时必须重新读取。
  return Object.fromEntries(
    Object.entries(previous.describeCache).filter(([id]) => {
      const old = before.get(id);
      const next = after.get(id);
      return old?.version === next?.version && old?.enabled === next?.enabled;
    }),
  );
}

async function runLoadInto(
  params: PluginLoadParams & { workspaceKey: string },
): Promise<Partial<PluginManagementState>> {
  // 列表的单插件协议错误曾丢弃成功目录；分别收口，失败接口不在这里重复请求。
  const [listResult, overviewResult] = await Promise.allSettled([
    params.pluginService.listPlugins(pluginView(params)),
    params.pluginService.getPluginsOverview({
      ...pluginView(params),
      ...(selfHostedBuild ? { codexCatalogSource: "installed" as const } : {}),
    }),
  ]);
  const errors: string[] = [];
  for (const [method, result] of [
    ["list", listResult],
    ["overview", overviewResult],
  ] as const) {
    if (result.status === "rejected") {
      const message = toMessage(result.reason);
      errors.push(message);
      logger.error(`[plugins] ${method} failed`, {
        workspacePath: params.workspacePath,
        workspaceKey: params.workspaceKey,
        error: message,
      });
    }
  }
  const list = listResult.status === "fulfilled" ? listResult.value : undefined;
  const overview = overviewResult.status === "fulfilled" ? overviewResult.value : undefined;
  return {
    plugins: list?.plugins ?? [],
    marketplaces: overview?.marketplaces ?? [],
    // 目录失败表示来源未知，不能把仍在工作的已安装插件误判为孤立安装。
    marketplaceAvailabilityKnown: overview !== undefined,
    availablePlugins: overview?.availablePlugins ?? [],
    installedPlugins: overview?.installedPlugins ?? [],
    restorableBuiltins: overview?.restorableBuiltins ?? [],
    diagnostics: [...(list?.diagnostics ?? []), ...(overview?.diagnostics ?? [])],
    loading: false,
    lastFailedPluginId: null,
    error: errors.length > 0 ? errors.join("\n") : null,
  };
}
