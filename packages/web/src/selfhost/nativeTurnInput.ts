type SelectedFile = { path: string; name: string; isImage?: boolean };
type ImageInput = { path?: string; url?: string; detail?: string };
type TurnMaterial = {
  text: string;
  files?: readonly SelectedFile[];
  images?: readonly ImageInput[];
};

type NativeExtensionInput = { type: "skill" | "mention"; name: string; path: string };
type NativeTextElement = { byteRange: { start: number; end: number }; placeholder: string };

const extensionLink = /\[([@$])((?:\\.|[^\\\]])+)\]\((?:<((?:\\.|[^>])+)>|((?:\\.|[^)])+))\)/gu;
const pluginPath = /^plugin:\/\/[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+$/u;
const appPath = /^app:\/\/[^\p{Cc}]+$/u;
const absoluteSkillPath = /^(?=\/|[a-z]:[\\/]|\\\\).*[\\/]SKILL\.md$/isu;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

function readExtensionLink(match: RegExpMatchArray) {
  const name = match[2]!.replace(/\\([\\()[\]<>])/gu, "$1");
  const path = (match[3] ?? match[4]!).replace(/\\([\\()[\]<>])/gu, "$1");
  if (match[1] === "$" && absoluteSkillPath.test(path)) {
    return { item: { type: "skill", name, path } as const, token: "$" + name };
  }
  if (match[1] === "@" && pluginPath.test(path)) {
    return { item: { type: "mention", name, path } as const, token: "@" + name };
  }
  if (match[1] === "$" && appPath.test(path)) {
    // 和 Codex connector_name_slug 一致，App ID 仍使用目录原值。
    const slug = name
      .replace(/[^a-zA-Z0-9]/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .toLowerCase();
    return { item: { type: "mention", name, path } as const, token: "$" + (slug || "app") };
  }
  return null;
}

function encodeExtensionText(text: string) {
  const textElements: NativeTextElement[] = [];
  const references = new Map<string, NativeExtensionInput>();
  let cursor = 0;
  let offset = 0;
  let nativeText = "";
  for (const match of text.matchAll(extensionLink)) {
    const link = readExtensionLink(match);
    if (!link) continue;
    const prefix = text.slice(cursor, match.index);
    const start = offset + encoder.encode(prefix).length;
    const end = start + encoder.encode(link.token).length;
    textElements.push({ byteRange: { start, end }, placeholder: match[0] });
    if (!references.has(link.item.path)) references.set(link.item.path, link.item);
    nativeText += prefix + link.token;
    cursor = match.index! + match[0].length;
    offset = end;
  }
  return {
    text: nativeText + text.slice(cursor),
    textElements,
    references: [...references.values()],
  };
}

export function buildNativeTurnInput(payload: Record<string, unknown>) {
  const attachments: unknown[] = Array.isArray(payload.attachments) ? payload.attachments : [];
  const files = attachments.map((value) => {
    const file = value as Record<string, unknown> | null;
    if (!file || typeof file.ref !== "string" || !file.ref.startsWith("/"))
      throw new Error("附件尚未上传，请保留草稿并重试");
    const mimeType = typeof file.mime === "string" ? file.mime : null;
    return {
      path: file.ref,
      name:
        typeof file.fileName === "string" ? file.fileName : file.ref.split("/").at(-1) || file.ref,
      mimeType,
      size: typeof file.bytes === "number" ? file.bytes : 0,
      isImage: mimeType?.startsWith("image/") ?? false,
    };
  });
  return {
    text: typeof payload.text === "string" ? payload.text : "",
    files,
    images: files.filter((file) => file.isImage).map(({ path }) => ({ path })),
  };
}

/** Shared by the SSH Gateway RPC builder and Web's native queue entry point. */
export function nativeUserInputItems(input: TurnMaterial): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  if (input.text.trim()) {
    // 编辑器里的引用链接用于保留身份。Codex 接收字面标记和结构项，原生历史的 UTF-8 范围保留显示位置。
    const { text, textElements, references } = encodeExtensionText(input.text);
    items.push({ type: "text", text, text_elements: textElements }, ...references);
  }
  const files = input.files?.filter((file) => !file.isImage);
  if (files?.length) {
    // 线程附件清单是展示元数据。普通文件必须把已上传的 SSH 路径传入这一轮的输入。
    items.push({
      type: "text",
      text: JSON.stringify({ files: files.map(({ name, path }) => ({ name, path })) }),
      text_elements: [],
    });
  }
  for (const image of input.images ?? []) {
    if (image.url)
      items.push({
        type: "image",
        url: image.url,
        ...(image.detail ? { detail: image.detail } : {}),
      });
    else if (image.path)
      items.push({
        type: "localImage",
        path: image.path,
        ...(image.detail ? { detail: image.detail } : {}),
      });
  }
  return items;
}

function restoreTextElements(
  text: string,
  elements: readonly unknown[],
  references: ReadonlySet<string>,
) {
  if (elements.length === 0 || references.size === 0) return text;
  const bytes = encoder.encode(text);
  let cursor = 0;
  let restored = "";
  for (const value of elements) {
    const element = value as Partial<NativeTextElement> | null;
    const placeholder = element?.placeholder;
    const range = element?.byteRange;
    if (
      typeof placeholder !== "string" ||
      !range ||
      !Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end) ||
      range.start < cursor ||
      range.end <= range.start ||
      range.end > bytes.length
    )
      continue;
    const match = [...placeholder.matchAll(extensionLink)][0];
    const link = match?.[0] === placeholder ? readExtensionLink(match) : null;
    if (
      !link ||
      !references.has(link.item.type + ":" + link.item.path) ||
      decoder.decode(bytes.subarray(range.start, range.end)) !== link.token
    )
      continue;
    restored += decoder.decode(bytes.subarray(cursor, range.start)) + placeholder;
    cursor = range.end;
  }
  return restored + decoder.decode(bytes.subarray(cursor));
}

export function restoreNativeTurnText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const references = new Set<string>();
  for (const item of content) {
    if ((item?.type === "skill" || item?.type === "mention") && typeof item.path === "string")
      references.add(item.type + ":" + item.path);
  }
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (typeof item?.text !== "string") return "";
      return restoreTextElements(
        item.text,
        Array.isArray(item.text_elements) ? item.text_elements : [],
        references,
      );
    })
    .filter(Boolean)
    .join("\n");
}
