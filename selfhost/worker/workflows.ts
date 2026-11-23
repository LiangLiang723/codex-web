import { unlink, writeFile } from "node:fs/promises";
import {
  listSavedWorkflows,
  moveSavedWorkflow,
  resolveSavedWorkflow,
  savedWorkflowRoot,
} from "../../apps/zcode-cli/packages/core/src/tool/handlers/saved-workflows/store.js";
import { serializeSavedWorkflow } from "../../apps/zcode-cli/packages/core/src/tool/handlers/saved-workflows/frontmatter.js";
import { SavedWorkflowMetaSchema } from "../../apps/zcode-cli/packages/contracts/src/tools/saved-workflow.js";
type Params = {
  cwd: string;
  scope?: "global" | "project";
  name: string;
  to: "global" | "project";
  meta: unknown;
};
export const workflows = {
  listSavedWorkflows(p: Params) {
    const scope = p.scope ?? "project",
      list = listSavedWorkflows({ cwd: p.cwd, scope });
    return {
      workflows: list.entries,
      invalid: list.invalid,
      dir: savedWorkflowRoot(p.cwd, scope).dir,
    };
  },
  getSavedWorkflow(p: Params) {
    return resolveSavedWorkflow({ cwd: p.cwd, scope: p.scope ?? "project", name: p.name });
  },
  async updateSavedWorkflowMeta(p: Params) {
    const item = this.getSavedWorkflow(p);
    if (!item.ok) return item;
    await writeFile(
      item.path,
      serializeSavedWorkflow(SavedWorkflowMetaSchema.parse(p.meta), item.script),
    );
    return { ok: true, path: item.path };
  },
  async deleteSavedWorkflow(p: Params) {
    const item = this.getSavedWorkflow(p);
    if (!item.ok) return item;
    await unlink(item.path);
    return { ok: true, path: item.path };
  },
  moveSavedWorkflow(p: Params) {
    return moveSavedWorkflow({ cwd: p.cwd, name: p.name });
  },
};
