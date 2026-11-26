import { fileURLToPath } from "node:url";
import { defineNitroConfig } from "nitropack/config";

export default defineNitroConfig({
  srcDir: "server",
  preset: "node-server",
  publicAssets: [
    {
      dir: fileURLToPath(new URL("./public/assets", import.meta.url)),
      baseURL: "/assets",
      maxAge: 31_536_000,
    },
    { dir: fileURLToPath(new URL("./public", import.meta.url)), maxAge: 0 },
  ],
  compressPublicAssets: { gzip: true, brotli: true },
  routeRules: {
    "/": { headers: { "cache-control": "no-cache" } },
    "/index.html": { headers: { "cache-control": "no-cache" } },
  },
  compatibilityDate: "2025-07-15",
  alias: { "~~": fileURLToPath(new URL(".", import.meta.url)) },
  experimental: { websocket: true, tasks: true },
  rollupConfig: { external: ["node:sqlite"] },
  scheduledTasks: {
    "* * * * *": ["selfhost:automations"],
    "*/30 * * * * *": ["gateway:sync-running-threads"],
    "*/5 * * * *": ["gateway:poll-tmux-monitors"],
    "0 * * * *": ["gateway:prune-expired-sessions"],
  },
});
