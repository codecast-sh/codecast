import { expect, test } from "bun:test";
import { buildMentionItems, filterMentionItems, mentionItemMatches, chatMentionOffers } from "../useMentionQuery";

const state = () => ({
  sessions: {}, tasks: { a: { _id: "a", title: "Original", team_id: "team", workspace: "team:team" } },
  docs: {}, plans: {}, teamMembers: [], buckets: {}, bucketAssignments: {},
  mentionIndex: { tasks: {}, docs: {}, plans: {} }, recentVisits: [], _lastViewedAt: {},
} as any);

test("reuses mention candidates across keystrokes and unrelated store writes", () => {
  const s = state();
  const first = buildMentionItems(s, { kind: "team", teamId: "team" });
  expect(buildMentionItems(s, { kind: "team", teamId: "team" })).toBe(first);
  expect(buildMentionItems({ ...s, drafts: { a: "typing" } }, { kind: "team", teamId: "team" })).toBe(first);
});

test("incremental filtering equals a fresh search through extension, backspace and query changes", () => {
  const items = [
    { id: "a", type: "task", label: "Desktop performance", shortId: "ct-1" },
    { id: "b", type: "session", label: "Desktop profiling", worker: true },
    { id: "c", type: "session", label: "Performance on desktop", contextAt: 1 },
    { id: "d", type: "task", label: "Done", status: "done", shortId: "ct-2" },
    { id: "e", type: "person", label: "Dee", handle: "dee" },
  ];
  for (const chat of [false, true]) {
    for (const q of ["", "d", "de", "des", "desktop", "desktop ", "desktop p", "desktop pe", "de", "ct-", "ct-2", "missing", "", "performance desktop"]) {
      expect(filterMentionItems(items, q, chat)).toEqual(items.filter(item => (!chat || chatMentionOffers(item, q)) && mentionItemMatches(item, q)));
    }
  }
  expect(filterMentionItems([...items, { id: "f", type: "task", label: "Desktop added" }], "desktop").some(x => x.id === "f")).toBe(true);
});

test("refreshes candidates on edits, scope switches and visit changes", () => {
  const s = state();
  const scope = { kind: "team" as const, teamId: "team" };
  const first = buildMentionItems(s, scope);
  const edited = buildMentionItems({ ...s, tasks: { a: { ...s.tasks.a, title: "Edited" } } }, scope);
  expect(edited.find((item) => item.id === "a")?.label).toBe("Edited");
  expect(buildMentionItems(s, { kind: "team", teamId: "other" }).some((item) => item.id === "a")).toBe(false);
  const visited = buildMentionItems({ ...s, recentVisits: [{ kind: "page", key: "page:/tasks/a", path: "/tasks/a", ts: 100 }] }, scope);
  expect(visited.find((item) => item.id === "a")?.viewedAt).toBe(100);
  expect(first.find((item) => item.id === "a")?.label).toBe("Original");
});
