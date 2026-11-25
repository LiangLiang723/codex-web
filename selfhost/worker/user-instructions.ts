import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { USER_INSTRUCTIONS_MAX_BYTES } from "@zcode/shared";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";

const codexHome = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));
const mainFile = join(codexHome, "AGENTS.md");
const overrideFile = join(codexHome, "AGENTS.override.md");

async function readInstructions(file: string) {
  try {
    const filePath = await realpath(file);
    const info = await stat(filePath);
    if (!info.isFile() || info.size > 4 * 1024 * 1024) throw Error("Codex 指令文件无法在网页编辑");
    return { content: await readFile(filePath, "utf8"), filePath };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    return { content: "", filePath: file };
  }
}

async function effectiveInstructions() {
  const override = await readInstructions(overrideFile);
  return override.content.trim() ? override : readInstructions(mainFile);
}

export const userInstructions = {
  get: effectiveInstructions,
  async save(content: unknown, expected: { content?: unknown; filePath?: unknown } | undefined) {
    if (
      typeof content !== "string" ||
      Buffer.byteLength(content, "utf8") > USER_INSTRUCTIONS_MAX_BYTES
    )
      throw Error("Codex 指令内容无效或超出大小限制");
    return withFileLock(mainFile, async () => {
      const current = await effectiveInstructions();
      // Codex 可能改用覆盖文件，也可能有其它客户端保存了新内容。拒绝覆盖网页没读过的版本。
      if (current.filePath !== expected?.filePath || current.content !== expected?.content)
        throw Error("Codex 指令已变化，请重新读取后再保存");
      await atomicWritePrivateTextFile(current.filePath, content);
      return { filePath: current.filePath };
    });
  },
};
