import {
  zcodePluginsDescribeResultSchema,
  zcodePluginsInstallResultSchema,
  zcodePluginsListResultSchema,
  zcodePluginsOverviewResultSchema,
  zcodePluginsReferenceCatalogResultSchema,
  zcodePluginsSetEnabledResultSchema,
  type ZCodePluginDiagnostic,
  type ZCodePluginInfo,
  type ZCodePluginMarketplaceSummary,
  type ZCodePluginStoreListing,
} from "@zcode/shared";
import { z } from "zod";
import type { Gateway, Message } from "./gateway.js";
import { array, rec, str } from "./nativeValues.js";

type AppRequest = (method: string, params: Message) => Promise<Message>;
type Entry = {
  id: string;
  name: string;
  marketplace: string;
  description?: string;
  version?: string;
  installed: boolean;
  enabled: boolean;
  rootPath: string;
  account: boolean;
  policyBlocked?: true;
  installPolicy?: "NOT_AVAILABLE";
  listing?: ZCodePluginStoreListing;
};
type CatalogSource = "installed" | "configured" | "account";
type Inventory = {
  entries: Entry[];
  markets: ZCodePluginMarketplaceSummary[];
  issues: ZCodePluginDiagnostic[];
};
const catalogLoads = new WeakMap<Gateway, Map<string, Promise<Inventory>>>();
const accountMarketplace = "openai-curated-remote";
const official = new Set(["openai-curated", accountMarketplace, "openai-bundled"]);
const pluginEnvelope = z.object({ value: z.unknown() });
const refreshFailureSchema = z.object({
  code: z.string(),
  failedAt: z.string(),
  message: z.string(),
});

function readCliEntry(value: Message): Entry {
  const source = rec(value.source);
  return {
    id: str(value.pluginId),
    name: str(value.name),
    marketplace: str(value.marketplaceName),
    version: str(value.version) || undefined,
    installed: value.installed === true,
    enabled: value.enabled === true,
    rootPath: str(value.installedPath) || str(source.path),
    account: source.source === "remote" || value.marketplaceName === accountMarketplace,
    policyBlocked: value.availability === "DISABLED_BY_ADMIN" ? true : undefined,
    installPolicy: value.installPolicy === "NOT_AVAILABLE" ? "NOT_AVAILABLE" : undefined,
  };
}

function pluginInfo({
  id,
  name,
  marketplace,
  enabled,
  account,
  description,
  version,
  rootPath,
  policyBlocked,
}: Entry): ZCodePluginInfo {
  return {
    id,
    name,
    marketplace,
    enabled,
    description,
    version,
    rootPath,
    source: account ? "codex-account" : "cache",
    nativePolicyBlocked: policyBlocked,
    nativeUninstallRequiresAccount:
      account && marketplace !== accountMarketplace ? true : undefined,
    skillRootCount: 0,
    commandRootCount: 0,
    mcpServerNames: [],
  };
}

function readInstalled(result: Message) {
  const markets = array(result.marketplaces);
  return markets.flatMap((market) =>
    array(market.plugins).flatMap((item): Entry[] => {
      const id = str(item.id);
      const name = str(item.name);
      const marketplace = str(market.name);
      if (!id || !name || !marketplace || item.installed !== true) return [];
      const details = rec(item.interface);
      const source = rec(item.source);
      return [
        {
          id,
          name,
          marketplace,
          installed: true,
          enabled: item.enabled === true,
          description: str(details.shortDescription) || str(details.longDescription) || undefined,
          version: str(item.localVersion) || str(item.version) || undefined,
          rootPath: str(source.path),
          // App Server 用 type 标记来源，CLI JSON 才使用 source。
          account: source.type === "remote" || marketplace === accountMarketplace,
          policyBlocked: item.availability === "DISABLED_BY_ADMIN" ? true : undefined,
          installPolicy: item.installPolicy === "NOT_AVAILABLE" ? "NOT_AVAILABLE" : undefined,
          listing: {
            displayName: str(details.displayName) || undefined,
            author: str(details.developerName) || undefined,
            category: str(details.category) || undefined,
            icon: str(details.logoUrl) || str(details.composerIconUrl) || undefined,
            examplePrompts: Array.isArray(details.defaultPrompt)
              ? details.defaultPrompt.filter((value): value is string => typeof value === "string")
              : undefined,
            homepage: str(details.websiteUrl) || undefined,
            privacyPolicy: str(details.privacyPolicyUrl) || undefined,
            termsOfService: str(details.termsOfServiceUrl) || undefined,
          },
        },
      ];
    }),
  );
}

const pluginDiagnostic = (message: string): ZCodePluginDiagnostic => ({
  code: "marketplace_load_failed",
  severity: "warning",
  message,
});

function projectInventory(catalogValue: Message, runtimeValue: Message): Inventory {
  const cliEntries = array(catalogValue.entries);
  const entries = new Map(
    cliEntries
      .map(readCliEntry)
      .filter((item) => item.id && item.name && item.marketplace)
      .map((item) => [item.id, item]),
  );
  for (const item of readInstalled(runtimeValue)) {
    entries.set(item.id, item);
  }
  const markets = new Map<string, ZCodePluginMarketplaceSummary>();
  for (const item of array(catalogValue.markets)) {
    const name = str(item.name);
    const root = str(item.root);
    const configured = rec(item.marketplaceSource);
    const failure = refreshFailureSchema.safeParse(item.refreshFailure);
    if (!name) continue;
    markets.set(name, {
      id: name,
      name,
      pluginCount: 0,
      isOfficial: official.has(name),
      refreshFailure: failure.data,
      source: {
        type: str(configured.sourceType) || "local",
        path: str(configured.source) || root,
        configured: Boolean(configured.sourceType),
      },
    });
  }
  for (const entry of cliEntries) {
    const market = str(entry.marketplaceName);
    if (!market || markets.has(market)) continue;
    const source = rec(entry.marketplaceSource);
    const remote = rec(entry.source).source === "remote" || market === accountMarketplace;
    markets.set(market, {
      id: market,
      name: market,
      pluginCount: 0,
      isOfficial: official.has(market),
      source: {
        type: remote ? "remote" : str(source.sourceType) || "local",
        path: str(source.source),
        configured: Boolean(source.sourceType),
      },
    });
  }
  const runtimeMarkets = array(runtimeValue.marketplaces);
  for (const market of runtimeMarkets) {
    const name = str(market.name);
    const path = str(market.path);
    const label = str(rec(market.interface).displayName) || name;
    const entry = markets.get(name);
    if (entry) entry.name = label;
    else if (name && path)
      markets.set(name, {
        id: name,
        name: label,
        pluginCount: 0,
        isOfficial: official.has(name),
        source: { type: "local", path },
      });
    else if (
      name &&
      [...entries.values()].some((item) => item.marketplace === name && item.account)
    )
      markets.set(name, {
        id: name,
        name: label,
        pluginCount: 0,
        isOfficial: official.has(name),
        source: { type: "remote" },
      });
  }
  for (const item of entries.values()) {
    const market = markets.get(item.marketplace);
    if (market) market.pluginCount++;
  }
  const messages = Array.isArray(catalogValue.issues)
    ? catalogValue.issues.map((item) => str(item))
    : [];
  for (const issue of array(runtimeValue.marketplaceLoadErrors)) {
    const path = str(issue.marketplacePath);
    const message = str(issue.message);
    if (message) messages.push(path ? `${path}: ${message}` : message);
  }
  return {
    entries: [...entries.values()],
    markets: [...markets.values()],
    issues: [...new Set(messages.filter(Boolean))].map(pluginDiagnostic),
  };
}

function methodUnavailable(error: unknown) {
  return /method not found|unknown (method|variant)|unsupported method|-32601/i.test(String(error));
}

export async function nativePluginManagement(
  gateway: Gateway,
  hostId: number,
  cwd: string,
  method: string,
  params: Message,
  appRequest: AppRequest,
): Promise<unknown> {
  const hostKey = `${hostId}\0`;
  const key = `${hostKey}${str(params.workspaceIdentity).trim() || cwd}\0`;
  const request = async (operation: string, data: Message = {}) => {
    const { value } = await gateway.request("/api/selfhost/plugins", pluginEnvelope, "POST", {
      hostId,
      cwd,
      operation,
      ...data,
    });
    if (operation !== "catalog" && operation !== "describe") {
      const loads = catalogLoads.get(gateway);
      // 用户层的变更对同一台主机的其他工作目录也生效。
      for (const active of loads?.keys() ?? []) {
        if (active.startsWith(hostKey)) loads?.delete(active);
      }
    }
    return rec(value);
  };
  const installed = () => appRequest("plugin/installed", { cwds: [cwd] });
  const inventory = (source: CatalogSource): Promise<Inventory> => {
    let loads = catalogLoads.get(gateway);
    if (!loads) {
      loads = new Map();
      catalogLoads.set(gateway, loads);
    }
    const sourceKey = key + source;
    const active = loads.get(sourceKey);
    if (active) return active;
    const read =
      source === "installed"
        ? installed()
            .then((value) => projectInventory({}, value))
            .catch((error) => {
              if (!methodUnavailable(error)) throw error;
              return inventory("configured");
            })
        : request("catalog", { source }).then((value) => projectInventory(value, {}));
    const task = read.finally(() => {
      // 写入失效期间启动的新查询由它自己的 Promise 负责清理。
      if (loads.get(sourceKey) === task) loads.delete(sourceKey);
    });
    loads.set(sourceKey, task);
    return task;
  };

  const targetId = () =>
    str(params.pluginId) || `${str(params.pluginName)}@${str(params.marketplace)}`;
  if (method === "getPluginReferenceCatalog") {
    const entries = await installed()
      .then(readInstalled)
      .catch(async (error) => {
        if (!methodUnavailable(error)) throw error;
        return (await inventory("configured")).entries;
      });
    return zcodePluginsReferenceCatalogResultSchema.parse({
      authority: "workspace",
      plugins: [
        ...new Map(
          entries
            .filter((item) => item.installed && item.enabled && !item.policyBlocked)
            .map((item) => [
              item.id,
              {
                pluginId: item.id,
                name: item.name,
                marketplace: item.marketplace,
                description: item.description,
                displayName: item.listing?.displayName,
                enabled: true,
                conflictingPluginIds: [],
                skillQualifiedNames: [],
                mcpServerNames: [],
              },
            ]),
        ).values(),
      ],
    });
  }
  if (method === "setPluginEnabled") {
    if (params.scope === "workspace")
      throw Error("Codex plugin enablement is managed for the SSH user.");
    const plugin = await request("setEnabled", { pluginId: targetId(), enabled: params.enabled });
    return zcodePluginsSetEnabledResultSchema.parse({
      plugin: pluginInfo(readCliEntry(plugin)),
      enabled: plugin.enabled,
    });
  }
  if (method === "installPlugin" || method === "updatePlugin") {
    if (params.scope === "workspace" || params.dryRun)
      throw Error("This Codex plugin operation is unavailable for the requested scope.");
    const result = await request("install", { pluginId: targetId() });
    const entry = readCliEntry(result);
    return zcodePluginsInstallResultSchema.parse({
      installedPlugins: [
        {
          id: entry.id,
          name: entry.name,
          marketplace: entry.marketplace,
          version: entry.version,
          installPath: entry.rootPath,
          scope: "user",
          enabled: true,
        },
      ],
      dependencyClosure: [],
      diagnostics: [],
    });
  }
  if (method === "uninstallPlugin") {
    if (params.removeCache === false)
      throw Error("Codex removes the installed plugin and its local cache together.");
    await request("uninstall", { pluginId: targetId() });
    return { diagnostics: [] };
  }
  if (method === "addPluginMarketplace") {
    if (!params.dryRun) await request("marketplaceAdd", { source: params.source });
    return {};
  }
  if (method === "removePluginMarketplace") {
    await request("marketplaceRemove", { marketplace: params.marketplace });
    return {};
  }
  if (method === "updatePluginMarketplace") {
    const outcome = await request("marketplaceUpgrade", { marketplace: params.marketplace });
    return {
      diagnostics: array(outcome.errors).map((error) => ({
        code: "marketplace_refresh_failed",
        severity: "error",
        pluginId: str(error.marketplaceName),
        message: str(error.message),
      })),
    };
  }
  if (method === "describePlugin" || method === "getPluginDetail") {
    const result = await request("describe", { pluginId: targetId() });
    const entry = rec(result.entry);
    const manifest = rec(result.manifest);
    const author = rec(manifest.author);
    const details = rec(manifest.interface);
    const components = [];
    const diagnostics: ZCodePluginDiagnostic[] = [];
    if (entry.installed === true && entry.enabled !== false) {
      try {
        const skills = await appRequest("skills/list", { cwds: [cwd] });
        const items = array(array(skills.data)[0]?.skills)
          .filter((skill) => skill.pluginId === targetId())
          .map((skill) => ({
            name: str(skill.name),
            description: str(skill.description),
          }))
          .filter((skill) => skill.name);
        if (items.length) components.push({ kind: "skill", items });
      } catch (error) {
        diagnostics.push(pluginDiagnostic(String(error)));
      }
    }
    const description = zcodePluginsDescribeResultSchema.parse({
      components,
      diagnostics,
      metadata: {
        author: str(author.name) || undefined,
        authorUrl: str(author.url) || undefined,
        homepage: str(manifest.homepage) || undefined,
        version: str(manifest.version) || str(entry.version) || undefined,
      },
    });
    if (method === "getPluginDetail") return description;
    return {
      ...description,
      metadata: {
        ...description.metadata,
        displayName: str(details.displayName) || undefined,
        description: str(manifest.description) || str(details.shortDescription) || undefined,
      },
    };
  }

  if (method === "listPlugins") {
    const { entries, issues } = await inventory("installed");
    return zcodePluginsListResultSchema.parse({
      plugins: entries.filter((entry) => entry.installed).map(pluginInfo),
      diagnostics: issues,
    });
  }
  const requested = params.codexCatalogSource;
  const source =
    requested === "installed" || requested === "configured" || requested === "account"
      ? requested
      : "installed";
  const { entries, markets, issues } = await inventory(source);
  return zcodePluginsOverviewResultSchema.parse({
    marketplaces: markets,
    availablePlugins: entries.map(
      ({ id, name, marketplace, description, version, installed, listing, installPolicy }) => ({
        id,
        name,
        marketplace,
        description,
        version,
        installed,
        listing,
        installPolicy,
      }),
    ),
    installedPlugins: entries
      .filter((entry) => entry.installed)
      .map(({ id, name, marketplace, description, version, enabled, listing }) => ({
        id,
        name,
        marketplace,
        description,
        version,
        enabled,
        listing,
        scope: "user",
      }),
    ),
    restorableBuiltins: [],
    diagnostics: issues,
    capability: { supported: true },
  });
}
