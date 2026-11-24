import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, basename } from "node:path";
import { homedir } from "node:os";
import { parse } from "smol-toml";

async function optionalConfig(path: string, limit: number) {
  try {
    if ((await stat(path)).size > limit)
      throw Error("Codex project metadata exceeds the supported size");
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
/** Only workspace paths and desktop labels are returned; the rest of the user's config stays on the SSH host. */
export const projects = {
  async catalog() {
    const base = process.env.CODEX_HOME || join(homedir(), ".codex");
    const toml = await optionalConfig(join(base, "config.toml"), 4 * 1024 * 1024);
    const saved = await optionalConfig(join(base, ".codex-global-state.json"), 32 * 1024 * 1024);
    const settings = toml ? parse(toml) : {},
      desktop = saved ? JSON.parse(saved) : {};
    const names =
      desktop["electron-workspace-root-labels"] ?? desktop["workspace-root-labels"] ?? {};
    const roots = new Map<string, string>();
    function add(path: unknown) {
      if (typeof path !== "string" || !isAbsolute(path)) return;
      const normal = normalize(path).replace(/\/$/, "") || "/";
      roots.set(
        normal,
        typeof names[path] === "string" && names[path].trim()
          ? names[path]
          : basename(normal) || normal,
      );
    }
    for (const key of [
      "electron-saved-workspace-roots",
      "saved-workspace-roots",
      "active-workspace-roots",
    ]) {
      if (Array.isArray(desktop[key])) desktop[key].forEach(add);
    }
    for (const path of Object.keys(settings.projects ?? {})) add(path);
    const legacyRoots = await Promise.all(
      [...roots].map(async ([remotePath, name]) => ({
        remotePath,
        name,
        canonicalPath: await realpath(remotePath).catch(() => remotePath),
      })),
    );
    // 新版桌面先把项目迁入 app-server，旧会话归属仍可能保留在桌面状态文件。
    // 只投影本机项目和会话 ID，远端项目属于各自的 SSH 主机。
    const local = Object.values(desktop["local-projects"] ?? {});
    const order: unknown[] = Array.isArray(desktop["project-order"])
      ? desktop["project-order"]
      : [];
    const positions = new Map(order.map((id, index) => [id, index]));
    const projects = local
      .flatMap((value) => {
        const item = value as { id?: unknown; name?: unknown; rootPaths?: unknown };
        if (typeof item?.id !== "string" || typeof item.name !== "string") return [];
        const paths = Array.isArray(item.rootPaths)
          ? item.rootPaths.filter((p): p is string => typeof p === "string" && isAbsolute(p))
          : [];
        return paths.length ? [{ id: item.id, name: item.name, paths }] : [];
      })
      .sort(
        (a, b) => (positions.get(a.id) ?? order.length) - (positions.get(b.id) ?? order.length),
      );
    const migrated = new Map<string, string>();
    for (const scope of Object.values(
      desktop["app-server-project-id-by-legacy-project-id-by-host"] ?? {},
    )) {
      if (typeof scope !== "object" || scope === null) continue;
      for (const [old, native] of Object.entries(scope)) {
        if (typeof native === "string") migrated.set(old, native);
      }
    }
    const memberships: Record<string, string | null> = Object.create(null);
    if (Array.isArray(desktop["projectless-thread-ids"])) {
      for (const id of desktop["projectless-thread-ids"]) {
        if (typeof id === "string") memberships[id] = null;
      }
    }
    const localIds = new Set(projects.map((p) => p.id));
    for (const [id, value] of Object.entries(desktop["thread-project-assignments"] ?? {})) {
      const assignment = value as { projectKind?: unknown; projectId?: unknown };
      if (
        assignment?.projectKind === "local" &&
        typeof assignment.projectId === "string" &&
        localIds.has(assignment.projectId) &&
        !(id in memberships)
      ) {
        memberships[id] = assignment.projectId;
      }
    }
    return {
      legacyRoots,
      projects: projects.map((project) => ({
        ...project,
        nativeId: migrated.get(project.id),
      })),
      memberships,
    };
  },
};
