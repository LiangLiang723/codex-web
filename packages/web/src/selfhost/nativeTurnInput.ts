type SelectedFile = { path: string; name: string; isImage?: boolean };
type ImageInput = { path?: string; url?: string; detail?: string };
type TurnMaterial = {
  text: string;
  files?: readonly SelectedFile[];
  images?: readonly ImageInput[];
};

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
  if (input.text.trim()) items.push({ type: "text", text: input.text, text_elements: [] });
  // 输入框保存的是显式 Markdown 引用；保留原文，同时把选中的路径或插件 ID 交给 Codex。
  const links = /\[([@$])((?:\\.|[^\\\]])+)\]\((?:<((?:\\.|[^>])+)>|((?:\\.|[^)])+))\)/gu;
  const seen = new Set<string>();
  for (const match of input.text.matchAll(links)) {
    const name = match[2]!.replace(/\\([\\()[\]<>])/gu, "$1");
    const path = (match[3] ?? match[4]!).replace(/\\([\\()[\]<>])/gu, "$1");
    const type =
      match[1] === "$" && path.startsWith("/") && path.endsWith("/SKILL.md")
        ? "skill"
        : match[1] === "@" && /^plugin:\/\/[^\s#?]+$/u.test(path)
          ? "mention"
          : null;
    if (type && !seen.has(path)) {
      seen.add(path);
      items.push({ type, name, path });
    }
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
