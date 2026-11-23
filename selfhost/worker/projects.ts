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
    return Promise.all(
      [...roots].map(async ([remotePath, name]) => ({
        remotePath,
        name,
        canonicalPath: await realpath(remotePath).catch(() => remotePath),
      })),
    );
  },
};
