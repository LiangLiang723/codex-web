import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const tmp = await mkdtemp(join(tmpdir(), "selfhost-title-"));
try {
  const out = join(tmp, "title.cjs");
  await build({
    entryPoints: [
      resolve(import.meta.dirname, "../gateway/overlay/utils/selfhost-thread-title.ts"),
    ],
    outfile: out,
    bundle: true,
    platform: "node",
    format: "cjs",
    plugins: [
      {
        name: "rpc",
        setup(b) {
          b.onResolve({ filter: /^(~~\/|\.\/gateway\/logging)/ }, (a) => ({
            path: a.path,
            namespace: "fixture",
          }));
          b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents:
              "exports.recordFromUnknown=x=>x; exports.stringFromUnknown=x=>x; exports.parseThreadReadResult=x=>x; exports.gatewayLog=()=>{};",
          }));
        },
      },
    ],
  });
  const { writeThreadName } = createRequire(import.meta.url)(out);
  let name = null;
  const listeners = new Set();
  const set = (value) => {
    name = value;
    for (const cb of listeners)
      cb({ method: "thread/name/updated", params: { threadId: "target", threadName: value } });
  };
  const client = {
    on: (_, cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    request: async (method, params) => {
      if (method === "thread/read") return { thread: { name } };
      if (params.name === "automatic") set("manual from Mac");
      set(params.name);
      return {};
    },
  };
  await writeThreadName(client, "target", "automatic", true);
  assert.equal(name, "manual from Mac");
  assert.equal(listeners.size, 0);
  await writeThreadName(client, "target", "manual from Web");
  assert.equal(name, "manual from Web");
  console.log("PASS observed external rename during automatic title write");
} finally {
  await rm(tmp, { recursive: true, force: true });
}
