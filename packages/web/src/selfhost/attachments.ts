import { sha256 } from "@noble/hashes/sha256";
import {
  PROTOCOL_V4_LIMITS,
  type AttachmentRef,
  type V4AttachmentReadResult,
} from "@zcode/shared/zcode-protocol-v4";
import { z } from "zod";
import type { Gateway, Message } from "./gateway.js";
import { rec, str, num, array } from "./nativeValues.js";
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
  private completed = new Map<string, Pick<Upload, "count" | "checksum" | "fileName" | "mime" | "total"> & { ref: string }>();
  constructor(
    private gateway: Gateway,
    private hostId: number,
  ) {}
  async handle(method: string, p: Message): Promise<unknown> {
    const key = str(p.uploadId);
    const receipt = this.completed.get(key);
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
      const existing = receipt ?? this.uploads.get(key);
      if (existing && (existing.checksum !== str(p.checksum) || existing.count !== count || existing.total !== total || existing.fileName !== str(p.fileName) || existing.mime !== str(p.mime))) {
        throw Error("同一上传 ID 的附件信息不一致");
      }
      if (receipt) return {uploadId:key, state:"committed", nextChunkIndex:receipt.count, ref:receipt.ref};
      if (!existing) {
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
    if (receipt && method === "attachmentCommitV4") return {ref:receipt.ref};
    if (receipt && method === "attachmentChunkV4") return {uploadId:key,nextChunkIndex:receipt.count};
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
      u.committing = this.commit(u).then((result) => {
        // 已完成的回执用于重试，不能继续占用同一主机的并发上传名额。
        if (this.uploads.get(key) === u) {
          this.uploads.delete(key);
          this.completed.set(key, {ref:result.ref, count:u.count, checksum:u.checksum, total:u.total, fileName:u.fileName, mime:u.mime});
          if (this.completed.size > 2048) this.completed.delete(this.completed.keys().next().value!);
        }
        return result;
      }).finally(() => { u.committing = undefined; });
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

const chunkRequest = z.object({
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive().max(PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes),
});

const nativeImageMimeTypes = new Map([
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

const imageRefPrefix = "codex-image:";
const nativeImageLocation = z.tuple([z.string(), z.string(), z.number().int().nonnegative()]);
type NativeImageLocation = { turnId: string; itemId: string };

function embeddedImage(url: string) {
  const header = /^data:image\/(avif|gif|jpeg|png|webp);base64,/iu.exec(url);
  if (!header) return;
  const bodyOffset = header[0].length;
  const encodedLength = url.length - bodyOffset;
  const padding = url.endsWith("==") ? 2 : url.endsWith("=") ? 1 : 0;
  const remainder = encodedLength % 4;
  const bytes = Math.floor((encodedLength * 3) / 4) - padding;
  if (
    remainder === 1 ||
    (padding > 0 && remainder !== 0) ||
    bytes <= 0 ||
    bytes > PROTOCOL_V4_LIMITS.attachmentMaxBytes
  )
    return;
  const format = header[1]!.toLowerCase();
  return { mime: `image/${format}`, fileName: `image.${format}`, bodyOffset, bytes };
}

function externalImage(url: string) {
  if (!/^https?:\/\//iu.test(url)) return;
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password)
      return { href: parsed.href, fileName: parsed.pathname.split("/").at(-1) || parsed.hostname };
  } catch {
    // Codex 历史中的图片地址可以失效，仍保留同条消息的正文。
  }
}

export function nativeUserImages(content: unknown, location?: NativeImageLocation) {
  const attachments: AttachmentRef[] = [];
  const links: { href: string; fileName: string }[] = [];
  for (const [index, part] of array(content).entries()) {
    if (part.type === "localImage") {
      const path = str(part.path);
      if (!path.startsWith("/")) continue;
      const fileName = path.slice(path.lastIndexOf("/") + 1);
      const extension = /\.[^.]+$/u.exec(fileName)?.[0].toLowerCase();
      const mime = extension && nativeImageMimeTypes.get(extension);
      if (mime) attachments.push({ ref: path, fileName, mime, bytes: 0 });
    } else if (part.type === "image" && location) {
      const url = str(part.url);
      // Codex 也会把图片保存在 image.url 中。投影只保留消息位置，避免把长图复制进会话帧。
      const ref = imageRefPrefix + JSON.stringify([location.turnId, location.itemId, index]);
      const inline = embeddedImage(url);
      if (inline) {
        attachments.push({ ref, fileName: inline.fileName, mime: inline.mime, bytes: inline.bytes });
      } else {
        const link = externalImage(url);
        if (!link) continue;
        // 外链沿用现有文件标记和来源链接，避免图片组件在挂载时访问外站。
        attachments.push({ ref, fileName: link.fileName, mime: "text/uri-list", bytes: 0 });
        links.push(link);
      }
    }
  }
  return { attachments, links };
}

function findEmbeddedImage(turns: Message[], ref: string) {
  if (!ref.startsWith(imageRefPrefix)) return;
  let decoded: unknown;
  try {
    decoded = JSON.parse(ref.slice(imageRefPrefix.length));
  } catch {
    return;
  }
  const location = nativeImageLocation.safeParse(decoded);
  if (!location.success) return;
  const [turnId, itemId, index] = location.data;
  const turn = turns.find((value) => value.id === turnId);
  const item = array(turn?.items).find((value) => value.id === itemId && value.type === "userMessage");
  const part = Array.isArray(item?.content) ? rec(item.content[index]) : {};
  if (part.type !== "image") return;
  const url = str(part.url);
  const image = embeddedImage(url);
  if (image) return { ...image, url };
}

function readEmbeddedImageChunk(
  turns: Message[],
  ref: string,
  offset: number,
  limit: number,
): V4AttachmentReadResult {
  const image = findEmbeddedImage(turns, ref);
  if (!image) throw Error("fault.attachment.previewUnavailable");
  const totalBytes = image.bytes;
  if (offset >= totalBytes) throw Error("fault.attachment.previewOffsetMismatch");
  const nextOffset = Math.min(offset + limit, totalBytes);
  // 对齐 Base64 的四字符组，只解码请求所在的一小段，再裁剪到准确的字节范围。
  const start = Math.floor(offset / 3);
  const end = Math.ceil(nextOffset / 3);
  const base64 = image.url.slice(image.bodyOffset + start * 4, image.bodyOffset + end * 4);
  if (/[^A-Za-z0-9+/=]/u.test(base64)) throw Error("fault.attachment.previewUnavailable");
  const decoded = atob(base64);
  if (decoded.length !== Math.min(totalBytes, end * 3) - start * 3)
    throw Error("fault.attachment.previewTruncated");
  return {
    dataBase64: btoa(decoded.slice(offset - start * 3, nextOffset - start * 3)),
    mediaType: image.mime,
    totalBytes,
    nextOffset: nextOffset < totalBytes ? nextOffset : null,
  };
}

export async function readNativeImageChunk(
  gateway: Gateway,
  hostId: number,
  turns: Message[],
  request: Message,
): Promise<V4AttachmentReadResult> {
  const { offset, limit } = chunkRequest.parse(request);
  const path = str(request.ref);
  if (!path.startsWith("/")) return readEmbeddedImageChunk(turns, path, offset, limit);
  const attachment = turns
    .flatMap((turn) => array(turn.items))
    .filter((item) => item.type === "userMessage")
    .flatMap((item) => nativeUserImages(item.content).attachments)
    .find((image) => image.ref === path);
  if (!attachment) throw Error("fault.attachment.previewUnavailable");
  const fileStat = await gateway.request(
    "/api/selfhost/workspace",
    z.object({
      value: z.object({
        type: z.literal("file"),
        size: z.number().int().positive().max(PROTOCOL_V4_LIMITS.attachmentMaxBytes),
      }),
    }),
    "POST",
    { hostId, channel: "file", method: "stat", args: [{ path }] },
  );
  const totalBytes = fileStat.value.size;
  if (offset >= totalBytes) throw Error("fault.attachment.previewOffsetMismatch");
  const length = Math.min(limit, totalBytes - offset);
  const { value } = await gateway.request(
    "/api/selfhost/workspace",
    z.object({ value: z.object({ binary: z.string() }) }),
    "POST",
    { hostId, channel: "file", method: "readFileRange", args: [{ path, offset, length }] },
  );
  const nextOffset = offset + length;
  return {
    dataBase64: value.binary,
    mediaType: attachment.mime,
    totalBytes,
    nextOffset: nextOffset < totalBytes ? nextOffset : null,
  };
}
