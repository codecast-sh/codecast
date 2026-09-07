import { describe, expect, test } from "bun:test";
import {
  collectConversationToolStats,
  TOOL_STATS_SCAN_LIMIT,
} from "./conversations";
import { makeFakeDb } from "./testDb";

// Regression for the "too many system operations" timeout on
// getConversationToolStats: assistant rows carry full tool_calls, so an
// unbounded (or 1000-row) newest-first walk blew the syscall budget on every
// reactive re-run of a live session. The helper must stop at the newest
// TodoWrite and never read past TOOL_STATS_SCAN_LIMIT.
describe("collectConversationToolStats", () => {
  const CONV = "conversations_1" as any;

  function writeRow(i: number, ts: number) {
    return {
      _id: `messages_w_${i}`,
      conversation_id: CONV,
      role: "assistant",
      timestamp: ts,
      tool_calls: [{ name: "Write", input: `{"file_path":"f${i}.ts","content":"${"x".repeat(200)}"}` }],
    };
  }

  function todoRow(id: string, ts: number, content: string) {
    return {
      _id: id,
      conversation_id: CONV,
      role: "assistant",
      timestamp: ts,
      tool_calls: [{ name: "TodoWrite", input: JSON.stringify({ todos: [{ content, status: "pending" }] }) }],
    };
  }

  test("returns the newest TodoWrite and ignores older ones", async () => {
    const db = makeFakeDb({
      messages: [
        todoRow("messages_old", 100, "old"),
        writeRow(1, 150),
        todoRow("messages_new", 300, "ship it"),
      ],
    });
    const out = await collectConversationToolStats(db, CONV);
    expect(out.taskStats?.items.map((i) => i.content)).toEqual(["ship it"]);
  });

  test("stops at the newest TodoWrite: filler behind it is not required", async () => {
    // Newest-first scan hits the todo on the first row; a revert to walking
    // the rest of the table (or collecting 1000) would still pass this, so
    // the bound test below is the one that fails on a raised cap.
    const db = makeFakeDb({
      messages: [
        todoRow("messages_head", 1_000, "head"),
        ...Array.from({ length: 10 }, (_, i) => writeRow(i, 900 - i)),
      ],
    });
    const out = await collectConversationToolStats(db, CONV);
    expect(out.taskStats?.items.map((i) => i.content)).toEqual(["head"]);
  });

  test("scan is bounded: a TodoWrite past the newest-first window is dropped", async () => {
    const rows: any[] = [];
    for (let i = 0; i < TOOL_STATS_SCAN_LIMIT; i++) {
      rows.push(writeRow(i, 1_000_000 - i));
    }
    rows.push(todoRow("messages_ancient", 10, "ancient"));
    const db = makeFakeDb({ messages: rows });

    const out = await collectConversationToolStats(db, CONV);
    expect(out.taskStats).toBeNull();
  });
});
