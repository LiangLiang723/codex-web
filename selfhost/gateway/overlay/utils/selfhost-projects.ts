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
const path = z.string().startsWith("/");
const registered = z.array(z.object({ remotePath: path, name: z.string(), canonicalPath: path }));
type Project = {
  hostId: number;
  name: string;
  remotePath: string;
  source: "registered" | "saved" | "thread";
  aliases: string[];
};
const inFlight = new Map<string, Promise<Project[]>>();
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
function merge(saved: Project[], defined: Project[], dirs: string[], id: number) {
  const map = new Map<string, Project>();
  for (const p of [...defined, ...saved]) {
    const existing = [...map.values()].find(
      (x) => x.remotePath === p.remotePath || x.aliases.some((a) => p.aliases.includes(a)),
    );
    if (existing) {
      existing.aliases = [...new Set([...existing.aliases, ...p.aliases])];
      if (p.source === "saved") {
        existing.name = p.name;
        existing.source = "saved";
      }
      continue;
    }
    map.set(p.remotePath, p);
  }
  for (const value of dirs) {
    const cwd = normalizePath(value);
    if (
      [...map.values()].some((p) => p.source !== "thread" && p.aliases.some((a) => within(a, cwd)))
    )
      continue;
    if (!map.has(cwd))
      map.set(cwd, {
        hostId: id,
        name: basename(cwd) || cwd,
        remotePath: cwd,
        source: "thread",
        aliases: [cwd],
      });
  }
  return [...map.values()];
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
    ? { updated: Number(row.updated), items: decryptJson(String(row.catalog)) as Project[] }
    : undefined;
}
export function knownProjects(user: number, hostId: number): Project[] {
  const prior = cached(user, hostId)?.items ?? [];
  return merge(
    savedFor(hostId),
    prior.filter((p) => p.source !== "thread"),
    [
      ...prior.filter((p) => p.source === "thread").map((p) => p.remotePath),
      ...projectStore.list(hostId).map((p) => p.remotePath),
    ],
    hostId,
  );
}
export function allKnownProjects(user: number) {
  return hostStore.list().flatMap((h) => knownProjects(user, h.id));
}
export function refreshProjects(user: number, host: HostWithSecret, force: boolean) {
  const key = user + ":" + host.id,
    prior = cached(user, host.id);
  if (!force && prior && Date.now() - prior.updated < 60000)
    return Promise.resolve(knownProjects(user, host.id));
  const pending = inFlight.get(key);
  if (pending) return pending;
  const fetch = (async () => {
    const roots = registered.parse(
      await callWorkspace(host, { channel: "projects", method: "catalog", args: [] }),
    );
    const dirs = new Set<string>();
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await threadBroker.listThreads(
        host,
        withAllThreadSources({ limit: 100, cursor, useStateDbOnly: false }),
      );
      for (const t of page.data)
        if (typeof t.cwd === "string" && t.cwd.startsWith("/")) dirs.add(t.cwd);
      cursor = page.nextCursor ?? null;
      if (cursor && seen.has(cursor)) throw Error("Codex 返回了重复的项目历史游标");
      if (cursor) seen.add(cursor);
    } while (cursor);
    const items = merge(
      savedFor(host.id),
      roots.map((r) => ({
        hostId: host.id,
        name: r.name,
        remotePath: r.remotePath,
        source: "registered",
        aliases: [...new Set([r.remotePath, r.canonicalPath])],
      })),
      [...dirs],
      host.id,
    );
    table()
      .prepare(
        "INSERT INTO zcode_project_catalog VALUES(?,?,?,?) ON CONFLICT(user_id,host_id) DO UPDATE SET updated=excluded.updated,catalog=excluded.catalog",
      )
      .run(user, host.id, Date.now(), encryptJson(items));
    if (JSON.stringify(prior?.items) !== JSON.stringify(items)) catalogEvents.publish(user);
    return items;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, fetch);
  return fetch;
}
