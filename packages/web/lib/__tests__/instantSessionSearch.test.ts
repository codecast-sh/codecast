import { describe, expect, test } from "bun:test";
import { instantSessionRows, mergeSearchRows, sessionMatchesQuery } from "../instantSessionSearch";

const session = (over: any) => ({
  _id: over._id,
  session_id: over._id,
  agent_type: "claude",
  message_count: 10,
  updated_at: 1000,
  ...over,
});

// filterInboxScopeFromState reads these; "mine" scope keeps the viewer's rows.
const stateWith = (rows: any[], meId = "u1") => ({
  sessions: Object.fromEntries(rows.map((r) => [r._id, r])),
  clientState: { ui: { inbox_scope: "mine" as const } },
  currentUser: { _id: meId },
  teamInboxIds: new Set<string>(),
  currentSessionId: null,
});

describe("sessionMatchesQuery", () => {
  test("summaries and project path are part of the haystack", () => {
    const s = session({ _id: "a", title: "Nightly sweep", idle_summary: "fixed the crosshatch", project_path: "/src/codecast" });
    expect(sessionMatchesQuery(s, "crosshatch")).toBe(true);
    expect(sessionMatchesQuery(s, "codecast")).toBe(true);
    expect(sessionMatchesQuery(s, "unrelated")).toBe(false);
  });
});

describe("instantSessionRows", () => {
  test("a title hit outranks a summary hit, recency breaks ties", () => {
    const rows = instantSessionRows(
      stateWith([
        session({ _id: "summary", title: "Inbox work", idle_summary: "sidebar tweaks", user_id: "u1", updated_at: 5000 }),
        session({ _id: "title", title: "Sidebar polish", user_id: "u1", updated_at: 1000 }),
      ]) as any,
      "sidebar",
    );
    expect(rows.map((r) => r.conversationId)).toEqual(["title", "summary"]);
  });

  test("a short query matches nothing, so no tier is drawn", () => {
    expect(instantSessionRows(stateWith([session({ _id: "a", title: "Sidebar", user_id: "u1" })]) as any, "s")).toEqual([]);
  });

  test("mineOnly drops sessions owned by someone else", () => {
    const rows = instantSessionRows(
      stateWith([
        session({ _id: "mine", title: "Sidebar polish", user_id: "u1" }),
        session({ _id: "theirs", title: "Sidebar rewrite", user_id: "u2" }),
      ]) as any,
      "sidebar",
      12,
      { mineOnly: true },
    );
    expect(rows.map((r) => r.conversationId)).toEqual(["mine"]);
  });

  test("the row carries a snippet from where the match landed", () => {
    const [row] = instantSessionRows(
      stateWith([session({ _id: "a", title: "Nightly sweep", idle_summary: "fixed the crosshatch weave", user_id: "u1" })]) as any,
      "crosshatch",
    );
    expect(row.instantSnippet).toBe("fixed the crosshatch weave");
    expect(row.instant).toBe(true);
    expect(row.matches).toEqual([]);
  });
});

describe("mergeSearchRows", () => {
  const contentRow = { conversationId: "a", title: "A", matches: [{ messageId: "m", content: "hit", role: "user", timestamp: 1 }], matchCount: 1, updatedAt: 2, authorName: "", isOwn: true, messageCount: 4 };
  const instantRow = { conversationId: "a", title: "A", matches: [], matchCount: 0, updatedAt: 2, authorName: "", isOwn: true, messageCount: 0, instant: true, instantSnippet: "summary line" };
  const otherInstant = { ...instantRow, conversationId: "b" };

  test("an earlier tier wins the row and keeps its message matches", () => {
    const merged = mergeSearchRows([contentRow], [instantRow, otherInstant]);
    expect(merged.map((r) => r.conversationId)).toEqual(["a", "b"]);
    expect(merged[0].matches).toHaveLength(1);
    expect(merged[0].instant).toBeUndefined();
  });

  test("the winner adopts what it lacks from the later tier", () => {
    const [merged] = mergeSearchRows([{ ...contentRow, messageCount: 0 }], [instantRow]);
    expect(merged.instantSnippet).toBe("summary line");
    expect(merged.messageCount).toBe(0);
  });

  test("an absent tier is skipped", () => {
    expect(mergeSearchRows(undefined, [instantRow]).map((r) => r.conversationId)).toEqual(["a"]);
  });
});
