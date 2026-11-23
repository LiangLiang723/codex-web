import { runDueAutomations } from "../../utils/selfhost-organization";
export default defineTask({
  meta: { name: "selfhost:automations", description: "Dispatch due Codex sessions" },
  async run() {
    return { result: await runDueAutomations() };
  },
});
