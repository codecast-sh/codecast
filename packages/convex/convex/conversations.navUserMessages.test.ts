import { describe, expect, test } from "bun:test";
import {
  collectNavigableUserMessages,
  NAV_USER_MESSAGES_HARD_BYTE_CEILING,
  NAV_USER_MESSAGES_OLDEST_LIMIT,
  NAV_USER_MESSAGES_SCAN_LIMIT,
} from "./conversations";
import { makeFakeDb } from "./testDb";
import { navPromptField, navPromptPatch } from "./userMessagesFilter";

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

  // The document ceiling alone never bounded the COST. A tool result carries
  // the whole command output, so 2000 of them is tens of megabytes — past what
  // the 1s user-JS cap (bytes deserialized and serialized) and the
  // system-operation budget allow. The scan now stops on bytes too, and the
  // ceiling is spent across BOTH directions so it bounds the whole execution.
  const FAT = 100_000;

  function fatToolResult(i: number, ts: number) {
    return {
      _id: `messages_fat_${i}`, conversation_id: CONV, role: "user", content: "",
      tool_results: [{ tool_use_id: `toolu_${i}`, content: "x".repeat(FAT) }],
      timestamp: ts,
    };
  }

  // Counts documents the handler pulls off the index, across both passes.
  function countingDb(rows: any[]) {
    const db = makeFakeDb({ messages: rows });
    const stats = { docsRead: 0 };
    return {
      stats,
      db: {
        query: (table: string) => {
          const q = (db as any).query(table);
          const iter = q[Symbol.asyncIterator].bind(q);
          q[Symbol.asyncIterator] = async function* () {
            for await (const r of iter()) { stats.docsRead++; yield r; }
          };
          return q;
        },
      } as any,
    };
  }

  test("a wall of fat tool results cannot run past the hard byte ceiling", async () => {
    const rows: any[] = [
      { _id: "messages_recent", conversation_id: CONV, role: "user", content: "recent prompt", timestamp: 1_000_000 },
    ];
    // 400 fat tool results = ~40MB, ten times the ceiling.
    for (let i = 0; i < 400; i++) rows.push(fatToolResult(i, 999_000 - i));
    const { db, stats } = countingDb(rows);

    const out = await collectNavigableUserMessages(db, CONV);
    // The newest prompt still arrives — it is the first row the desc walk sees.
    expect(out.map((m) => m.content)).toEqual(["recent prompt"]);
    // The ceiling is shared, so the two passes together stay near it.
    const ceilingDocs = Math.ceil(NAV_USER_MESSAGES_HARD_BYTE_CEILING / FAT);
    expect(stats.docsRead).toBeLessThanOrEqual(ceilingDocs + 4);
    expect(stats.docsRead).toBeLessThan(401);
  });

  // The byte budget must not starve the list it protects: a transcript whose
  // newest turns are huge file reads would spend the soft budget before
  // reaching a prompt, and the navigator would open empty.
  test("the soft budget does not stop the scan before it has found rows", async () => {
    const rows: any[] = [];
    // ~2.5MB of tool results sit in front of the prompts — past the 2MB soft
    // budget, under the 4MB hard ceiling.
    for (let i = 0; i < 25; i++) rows.push(fatToolResult(i, 999_000 - i));
    for (let i = 0; i < 12; i++) {
      rows.push({ _id: `messages_p${i}`, conversation_id: CONV, role: "user", content: `prompt ${i}`, timestamp: 900_000 - i });
    }
    const db = makeFakeDb({ messages: rows });

    const out = await collectNavigableUserMessages(db, CONV);
    // All twelve prompts survive; the soft budget deferred to the row floor.
    expect(out).toHaveLength(12);
    expect(out.map((m) => m.content)).toContain("prompt 0");
    expect(out.map((m) => m.content)).toContain("prompt 11");
  });

  test("a normal conversation is unaffected by the budget", async () => {
    const rows: any[] = [];
    for (let i = 0; i < 40; i++) {
      rows.push({ _id: `messages_p${i}`, conversation_id: CONV, role: "user", content: `prompt ${i}`, timestamp: 1000 + i });
    }
    const db = makeFakeDb({ messages: rows });
    const out = await collectNavigableUserMessages(db, CONV);
    expect(out).toHaveLength(40);
    expect(out[0].content).toBe("prompt 0");
    expect(out[39].content).toBe("prompt 39");
  });
});

// jx7d8av, 2026-11-03: a lead session's newest stretch held ~1,250 user-role
// rows of tool results and worker messages. The newest-first scan filled its
// 50-row floor with worker messages and spent the byte budget, the oldest pass
// started with nothing left, and the navigator showed 1 of 140 typed prompts.
// Rows flagged for the prompt index (navPromptField, as every write sets them)
// are read off by_conversation_nav_prompt, so the tool results never cost a
// read and every prompt arrives.
describe("collectNavigableUserMessages on the prompt index", () => {
  const CONV = "conversations_1" as any;

  function flagged(row: any) {
    return { ...row, ...navPromptField(row) };
  }

  function leadSessionRows() {
    const rows: any[] = [];
    let ts = 10;
    rows.push(flagged({ _id: "messages_first", conversation_id: CONV, role: "user", content: "opening prompt", timestamp: ts++ }));
    for (let i = 0; i < 600; i++) {
      rows.push(flagged({ _id: `messages_old_tr_${i}`, conversation_id: CONV, role: "user", content: "", tool_results: [{ tool_use_id: `t${i}`, content: "y".repeat(5_000) }], timestamp: ts++ }));
    }
    for (let i = 0; i < 20; i++) {
      rows.push(flagged({ _id: `messages_typed_${i}`, conversation_id: CONV, role: "user", content: `typed prompt ${i}`, timestamp: ts++ }));
    }
    for (let i = 0; i < 1_200; i++) {
      rows.push(flagged({ _id: `messages_tr_${i}`, conversation_id: CONV, role: "user", content: "", tool_results: [{ tool_use_id: `u${i}`, content: "x".repeat(2_000) }], timestamp: ts++ }));
      if (i % 20 === 0) {
        rows.push(flagged({ _id: `messages_worker_${i}`, conversation_id: CONV, role: "user", content: `<session-message from="jx7aaaa">worker report ${i}</session-message>`, timestamp: ts++ }));
      }
    }
    return rows;
  }

  test("the bounded scan misses the typed prompts behind the worker wall", async () => {
    const out = await collectNavigableUserMessages(makeFakeDb({ messages: leadSessionRows() }), CONV);
    expect(out.filter((m) => m.content.startsWith("typed prompt"))).toHaveLength(0);
  });

  test("the prompt index returns every typed prompt", async () => {
    const out = await collectNavigableUserMessages(makeFakeDb({ messages: leadSessionRows() }), CONV, true);
    expect(out.filter((m) => m.content.startsWith("typed prompt"))).toHaveLength(20);
    expect(out[0].content).toBe("opening prompt");
    expect(out.some((m) => m.content.includes("worker report"))).toBe(true);
    expect(out.every((m) => m.content !== "")).toBe(true);
  });
});

describe("navPromptField / navPromptPatch", () => {
  test("flags typed prompts and images, never tool results or notices", () => {
    expect(navPromptField({ role: "user", content: "fix the bug" })).toEqual({ nav_prompt: true });
    expect(navPromptField({ role: "user", content: "", tool_results: [{ tool_use_id: "t", content: "ok" }] })).toEqual({});
    expect(navPromptField({ role: "assistant", content: "done" })).toEqual({});
    expect(navPromptField({ role: "user", content: "", images: [{ media_type: "image/png", storage_id: "s1" }] })).toEqual({ nav_prompt: true });
    expect(navPromptField({ role: "user", content: "This session is being continued from a previous conversation" })).toEqual({});
  });

  test("a patch sets, clears, or leaves the flag", () => {
    const empty = { role: "user" as const, content: "" };
    expect(navPromptPatch(empty, { images: [{ media_type: "image/png", storage_id: "s1" }] })).toEqual({ nav_prompt: true });
    const prompt = { role: "user" as const, content: "hi", nav_prompt: true as const };
    expect(navPromptPatch(prompt, { content: "This session is being continued" })).toEqual({ nav_prompt: undefined });
    expect(navPromptPatch(prompt, { content: "hello" })).toEqual({});
    expect(navPromptPatch(prompt, null)).toEqual({});
  });
});

// Every user-role message a mutation writes must carry its flag, or the
// prompt index silently drops it. Assistant rows never qualify.
describe("message inserts set nav_prompt", () => {
  test("every user-role or dynamic-role insert goes through navPromptField", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const offenders: string[] = [];
    for (const file of readdirSync(import.meta.dir)) {
      if (!file.endsWith(".ts") || file.includes(".test.")) continue;
      const src = readFileSync(`${import.meta.dir}/${file}`, "utf8");
      const re = /(?:db\.insert\("messages",|insertMessage\()\s*\{([\s\S]*?)\n\s*\}\);/g;
      for (const m of src.matchAll(re)) {
        const body = m[1];
        if (/role:\s*"assistant"/.test(body)) continue;
        if (!/navPromptField\(|nav_prompt:/.test(body)) offenders.push(`${file}: ${body.trim().slice(0, 60)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
