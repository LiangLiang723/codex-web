import { z } from "zod";

const turnPage = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      status: z.string().min(1),
      items: z.array(z.record(z.string(), z.any())).default([]),
    }),
  ),
  nextCursor: z.string().nullable(),
});

export async function readShareTurns(
  read: (cursor: string | null) => Promise<unknown>,
  selection?: string[],
) {
  const wanted = selection ? new Set(selection) : null;
  const turns = new Map<string, z.infer<typeof turnPage>["data"][number]>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = turnPage.parse(await read(cursor));
    for (const turn of page.data) if (!wanted || wanted.has(turn.id)) turns.set(turn.id, turn);
    if (turns.size > 300) throw Error("请最多选择 300 个轮次");
    if (wanted && turns.size === wanted.size) break;
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw Error("Codex 返回了重复的历史游标");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  if (wanted) {
    const missing = [...wanted].filter((id) => !turns.has(id));
    if (missing.length) throw Error("找不到所选轮次 " + missing.join(", "));
  }
  return [...turns.values()];
}
