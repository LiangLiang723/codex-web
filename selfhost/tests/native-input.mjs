import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createServer } from "vite";
import {
  buildNativeTurnInput,
  nativeUserInputItems,
} from "../../packages/web/src/selfhost/nativeTurnInput.ts";

const text = "读 [$docs](</opt/one skill/SKILL.md>) 和 [@Drive](plugin://drive@local)";
const input = buildNativeTurnInput({
  text,
  attachments: [
    { ref: "/qa/uploads/a.txt", fileName: "a.txt", mime: "text/plain", bytes: 8 },
    { ref: "/qa/uploads/photo.png", fileName: "photo.png", mime: "image/png", bytes: 9 },
  ],
});
const items = nativeUserInputItems(input);
assert.deepEqual(items[0], { type: "text", text, text_elements: [] });
assert.deepEqual(
  items.filter((x) => x.type === "skill" || x.type === "mention"),
  [
    { type: "skill", name: "docs", path: "/opt/one skill/SKILL.md" },
    { type: "mention", name: "Drive", path: "plugin://drive@local" },
  ],
);
assert.ok(items.some((x) => x.type === "text" && x.text.includes("/qa/uploads/a.txt")));
assert.equal(
  items.filter((x) => x.type === "localImage" && x.path === "/qa/uploads/photo.png").length,
  1,
);
assert.deepEqual(nativeUserInputItems(buildNativeTurnInput({ text: "普通输入" })), [
  { type: "text", text: "普通输入", text_elements: [] },
]);
assert.throws(() => buildNativeTurnInput({ attachments: [{ fileName: "missing", ref: "" }] }));
console.log("PASS native plain text, selected skill/plugin, file and image payloads");
const web = resolve(import.meta.dirname, "../../packages/web");
const vite = await createServer({
  root: web,
  configFile: resolve(web, "vite.config.ts"),
  mode: "selfhost",
  logLevel: "error",
  server: { middlewareMode: true, hmr: false, watch: null },
});
try {
  const { AttachmentBridge } = await vite.ssrLoadModule("/src/selfhost/attachments.ts");
  let writes = 0;
  const bridge = new AttachmentBridge(
    { fetch: async () => Response.json({ files: [{ path: "/uploads/" + ++writes }] }) },
    1,
  );
  const checksum = "sha256:" + createHash("sha256").update("a").digest("hex");
  for (let n = 1; n <= 65; n++) {
    const request = {
      uploadId: String(n),
      fileName: "a.txt",
      mime: "text/plain",
      totalBytes: 1,
      totalChunks: 1,
      checksum,
    };
    await bridge.handle("attachmentBeginV4", request);
    await bridge.handle("attachmentChunkV4", {
      uploadId: request.uploadId,
      chunkIndex: 0,
      dataBase64: "YQ==",
    });
    assert.equal((await bridge.handle("attachmentCommitV4", request)).ref, "/uploads/" + n);
    assert.equal((await bridge.handle("attachmentBeginV4", request)).state, "committed");
    assert.equal((await bridge.handle("attachmentCommitV4", request)).ref, "/uploads/" + n);
  }
  assert.equal(writes, 65);
  console.log("PASS sequential attachment transactions and idempotent receipts");
} finally {
  await vite.close();
}
