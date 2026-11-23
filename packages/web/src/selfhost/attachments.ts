import { sha256 } from "@noble/hashes/sha256";
import type { Gateway, Message } from "./gateway.js";
import { rec, str, num, array } from "./threadProjection.js";
type Upload = {
  fileName: string;
  mime: string;
  total: number;
  count: number;
  checksum: string;
  chunks: Uint8Array<ArrayBuffer>[];
  bytes: number;
  ref?: string;
  committing?: Promise<{ ref: string }>;
};
export class AttachmentBridge {
  private uploads = new Map<string, Upload>();
  constructor(
    private gateway: Gateway,
    private hostId: number,
  ) {}
  async handle(method: string, p: Message): Promise<unknown> {
    const key = str(p.uploadId);
    if (method === "attachmentBeginV4") {
      const total = num(p.totalBytes),
        count = num(p.totalChunks);
      if (
        !key ||
        total < 0 ||
        total > 64 * 1024 * 1024 ||
        !Number.isInteger(count) ||
        count > 2048 ||
        count < 0
      )
        throw Error("附件超出大小限制");
      if (!this.uploads.has(key)) {
        if (this.uploads.size >= 64) throw Error("同时上传的附件过多");
        this.uploads.set(key, {
          fileName: str(p.fileName),
          mime: str(p.mime),
          total,
          count,
          checksum: str(p.checksum),
          chunks: [],
          bytes: 0,
        });
      }
      const u = this.uploads.get(key)!;
      return {
        uploadId: key,
        state: u.ref ? "committed" : "staging",
        nextChunkIndex: u.ref ? u.count : u.chunks.length,
        ...(u.ref ? { ref: u.ref } : {}),
      };
    }
    const u = this.uploads.get(key);
    if (method === "attachmentAbortV4") {
      this.uploads.delete(key);
      return {};
    }
    if (!u) throw Error("附件上传已失效");
    if (method === "attachmentChunkV4") {
      if (u.chunks.length === p.chunkIndex) {
        const part = Uint8Array.from(atob(str(p.dataBase64)), (c) => c.charCodeAt(0));
        if (u.bytes + part.length > u.total) throw Error("附件字节数与声明不符");
        u.chunks.push(part);
        u.bytes += part.length;
      }
      return { uploadId: key, nextChunkIndex: u.chunks.length };
    }
    if (method !== "attachmentCommitV4") throw Error("不支持的附件请求");
    if (u.ref) return { ref: u.ref };
    if (!u.committing)
      u.committing = this.commit(u).finally(() => {
        u.committing = undefined;
      });
    return u.committing;
  }
  private async commit(u: Upload) {
    if (u.bytes !== u.total || u.chunks.length !== u.count) throw Error("附件尚未传输完成");
    const digest = sha256.create();
    for (const chunk of u.chunks) digest.update(chunk);
    if (
      "sha256:" + Array.from(digest.digest(), (b) => b.toString(16).padStart(2, "0")).join("") !==
      u.checksum
    )
      throw Error("附件校验失败");
    const form = new FormData();
    form.append(
      "files",
      new Blob(
        u.chunks.map((c) => c.buffer),
        { type: u.mime },
      ),
      u.fileName,
    );
    const response = await this.gateway.fetch("/api/uploads?hostId=" + this.hostId, {
      method: "POST",
      body: form,
    });
    const entry = array(rec(await response.json()).files)[0];
    const ref = str(entry?.path);
    if (!ref) throw Error("远程服务器未返回附件路径");
    u.ref = ref;
    u.chunks = [];
    return { ref };
  }
}
