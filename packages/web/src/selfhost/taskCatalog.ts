import { z } from "zod";
import { type Gateway, type Message } from "./gateway.js";
import { codexRequest } from "./capabilities.js";
import { array, num, rec, str, threadName } from "./threadProjection.js";

const row = z.record(z.string(), z.unknown());
const pageSchema = z.object({
  data: z.array(row),
  nextCursor: z.string().nullable().default(null),
});
const pointSchema = z.object({ thread: row.nullable() });
const nativePageLimit = 100;
type ThreadListOptions = {
  cwd?: string;
  search?: string;
  archived?: boolean;
  sortKey?: "created_at" | "updated_at";
  includedThreadIds?: readonly string[];
};
const timeMs = (value: unknown) => {
  const time = num(value);
  return time < 1e12 ? time * 1000 : time;
};

export class NativeThreadCatalog {
  private readonly scans = new Map<string, Promise<Message[]>>();
  private readonly pages = new Map<string, Promise<z.infer<typeof pageSchema>>>();
  private readonly points = new Map<string, Promise<Message | null>>();
  private queryGeneration = 0;

  constructor(
    private gateway: Gateway,
    private hostId: number,
    private cwd: string,
  ) {}

  private listQuery(options: ThreadListOptions, limit: number, cursor?: string) {
    const query = new URLSearchParams({
      hostId: String(this.hostId),
      limit: String(limit),
      useRemoteStateIndexOnly: "true",
      archived: String(options.archived === true),
      sortKey: options.sortKey ?? "updated_at",
      discoverProjects: "false",
    });
    if (options.cwd) query.set("cwd", options.cwd);
    if (options.search) query.set("searchTerm", options.search.trim());
    if (options.includedThreadIds) query.set("includedThreadIds", options.includedThreadIds.join(","));
    if (cursor) query.set("cursor", cursor);
    return query.toString();
  }

  private inFlight<T>(reads: Map<string, Promise<T>>, key: string, read: () => Promise<T>) {
    const current = reads.get(key);
    if (current) return current;
    const pending = read().finally(() => {
      if (reads.get(key) === pending) reads.delete(key);
    });
    reads.set(key, pending);
    return pending;
  }

  page(options: ThreadListOptions, limit: number) {
    return this.readPage(options, limit, this.queryGeneration);
  }

  private readPage(options: ThreadListOptions, limit: number, generation: number, cursor?: string) {
    const query = this.listQuery(options, limit, cursor);
    return this.inFlight(this.pages, `${generation}/${query}`, () =>
      this.gateway.request("/api/threads?" + query, pageSchema),
    );
  }

  threads(cwd?: string, search?: string, archived = false) {
    return this.readPages({ cwd, search, archived });
  }

  private readPages(options: ThreadListOptions) {
    // 多个任务列表可以共享同一原生范围。只复用在途读取，后续查询仍以远端现状为准。
    const generation = this.queryGeneration;
    const key = `${generation}/${this.listQuery(options, nativePageLimit)}`;
    return this.inFlight(this.scans, key, async () => {
      const rows = new Map<string, Message>();
      const visited = new Set<string>();
      let cursor: string | undefined;
      for (;;) {
        const page = await this.readPage(options, nativePageLimit, generation, cursor);
        for (const value of page.data)
          rows.set(str(value.id), { ...value, archived: options.archived === true });
        if (!page.nextCursor) return [...rows.values()];
        if (visited.has(page.nextCursor)) throw Error("Codex 返回了重复的会话游标");
        visited.add(page.nextCursor);
        cursor = page.nextCursor;
      }
    });
  }

  meta(t: Message) {
    return {
      taskId: str(t.id),
      traceId: str(t.id),
      title: threadName(t),
      workspacePath: str(t.cwd, this.cwd),
      cwd: str(t.cwd, this.cwd),
      createdAt: timeMs(t.createdAt),
      updatedAt: timeMs(t.updatedAt),
      mode: "build",
      provider: "glm",
      status: rec(t.status).type === "active" ? "running" : "completed",
      archived: t.archived === true,
      pinned: t.pinned === true,
    };
  }

  async point(id: string) {
    if (!id) return null;
    // 已知原生 ID 时，读取该 Thread 的元数据即可，避免一次侧栏查找遍历整台主机。
    const query = new URLSearchParams({ hostId: String(this.hostId), threadId: id });
    return this.inFlight(this.points, id, async () =>
      (await this.gateway.request("/api/selfhost/thread-summary?" + query, pointSchema)).thread,
    );
  }

  async list(method: string, p: Message) {
    const kind =
      method === "listArchivedTasks"
        ? "archived"
        : method === "listPinnedTasks" || method === "listPinnedTaskIds"
          ? "pinned"
          : p.kind;
    const archived = kind === "archived";
    const scopes =
      p.workspaceScopes === "host"
        ? [undefined]
        : Array.isArray(p.workspaceScopes)
          ? [
              ...new Set(
                array(p.workspaceScopes)
                  .map((x) => str(x.workspacePath))
                  .filter(Boolean),
              ),
            ]
          : [str(p.workspacePath) || this.cwd];
    const wanted = Array.isArray(p.taskIds) ? new Set(p.taskIds.map(String)) : null;
    const sortKey = p.sortBy === "created" ? "createdAt" : "updatedAt";
    const nativeSortKey = sortKey === "createdAt" ? "created_at" : "updated_at";
    const search = str(p.search).trim();
    let remote: Message[] = [];
    if (method !== "listDeletedTaskIds" && (!wanted || wanted.size)) {
      if (wanted && kind === "all" && !search) {
        const found = await Promise.all([...wanted].map((id) => this.point(id)));
        remote = found.filter(
          (t): t is Message => !!t && scopes.some((s) => s === undefined || s === t.cwd),
        );
      } else {
        const ids = wanted ? [...wanted].sort() : [];
        const batches = wanted
          ? Array.from({ length: Math.ceil(ids.length / nativePageLimit) }, (_, index) =>
              ids.slice(index * nativePageLimit, (index + 1) * nativePageLimit),
            )
          : [undefined];
        const pages = await Promise.all(
          scopes.flatMap((cwd) =>
            batches.map((includedThreadIds) =>
              this.readPages({ cwd, search, archived, sortKey: nativeSortKey, includedThreadIds }),
            ),
          ),
        );
        remote = [...new Map(pages.flat().map((t) => [str(t.id), t])).values()];
      }
    }
    const items = remote
      .filter(
        (t) =>
          (!wanted || wanted.has(str(t.id))) &&
          (kind !== "pinned" || t.pinned === true) &&
          ((kind !== "active" && method !== "listActiveTaskIds") ||
            rec(t.status).type === "active"),
      )
      .map((t) => ({
        ...this.meta(t),
        sourceAvailability: "online",
        liveStatus: rec(t.status).type === "active" ? "running" : "idle",
      }))
      .sort((a, b) => b[sortKey] - a[sortKey] || a.taskId.localeCompare(b.taskId));
    if (method !== "listTaskList")
      return method.endsWith("Ids") ? items.map((t) => t.taskId) : items;
    const limit = Math.max(0, num(p.limit, items.length));
    return { items: items.slice(0, limit), total: items.length, hasMore: items.length > limit };
  }

  async mutate(method: string, p: Message) {
    const mutation = rec(p.mutation);
    const id = str(p.taskId ?? rec(p.address).taskId);
    if (!id) throw Error("缺少原生会话 ID");
    let archived: boolean | undefined;
    if (method === "renameTask" || mutation.kind === "rename")
      await this.gateway.request("/api/threads/rename", z.unknown(), "POST", {
        hostId: this.hostId,
        threadId: id,
        name: p.title ?? mutation.title,
      });
    else if (method === "setTaskPinned" || mutation.kind === "pin") {
      const pinned = (mutation.pinned ?? p.pinned) === true;
      const target = pinned ? await this.point(id) : null;
      if (pinned && !target) throw Error("找不到会话");
      await this.gateway.request(
        "/api/config/pinned-threads",
        z.unknown(),
        "POST",
        target
          ? {
              pinned: true,
              thread: { hostId: this.hostId, threadId: id, title: threadName(target) },
            }
          : { pinned: false, hostId: this.hostId, threadId: id },
      );
    } else {
      archived = method === "archiveTask" || mutation.archived === true;
      await codexRequest(
        this.gateway,
        this.hostId,
        archived ? "thread/archive" : "thread/unarchive",
        { threadId: id },
      );
    }
    // 写入确认后不能复用旧组织态或标题。旧请求仍可向原调用者完成。
    this.queryGeneration += 1;
    this.points.delete(id);
    const t = await this.point(id);
    return t ? this.meta(archived === undefined ? t : { ...t, archived }) : null;
  }
}
