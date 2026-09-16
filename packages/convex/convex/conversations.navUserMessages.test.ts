import { describe, expect, test } from "bun:test";
import {
  collectNavigableUserMessages,
  NAV_USER_MESSAGES_OLDEST_LIMIT,
  NAV_USER_MESSAGES_SCAN_LIMIT,
} from "./conversations";
import { makeFakeDb } from "./testDb";

// Regression for the "too many system operations" timeout on getUserMessages:
// the user-role index range is mostly tool results, so an unbounded collect
// scanned thousands of docs per reactive re-run on big sessions. The helper
// scans a bounded newest window and a bounded oldest window — a prompt in the
// gap between them is dropped, never scanned.
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

  test("the opening prompt survives even when the newest window is full of tool results", async () => {
    const rows: any[] = [
      { _id: "messages_recent", conversation_id: CONV, role: "user", content: "recent prompt", timestamp: 1_000_000 },
    ];
    for (let i = 0; i < NAV_USER_MESSAGES_SCAN_LIMIT; i++) {
      rows.push(toolResultRow(i, 999_000 - i));
    }
    rows.push({ _id: "messages_ancient", conversation_id: CONV, role: "user", content: "ancient prompt", timestamp: 10 });
    const db = makeFakeDb({ messages: rows });

    const out = await collectNavigableUserMessages(db, CONV);
    expect(out.map((m) => m.content)).toEqual(["ancient prompt", "recent prompt"]);
  });

  test("a prompt in the gap between the oldest and newest windows is not returned", async () => {
    const rows: any[] = [
      { _id: "messages_recent", conversation_id: CONV, role: "user", content: "recent prompt", timestamp: 1_000_000 },
    ];
    for (let i = 0; i < NAV_USER_MESSAGES_SCAN_LIMIT; i++) {
      rows.push(toolResultRow(i, 900_000 - i));
    }
    rows.push({ _id: "messages_middle", conversation_id: CONV, role: "user", content: "middle prompt", timestamp: 50_000 });
    for (let i = 0; i < NAV_USER_MESSAGES_OLDEST_LIMIT; i++) {
      rows.push(toolResultRow(10_000 + i, 40_000 - i));
    }
    rows.push({ _id: "messages_ancient", conversation_id: CONV, role: "user", content: "ancient prompt", timestamp: 10 });
    const db = makeFakeDb({ messages: rows });

    const out = await collectNavigableUserMessages(db, CONV);
    expect(out.map((m) => m.content)).toEqual(["ancient prompt", "recent prompt"]);
  });
});
