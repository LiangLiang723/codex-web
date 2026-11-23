import { readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const destination = process.argv[2] || ".selfhost/assets/workspace.cjs";
const options = {
  absWorkingDir: root,
  entryPoints: ["selfhost/worker/workspace.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: destination,
  alias: { "@zcode/contracts": resolve(root, "apps/zcode-cli/packages/contracts/src/index.ts") },
  external: ["@napi-rs/keyring"],
  treeShaking: true,
  legalComments: "eof",
  logLevel: "warning",
};
await build(options);
await build({
  ...options,
  entryPoints: ["selfhost/worker/organization.ts"],
  outfile: resolve(dirname(destination), "organization.cjs"),
});
const schema = await readFile(
  resolve(root, "packages/services/src/session/tasksDatabase/schema-v1.ts"),
  "utf8",
);
const start = schema.indexOf("CREATE TABLE IF NOT EXISTS task_groups");
const end = schema.indexOf("ON task_group_view_node_orders (sort_order, created_at);", start);
if (start < 0 || end < 0) throw Error("Recheck upstream task group schema");
await writeFile(
  resolve(dirname(destination), "task-groups.sql"),
  schema.slice(start, schema.indexOf(";", end) + 1),
);
