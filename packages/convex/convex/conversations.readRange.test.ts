import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { hashToken } from "@platform/auth/convex";
import { internal } from "./_generated/api";
import schema from "./schema";
import { READ_PAGE_SIZE, READ_STEP_BYTES, readConversationRange, readRange } from "./conversations";

// `cast read <id> 1:400` on a 79 message session returned the first 50 lines
// and stopped; an explicit range now covers every line in it. And `cast read`,
// `cast summary` and `cast diff` failed on a long session with image rows:
// the query loaded every row at once and ran out of Convex's 64 MB heap. A
// read is now scan steps and fetch steps, each under READ_STEP_BYTES.

const TOTAL = 79;
const base = { api_token: "t", conversation_id: "c" };
const lines = (result: any) => result.messages.map((m: any) => m.line);

/**
 * Fake steps over a synthetic session of `total` rows, `stepRows` rows per
 * scan step. `empty` rows are skipped by line numbering, as the real scan does.
 */
function stepsOver(total: number, opts: { stepRows?: number; empty?: Set<number> } = {}) {
  const stepRows = opts.stepRows ?? 30;
  const rows = Array.from({ length: total }, (_, i) => `m${i + 1}`);
  const log = { scans: [] as number[], fetched: [] as string[] };
  return {
    log,
    scan: async (args: any) => {
      const from = args.after?.skip ?? 0;
      log.scans.push(from);
      const slice = rows.slice(from, from + stepRows);
      const ids: string[] = [];
      let anchor_index: number | undefined;
      for (const id of slice) {
        if (id === args.around_message_id) anchor_index = ids.length;
        if (!opts.empty?.has(Number(id.slice(1)))) ids.push(id);
      }
      const done = from + stepRows >= total;
      return {
        ids,
        anchor_index,
        cursor: done ? undefined : { creation_time: 0, skip: from + stepRows },
        ...(args.after ? {} : { conversation: { id: "c", title: "t", message_count: total } }),
      };
    },
    fetch: async (args: any) => {
      const take = args.ids.slice(0, 7);
      log.fetched.push(...take);
      return { messages: take.map((id: string, i: number) => ({ id, line: args.first_line + i })), consumed: take.length };
    },
  };
}

describe("readRange", () => {
  test("an explicit range is every line in it", () => {
    expect(readRange(TOTAL, { start_line: 1, end_line: 400 }, undefined)).toEqual({ startLine: 1, lastLine: TOTAL });
  });

  test("a start with no end reads to the last message", () => {
    expect(readRange(TOTAL, { start_line: 45 }, undefined)).toEqual({ startLine: 45, lastLine: TOTAL });
  });

  test("no range at all is the first twenty lines", () => {
    expect(readRange(TOTAL, {}, undefined)).toEqual({ startLine: 1, lastLine: 20 });
  });

  test("an anchored window stays inside one page with the anchor in it", () => {
    const { startLine, lastLine } = readRange(TOTAL, { context: 40 }, 40);
    expect(lastLine - startLine + 1).toBeLessThanOrEqual(READ_PAGE_SIZE);
    expect(startLine).toBeLessThanOrEqual(40);
    expect(lastLine).toBeGreaterThanOrEqual(40);
  });
});

describe("readConversationRange", () => {
  test("a wide range returns every message in it, with the exact count", async () => {
    const steps = stepsOver(TOTAL);
    const result = await readConversationRange(steps, { ...base, start_line: 1, end_line: 400 });
    expect(lines(result)).toEqual(Array.from({ length: TOTAL }, (_, i) => i + 1));
    expect(result.conversation.message_count).toBe(TOTAL);
  });

  test("the default read stops scanning once it has the first twenty lines", async () => {
    const steps = stepsOver(500);
    const result = await readConversationRange(steps, base);
    expect(lines(result)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(steps.log.scans).toEqual([0]);
  });

  test("an open ended start scans to the last message", async () => {
    const steps = stepsOver(130);
    const result = await readConversationRange(steps, { ...base, start_line: 12 });
    expect(lines(result)).toEqual(Array.from({ length: 119 }, (_, i) => i + 12));
    expect(steps.log.scans).toEqual([0, 30, 60, 90, 120]);
  });

  test("empty rows take no line number", async () => {
    const steps = stepsOver(10, { empty: new Set([2, 3]) });
    const result = await readConversationRange(steps, { ...base, start_line: 1, end_line: 10 });
    expect(result.messages.map((m: any) => m.id)).toEqual(["m1", "m4", "m5", "m6", "m7", "m8", "m9", "m10"]);
    expect(lines(result)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("an anchor in a later scan step centers the window on it", async () => {
    const steps = stepsOver(200);
    const result = await readConversationRange(steps, { ...base, around_message_id: "m95", context: 5 });
    expect(result.target_line).toBe(95);
    expect(lines(result)).toEqual(Array.from({ length: 11 }, (_, i) => i + 90));
    expect(steps.log.scans).toEqual([0, 30, 60, 90]);
  });

  test("an anchor on an empty row snaps to the next visible line", async () => {
    const steps = stepsOver(20, { empty: new Set([5]) });
    const result = await readConversationRange(steps, { ...base, around_message_id: "m5", context: 1 });
    expect(result.target_line).toBe(5);
    expect(result.messages.map((m: any) => m.id)).toEqual(["m4", "m6", "m7"]);
  });

  test("a missing anchor is reported and the read shows the start", async () => {
    const result = await readConversationRange(stepsOver(30), { ...base, around_message_id: "nope" });
    expect(result.target_missing).toBe(true);
    expect(lines(result)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  test("an error on any step is returned as is", async () => {
    const denied = async () => ({ error: "Access denied" });
    expect(await readConversationRange({ scan: denied, fetch: denied }, base)).toEqual({ error: "Access denied" });
  });
});

describe("the read steps against the real queries", () => {
  const modules = {
    "./_generated/server.ts": () => import("./_generated/server"),
    "./conversations.ts": () => import("./conversations"),
  };
  const token = "r".repeat(64);

  async function seed(rows: Array<{ content?: string; image?: number }>) {
    const t = convexTest(schema, modules);
    const conversation_id = await t.run(async (ctx) => {
      const user = await ctx.db.insert("users", { name: "Reader" } as any);
      await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(token), name: "cli", created_at: Date.now(), last_used_at: Date.now() } as any);
      const conv = await ctx.db.insert("conversations", {
        user_id: user, agent_type: "claude_code", status: "active", started_at: 1, updated_at: 1, message_count: rows.length, is_private: true, session_id: "s1",
      } as any);
      for (const [i, row] of rows.entries()) {
        await ctx.db.insert("messages", {
          conversation_id: conv,
          role: i % 2 ? "assistant" : "user",
          content: row.content ?? "",
          timestamp: 1000 + i,
          ...(row.image ? { images: [{ media_type: "image/png", data: "x".repeat(row.image) }] } : {}),
        } as any);
      }
      return conv;
    });
    const scans: any[] = [];
    const steps = {
      scan: async (a: any) => {
        const r = await t.query(internal.conversations.scanConversationLines, a);
        scans.push(r);
        return r;
      },
      fetch: (a: any) => t.query(internal.conversations.readConversationLines, a),
    };
    return { steps, scans, conversation_id: String(conversation_id) };
  }

  test("a session of image rows is scanned in steps under the byte budget", async () => {
    // Each row carries a third of the budget in image data, so no step may
    // hold more than three of them.
    const rows = Array.from({ length: 12 }, (_, i) => ({ content: `line ${i + 1}`, image: Math.ceil(READ_STEP_BYTES / 3) }));
    const { steps, scans, conversation_id } = await seed(rows);
    const result = await readConversationRange(steps, { api_token: token, conversation_id, start_line: 1 });
    expect(result.error).toBeUndefined();
    expect(result.messages.map((m: any) => m.content)).toEqual(rows.map((r) => r.content));
    expect(lines(result)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(scans.length).toBeGreaterThan(3);
    for (const step of scans) expect(step.ids.length).toBeLessThanOrEqual(3);
    expect(result.conversation.message_count).toBe(12);
  });

  test("empty rows are skipped and the anchor resolves across steps", async () => {
    const heavy = Math.ceil(READ_STEP_BYTES / 2);
    const rows = [{ content: "first" }, { content: "  " }, { content: "second", image: heavy }, { content: "third", image: heavy }, { content: "fourth" }];
    const { steps, conversation_id } = await seed(rows);
    const all = await readConversationRange(steps, { api_token: token, conversation_id, start_line: 1 });
    expect(all.messages.map((m: any) => m.content)).toEqual(["first", "second", "third", "fourth"]);
    expect(all.conversation.title).toBe("first");
    const anchored = await readConversationRange(steps, { api_token: token, conversation_id, around_message_id: all.messages[3].id, context: 1 });
    expect(anchored.target_line).toBe(4);
    expect(anchored.messages.map((m: any) => m.content)).toEqual(["third", "fourth"]);
  });

  test("a stranger's token reads nothing", async () => {
    const { steps, conversation_id } = await seed([{ content: "secret" }]);
    expect(await readConversationRange(steps, { api_token: "z".repeat(64), conversation_id })).toEqual({ error: "Unauthorized" });
  });
});
