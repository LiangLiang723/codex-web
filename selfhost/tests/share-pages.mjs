import assert from "node:assert/strict";
import { readShareTurns } from "../gateway/overlay/utils/selfhost-share-turns.ts";

const pages = [
  {
    data: [
      { id: "A", items: [], status: "completed" },
      { id: "B", items: [], status: "completed" },
    ],
    nextCursor: "next",
  },
  { data: [{ id: "C", items: [], status: "completed" }], nextCursor: null },
];
const read = async (cursor) => pages[cursor ? 1 : 0];
assert.deepEqual(
  (await readShareTurns(read, ["A", "C"])).map((t) => t.id),
  ["A", "C"],
);
assert.deepEqual(
  (await readShareTurns(read)).map((t) => t.id),
  ["A", "B", "C"],
);
await assert.rejects(readShareTurns(read, ["A", "missing"]), /missing/);
await assert.rejects(
  readShareTurns(async () => pages[0], ["missing"]),
  /游标/,
);
console.log("PASS private share selection across native history pages");
