import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MESSAGE_PAGE_MAX,
  pageConversationMessages,
} from "./conversations";
import { makeFakeDb } from "./testDb";

const CONV = "conversations_1" as any;

function seed(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    _id: `messages_${i + 1}`,
    conversation_id: CONV,
    timestamp: (i + 1) * 10,
    role: i % 2 === 0 ? "user" : "assistant",
    content: `m${i + 1}`,
  }));
}

describe("pageConversationMessages", () => {
  test("desc before-cursor is the newest rows older than the cursor", async () => {
    const db = makeFakeDb({ messages: seed(20) });
    const { messages, hasMore } = await pageConversationMessages(db, CONV, {
      before: 150,
      order: "desc",
      limit: 3,
    });
    expect(messages.map((m: any) => m.timestamp)).toEqual([140, 130, 120]);
    expect(hasMore).toBe(true);
  });

  test("asc from-cursor includes the center and walks forward", async () => {
    const db = makeFakeDb({ messages: seed(10) });
    const { messages, hasMore } = await pageConversationMessages(db, CONV, {
      from: 50,
      order: "asc",
      limit: 4,
    });
    expect(messages.map((m: any) => m.timestamp)).toEqual([50, 60, 70, 80]);
    expect(hasMore).toBe(true);
  });

  test("after-cursor is exclusive, matching getMoreMessages", async () => {
    const db = makeFakeDb({ messages: seed(5) });
    const { messages, hasMore } = await pageConversationMessages(db, CONV, {
      after: 20,
      order: "asc",
      limit: 10,
    });
    expect(messages.map((m: any) => m.timestamp)).toEqual([30, 40, 50]);
    expect(hasMore).toBe(false);
  });

  test("a full window reports no more", async () => {
    const db = makeFakeDb({ messages: seed(3) });
    const { messages, hasMore } = await pageConversationMessages(db, CONV, {
      order: "desc",
      limit: 10,
    });
    expect(messages.map((m: any) => m.timestamp)).toEqual([30, 20, 10]);
    expect(hasMore).toBe(false);
  });

  test("the page cap is 200, matching the client's deep window", async () => {
    const db = makeFakeDb({ messages: seed(250) });
    const { messages, hasMore } = await pageConversationMessages(db, CONV, {
      order: "desc",
      limit: 500,
    });
    expect(messages.length).toBe(MESSAGE_PAGE_MAX);
    expect(hasMore).toBe(true);
  });
});

describe("history page queries range the timestamp index", () => {
  const src = readFileSync(join(import.meta.dir, "conversations.ts"), "utf8");

  function body(declaration: string): string {
    const at = src.indexOf(declaration);
    expect(at, `${declaration} not found`).toBeGreaterThan(-1);
    const rest = src.slice(at + declaration.length);
    const nextExport = rest.search(/\nexport /);
    const slice = nextExport === -1 ? rest : rest.slice(0, nextExport);
    return (declaration + slice).replace(/\/\/[^\n]*/g, "");
  }

  test("pageConversationMessages bounds timestamp on the index, never via filter", () => {
    const fn = body("export async function pageConversationMessages(");
    expect(fn).toContain('withIndex("by_conversation_timestamp"');
    expect(fn).toContain('.lt("timestamp"');
    expect(fn).toContain('.gt("timestamp"');
    expect(fn).toContain('.gte("timestamp"');
    expect(fn).not.toContain(".filter(");
  });

  test("getAllMessages pages through the helper and does not reload the child graph", () => {
    const fn = body("export const getAllMessages = query({");
    expect(fn).toContain("pageConversationMessages");
    expect(fn).not.toContain("findChildConversations");
    expect(fn).not.toContain("getAccessibleForkChildren");
    expect(fn).not.toContain("conversationForAccess");
    expect(fn).not.toContain(".filter(");
  });

  test("getMessagesAroundTimestamp pages through the helper and does not reload the child graph", () => {
    const fn = body("export const getMessagesAroundTimestamp = query({");
    expect(fn).toContain("pageConversationMessages");
    expect(fn).not.toContain("findChildConversations");
    expect(fn).not.toContain("conversationForAccess");
    expect(fn).not.toContain(".filter(");
  });
});
