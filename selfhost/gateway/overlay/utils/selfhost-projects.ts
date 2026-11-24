import { basename, posix } from "node:path";
import { gatewayDatabase } from "./gateway/storage/database";
import { decryptJson, encryptJson } from "./gateway/storage/crypto";
import { hostStore } from "./gateway/state/hosts";
import { projectStore } from "./gateway/state/projects";
import { runtimeConfigStore } from "./gateway/state/runtime-config";
import { threadBroker } from "./gateway/runtime/broker";
import { withAllThreadSources } from "./gateway/protocol/thread-list";
import { callWorkspace } from "./selfhost-workspace";
import type { HostWithSecret } from "./gateway/infra/ssh/ssh-types";
import { z } from "zod";
import { catalogEvents } from "./gateway/config/pinned-thread-events";
import { CodexRpcError } from "./gateway/http/errors";
const path = z.string().startsWith("/");
const registered = z.array(z.object({ remotePath: path, name: z.string(), canonicalPath: path }));
const desktopMetadata = z.object({
  legacyRoots: registered,
  projects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      paths: z.array(path).nonempty(),
      nativeId: z.string().optional(),
    }),
  ),
  memberships: z.record(z.string(), z.string().nullable()),
});
const nativePage = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      roots: z.array(z.object({ path })),
    }),
  ),
  nextCursor: z.string().nullable(),
});
type Project = {
  hostId: number;
  id?: string;
  nativeId?: string;
  name: string;
  remotePath: string;
  roots?: string[];
  source: "registered" | "saved" | "thread";
  aliases: string[];
};
type Catalog = {
  items: Project[];
  desktop: boolean;
  memberships: Record<string, string | null>;
};
const inFlight = new Map<string, Promise<Catalog>>();
function table() {
  const db = gatewayDatabase();
  db.exec(
    "CREATE TABLE IF NOT EXISTS zcode_project_catalog(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,host_id INTEGER NOT NULL,updated INTEGER NOT NULL,catalog TEXT NOT NULL,PRIMARY KEY(user_id,host_id))",
  );
  return db;
}
function normalizePath(value: string) {
  return posix.normalize(value).replace(/\/$/, "") || "/";
}
function within(root: string, cwd: string) {
  return root === cwd || cwd.startsWith(root === "/" ? "/" : root + "/");
}
function merge(saved: Project[], defined: Project[], dirs: string[], id: number, desktop: boolean) {
  const items = [...defined];
  for (const p of saved) {
    const index = items.findIndex((x) => x.aliases.includes(p.remotePath));
    if (index < 0) items.push(p);
    else if (!desktop) items[index] = { ...p, aliases: items[index].aliases };
  }
  const knownPaths = new Set(items.map((p) => p.remotePath));
  for (const value of dirs) {
    const cwd = normalizePath(value);
    if (
      knownPaths.has(cwd) ||
      items.some((p) => p.source !== "thread" && p.aliases.some((a) => within(a, cwd)))
    )
      continue;
    knownPaths.add(cwd);
    items.push({
      hostId: id,
      name: basename(cwd) || cwd,
      remotePath: cwd,
      source: "thread",
      aliases: [cwd],
    });
  }
  return items;
}
function savedFor(hostId: number): Project[] {
  return runtimeConfigStore
    .export()
    .projects.filter((p) => p.hostId === hostId)
    .map((p) => ({
      ...p,
      remotePath: normalizePath(p.remotePath),
      source: "saved",
      aliases: [normalizePath(p.remotePath)],
    }));
}
function cached(user: number, hostId: number) {
  const row = table()
    .prepare("SELECT catalog,updated FROM zcode_project_catalog WHERE user_id=? AND host_id=?")
    .get(user, hostId);
  return row
    ? {
        updated: Number(row.updated),
        catalog: decryptJson(String(row.catalog)) as Catalog | Project[],
      }
    : undefined;
}
function knownCatalog(user: number, hostId: number): Catalog {
  const cachedValue = cached(user, hostId)?.catalog;
  const prior = Array.isArray(cachedValue) ? cachedValue : (cachedValue?.items ?? []);
  const desktop = !Array.isArray(cachedValue) && cachedValue?.desktop === true;
  return {
    desktop,
    memberships: Array.isArray(cachedValue) ? {} : (cachedValue?.memberships ?? {}),
    items: merge(
      savedFor(hostId),
      prior.filter((p) => p.source !== "thread"),
      desktop
        ? []
        : [
            ...prior.filter((p) => p.source === "thread").map((p) => p.remotePath),
            ...projectStore.list(hostId).map((p) => p.remotePath),
          ],
      hostId,
      desktop,
    ),
  };
}
export function knownProjects(user: number, hostId: number): Project[] {
  return knownCatalog(user, hostId).items;
}
export function allKnownProjects(user: number) {
  return hostStore.list().flatMap((h) => knownProjects(user, h.id));
}
export function refreshProjects(user: number, host: HostWithSecret, force: boolean) {
  const key = user + ":" + host.id,
    prior = cached(user, host.id);
  if (!force && prior && !Array.isArray(prior.catalog) && Date.now() - prior.updated < 60000)
    return Promise.resolve(knownCatalog(user, host.id));
  const pending = inFlight.get(key);
  const forCaller = (refresh: Promise<Catalog>) =>
    !force && prior ? refresh.catch(() => knownCatalog(user, host.id)) : refresh;
  if (pending) return forCaller(pending);
  const fetch = (async () => {
    const [native, metadata] = await Promise.all([
      listNativeProjects(host),
      callWorkspace(host, { channel: "projects", method: "catalog", args: [] }).then((value) =>
        desktopMetadata.parse(value),
      ),
    ]);
    const desktop = native.length > 0 || metadata.projects.length > 0;
    const byLegacyId = new Map<string, string>();
    const defined: Project[] = native.length
      ? native.flatMap((p) => {
          const roots = p.roots.map((r) => normalizePath(r.path));
          return roots.length ? [registeredProject(host.id, p.name, roots, p.id, p.id)] : [];
        })
      : metadata.projects.map((p) => registeredProject(host.id, p.name, p.paths, p.id));
    for (const legacy of metadata.projects) {
      const roots = legacy.paths.map(normalizePath);
      const match =
        defined.find((p) => p.id === (native.length ? legacy.nativeId : legacy.id)) ??
        defined.find(
          (p) =>
            p.name === legacy.name &&
            p.roots?.length === roots.length &&
            roots.every((root) => p.roots?.includes(root)),
        );
      if (match?.id) byLegacyId.set(legacy.id, match.id);
    }
    const memberships: Record<string, string | null> = Object.create(null);
    for (const [threadId, legacyId] of Object.entries(metadata.memberships)) {
      const id = legacyId === null ? null : byLegacyId.get(legacyId);
      if (id !== undefined) memberships[threadId] = id;
    }
    const items = desktop
      ? merge(savedFor(host.id), defined, [], host.id, true)
      : merge(
          savedFor(host.id),
          metadata.legacyRoots.map((r) => ({
            hostId: host.id,
            name: r.name,
            remotePath: r.remotePath,
            source: "registered",
            aliases: [...new Set([r.remotePath, r.canonicalPath])],
          })),
          await discoverDirectories(host, force),
          host.id,
          false,
        );
    const catalog = { items, desktop, memberships };
    table()
      .prepare(
        "INSERT INTO zcode_project_catalog VALUES(?,?,?,?) ON CONFLICT(user_id,host_id) DO UPDATE SET updated=excluded.updated,catalog=excluded.catalog",
      )
      .run(user, host.id, Date.now(), encryptJson(catalog));
    if (JSON.stringify(prior?.catalog) !== JSON.stringify(catalog)) catalogEvents.publish(user);
    return catalog;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, fetch);
  return forCaller(fetch);
}

function registeredProject(
  hostId: number,
  name: string,
  paths: string[],
  id: string,
  nativeId?: string,
): Project {
  const roots = paths.map(normalizePath);
  return {
    hostId,
    id,
    nativeId,
    name,
    remotePath: roots[0],
    roots,
    source: "registered",
    aliases: roots,
  };
}

async function listNativeProjects(host: HostWithSecret) {
  const client = await threadBroker.getHostClient(host);
  const items: z.infer<typeof nativePage>["data"] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    try {
      const page = nativePage.parse(
        await client.request("project/list", { limit: 100, cursor, sortKey: "position" }),
      );
      items.push(...page.data);
      cursor = page.nextCursor;
    } catch (error) {
      // 旧 CLI 的方法表没有 project/list，仍可读取旧桌面根目录和目录历史。
      if (
        cursor === null &&
        error instanceof CodexRpcError &&
        (error.rpcCode === -32601 || /unknown (variant|method).*project\/list/i.test(error.message))
      )
        return [];
      throw error;
    }
    if (cursor && seen.has(cursor)) throw Error("Codex 返回了重复的项目游标");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return items;
}

async function discoverDirectories(host: HostWithSecret, includeRollouts: boolean) {
  const dirs = new Set<string>();
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await threadBroker.listThreads(
      host,
      withAllThreadSources({ limit: 100, cursor, useStateDbOnly: !includeRollouts }),
    );
    for (const thread of page.data) {
      if (thread.cwd.startsWith("/")) dirs.add(thread.cwd);
    }
    cursor = page.nextCursor ?? null;
    if (cursor && seen.has(cursor)) throw Error("Codex 返回了重复的项目历史游标");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return [...dirs];
}
