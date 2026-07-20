import { describe, expect, test } from "bun:test";
import {
  collectNavigableUserMessages,
  NAV_USER_MESSAGES_SCAN_LIMIT,
} from "./conversations";
import { makeFakeDb } from "./testDb";

// Regression for the "too many system operations" timeout on getUserMessages:
// the user-role index range is mostly tool results, so an unbounded collect
// scanned thousands of docs per reactive re-run on big sessions. The helper
// must scan a bounded newest-first window (NAV_USER_MESSAGES_SCAN_LIMIT) —
// prompts beyond the window are dropped, never scanned.
//
// makeFakeDb's order() is a no-op and take() slices in table order, so rows
// are laid out newest-first here to mirror the production `.order("desc")`
// scan; a revert to `.collect()` makes the out-of-window prompt reappear and
// fails the truncation test.
describe("collectNavigableUserMessages", () => {
  const CONV = "conversations_1" as any;

  function toolResultRow(i: number, ts: number) {
    return {
      _id: `messages_tr_${i}`,
      conversation_id: CONV,
      role: "user",
      content: "",
      tool_results: [{ tool_use_id: `toolu_${i}`, content: "ok" }],
      timestamp: ts,
    };
  }

  test("returns real prompts ascending, drops tool-result echoes", async () => {
    const db = makeFakeDb({
      messages: [
        { _id: "messages_p2", conversation_id: CONV, role: "user", content: "second prompt", timestamp: 300 },
        toolResultRow(1, 200),
        { _id: "messages_p1", conversation_id: CONV, role: "user", content: "first prompt", timestamp: 100 },
      ],
    });
    const out = await collectNavigableUserMessages(db, CONV);
    expect(out.map((m) => m.content)).toEqual(["first prompt", "second prompt"]);
  });

  test("scan is bounded: prompts past the newest-first window are not returned", async () => {
    // Newest-first layout: one real prompt near the head, then enough
    // tool-result filler to exhaust the scan window, then an old prompt that
    // sits beyond it.
    const rows: any[] = [
      { _id: "messages_recent", conversation_id: CONV, role: "user", content: "recent prompt", timestamp: 1_000_000 },
    ];
    for (let i = 0; i < NAV_USER_MESSAGES_SCAN_LIMIT; i++) {
      rows.push(toolResultRow(i, 999_000 - i));
    }
    rows.push({ _id: "messages_ancient", conversation_id: CONV, role: "user", content: "ancient prompt", timestamp: 10 });
    const db = makeFakeDb({ messages: rows });

    const out = await collectNavigableUserMessages(db, CONV);
    expect(out.map((m) => m.content)).toEqual(["recent prompt"]);
  });
});
