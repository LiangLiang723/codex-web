import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createServer } from "vite";
import {
  buildNativeTurnInput,
  nativeUserInputItems,
  restoreNativeTurnText,
} from "../../packages/web/src/selfhost/nativeTurnInput.ts";

const appMarkup = "[$Demo App 乐](app://connector_123)";
const skillMarkup = "[$docs](</opt/one (skill)/SKILL.md>)";
const pluginMarkup = "[@Drive](plugin://drive@local)";
const text = `读 ${skillMarkup} 和 ${pluginMarkup}：${appMarkup} ${appMarkup}`;
const nativeText = "读 $docs 和 @Drive：$demo-app $demo-app";
const input = buildNativeTurnInput({
  text,
  attachments: [
    { ref: "/qa/uploads/a.txt", fileName: "a.txt", mime: "text/plain", bytes: 8 },
    { ref: "/qa/uploads/photo.png", fileName: "photo.png", mime: "image/png", bytes: 9 },
  ],
});
const items = nativeUserInputItems(input);
const element = (prefix, token, placeholder) => {
  const start = Buffer.byteLength(prefix);
  return { byteRange: { start, end: start + Buffer.byteLength(token) }, placeholder };
};
assert.deepEqual(items[0], {
  type: "text",
  text: nativeText,
  text_elements: [
    element("读 ", "$docs", skillMarkup),
    element("读 $docs 和 ", "@Drive", pluginMarkup),
    element("读 $docs 和 @Drive：", "$demo-app", appMarkup),
    element("读 $docs 和 @Drive：$demo-app ", "$demo-app", appMarkup),
  ],
});
assert.deepEqual(
  items.filter((x) => x.type === "skill" || x.type === "mention"),
  [
    { type: "skill", name: "docs", path: "/opt/one (skill)/SKILL.md" },
    { type: "mention", name: "Drive", path: "plugin://drive@local" },
    { type: "mention", name: "Demo App 乐", path: "app://connector_123" },
  ],
);
assert.equal(restoreNativeTurnText([items[0], ...items.slice(1, 4)]), text);
assert.equal(restoreNativeTurnText([items[0]]), nativeText, "Unbound placeholders stay as text");
assert.equal(
  restoreNativeTurnText([{ type: "text", text: pluginMarkup }]),
  pluginMarkup,
  "Previous Web history keeps its canonical links",
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
console.log("PASS native App, Skill and plugin selections, UTF-8 replay and attachments");
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
