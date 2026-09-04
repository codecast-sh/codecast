import { describe, expect, test } from "bun:test";
import { READ_PAGE_SIZE, readConversationRange, readWindow } from "./conversations";

// `cast read <id> 1:400` on a 79 message session returned the first 50 lines
// and stopped: the query capped one call at READ_PAGE_SIZE and nothing asked
// for the rest. An explicit range now pages until every line in it is covered.

const TOTAL = 79;

/** One page of the read query over a synthetic session, driven by readWindow. */
function pageOver(total: number) {
  return async (args: { start_line?: number; end_line?: number; context?: number; around_message_id?: string }) => {
    const target = args.around_message_id ? Number(args.around_message_id) : undefined;
    const window = readWindow(total, args, target);
    const messages = Array.from({ length: window.count }, (_, i) => ({ line: window.startLine + i }));
    return { conversation: { message_count: total }, messages, target_line: target, next_line: window.nextLine };
  };
}

const lines = (result: any) => result.messages.map((m: any) => m.line);
const base = { api_token: "t", conversation_id: "c" };

describe("readWindow", () => {
  test("one call never exceeds the page size and says where the next page starts", () => {
    expect(readWindow(TOTAL, { start_line: 1, end_line: 400 }, undefined)).toEqual({
      startLine: 1,
      count: READ_PAGE_SIZE,
      nextLine: READ_PAGE_SIZE + 1,
    });
  });

  test("the last page of a range has no next line", () => {
    expect(readWindow(TOTAL, { start_line: 51, end_line: 400 }, undefined)).toEqual({
      startLine: 51,
      count: 29,
      nextLine: undefined,
    });
  });

  test("a start with no end reads to the last message", () => {
    expect(readWindow(TOTAL, { start_line: 45 }, undefined)).toEqual({ startLine: 45, count: 35, nextLine: undefined });
  });

  test("no range at all is the first twenty lines", () => {
    expect(readWindow(TOTAL, {}, undefined)).toEqual({ startLine: 1, count: 20, nextLine: undefined });
  });

  test("a start past the end returns nothing rather than a negative count", () => {
    expect(readWindow(TOTAL, { start_line: 90, end_line: 100 }, undefined)).toEqual({ startLine: 90, count: 0, nextLine: undefined });
  });

  test("an anchored window stays inside one page with the anchor in it", () => {
    const window = readWindow(TOTAL, { context: 40 }, 40);
    expect(window.count).toBeLessThanOrEqual(READ_PAGE_SIZE);
    expect(window.startLine).toBeLessThanOrEqual(40);
    expect(window.startLine + window.count - 1).toBeGreaterThanOrEqual(40);
    expect(window.nextLine).toBeUndefined();
  });
});

describe("readConversationRange", () => {
  test("a wide range returns every message in it", async () => {
    const result = await readConversationRange(pageOver(TOTAL), { ...base, start_line: 1, end_line: 400 });
    expect(lines(result)).toEqual(Array.from({ length: TOTAL }, (_, i) => i + 1));
    expect(result.next_line).toBeUndefined();
  });

  test("a range inside the session stops at its end", async () => {
    const result = await readConversationRange(pageOver(TOTAL), { ...base, start_line: 45, end_line: 80 });
    expect(lines(result)).toEqual(Array.from({ length: 35 }, (_, i) => i + 45));
  });

  test("a range wider than several pages is covered page by page", async () => {
    const calls: number[] = [];
    const page = pageOver(230);
    const result = await readConversationRange(
      async (args) => {
        calls.push(args.start_line ?? 1);
        return page(args);
      },
      { ...base, start_line: 1, end_line: 1000 },
    );
    expect(calls).toEqual([1, 51, 101, 151, 201]);
    expect(lines(result)).toHaveLength(230);
  });

  test("an open ended start pages to the last message", async () => {
    const result = await readConversationRange(pageOver(130), { ...base, start_line: 12 });
    expect(lines(result)).toEqual(Array.from({ length: 119 }, (_, i) => i + 12));
  });

  test("an anchored read is one page and keeps its target line", async () => {
    const calls: any[] = [];
    const page = pageOver(TOTAL);
    const result = await readConversationRange(
      async (args) => {
        calls.push(args);
        return page(args);
      },
      { ...base, around_message_id: "40", context: 5 },
    );
    expect(calls).toHaveLength(1);
    expect(result.target_line).toBe(40);
    expect(lines(result)).toEqual(Array.from({ length: 11 }, (_, i) => i + 35));
  });

  test("an error on any page is returned as is", async () => {
    const result = await readConversationRange(async () => ({ error: "Access denied" }), { ...base, start_line: 1, end_line: 400 });
    expect(result).toEqual({ error: "Access denied" });
  });
});
