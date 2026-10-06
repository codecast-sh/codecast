import { expect, test } from "bun:test";
import { matchScore, mergeMentionSuggestions, withMentionViewTime } from "./mentionRanking";
import { buildMentionContext } from "./mentionContext";
import type { MentionItem } from "./mentionItem";

test("view timestamps reuse unchanged candidates without mutating them", () => {
  const item: MentionItem = { id: "a", type: "task", label: "Task", viewedAt: 10, shortId: "ct-1" };
  expect(withMentionViewTime(item, new Map())).toBe(item);
  const next = withMentionViewTime(item, new Map([["task:ct-1", 20]]));
  expect(next.viewedAt).toBe(20);
  expect(item.viewedAt).toBe(10);
  expect(withMentionViewTime({ ...item, viewedAt: undefined }, new Map()).viewedAt).toBe(0);
});

test("empty and whitespace queries retain context then recency order", () => {
  const items: MentionItem[] = [
    { id: "a", type: "task", label: "A", updatedAt: 100 },
    { id: "b", type: "task", label: "B", updatedAt: 10 },
    { id: "c", type: "person", label: "C", updatedAt: 200 },
  ];
  const context = buildMentionContext(["b"]);
  for (const query of ["", "  "]) {
    expect(mergeMentionSuggestions(items, [], new Map(), Infinity, query, false, context).map(x => x.id)).toEqual(["b", "c", "a"]);
  }
});

test("query token reuse invalidates between different searches", () => {
  for (let i = 0; i < 3; i++) {
    expect(matchScore("Desktop performance", " desktop PER ")).toBe(1);
    expect(matchScore("Desktop performance", "missing")).toBe(Infinity);
    expect(matchScore("Desktop performance", "")).toBe(0);
    expect(matchScore("Desktop performance", "performance desktop")).toBe(0);
  }
});
