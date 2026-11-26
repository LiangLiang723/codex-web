import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const source = fileURLToPath(new URL("../upstream/open-bot-avatar/src/", import.meta.url));
const texture = fileURLToPath(new URL("bot-material-texture.mjs", import.meta.url));

export async function prepareBotMaterials(output) {
  const license = await readFile(new URL("../upstream/open-bot-avatar/LICENSE", import.meta.url), "utf8");
  const entries = await Promise.all(["fluffy", "glass"].map(async (kind) => {
    const bundle = await build({
      stdin: {
        resolveDir: source,
        contents: `
          import { ${kind} } from "./dom/materials/${kind}.ts";
          import { createMaterialTextures } from ${JSON.stringify(texture)};
          export const getTextures = createMaterialTextures(${kind}.render);
        `,
      },
      banner: { js: `/*\n${license.trim()}\n*/` },
      format: "esm",
      platform: "browser",
      bundle: true,
      minify: true,
      write: false,
    });
    const code = bundle.outputFiles[0].contents;
    const hash = createHash("sha256").update(code).digest("hex").slice(0, 12);
    const file = `assets/codex-bot-material-${kind}-${hash}.mjs`;
    await writeFile(join(output, file), code);
    return [kind, file];
  }));
  return Object.fromEntries(entries);
}
