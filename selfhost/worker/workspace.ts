import { projects } from "./projects.js";
import { workflows } from "./workflows.js";
import { homedir, platform } from "node:os";
import { createInterface } from "node:readline";
import { createFileService } from "../../packages/services/src/file/fileService.js";
import { createGitService } from "../../packages/services/src/git/gitService.js";
import { createMemoryService } from "../../packages/services/src/memory/memoryService.js";
import { createCommandsService } from "../../packages/services/src/commands/commandsService.js";
import { createOutputStyleService } from "../../packages/services/src/output-style/outputStyleService.js";
import { createSkillsService } from "../../packages/services/src/skills/skillsService.js";

// The channel is private SSH stdio. Keep the response stream separate from upstream diagnostics.
console.log = console.error;
console.info = console.error;
const services = new Map<string, object>([
  ["file", createFileService()],
  ["git", createGitService()],
  ["workflows", workflows],
  ["projects", projects],
  [
    "system",
    {
      info: () => ({ homedir: homedir(), platform: platform() }),
      listIntegratedTerminalShells: () => [],
    },
  ],
  ["memory", createMemoryService()],
  ["commands", createCommandsService()],
  ["skills", createSkillsService()],
  ["output-style", createOutputStyleService()],
]);
function reply(value: unknown) {
  process.stdout.write(JSON.stringify(value) + "\n");
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
  let id: string | undefined;
  try {
    const request = JSON.parse(line);
    id = request.id;
    const service = services.get(request.channel);
    if (!service || !Object.hasOwn(service, request.method) || !Array.isArray(request.args))
      throw Error("Unsupported workspace method");
    const method = Reflect.get(service, request.method);
    if (typeof method !== "function") throw Error("Invalid workspace method");
    const value = await Reflect.apply(method, service, request.args);
    reply({
      id,
      value:
        value instanceof Uint8Array ? { binary: Buffer.from(value).toString("base64") } : value,
    });
  } catch (error) {
    reply({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
reply({ ready: true });
