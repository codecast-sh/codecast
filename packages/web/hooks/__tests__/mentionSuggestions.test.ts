import { describe, expect, test } from "bun:test";
import { buildMentionItems, mentionItemMatches } from "../useMentionQuery";
import { mergeMentionSuggestions, mentionViewTimes } from "../../lib/mentionRanking";
import type { MentionItem } from "../../components/editor/MentionList";
import { useInboxStore } from "../../store/inboxStore";

const item = (id: string, type = "session", updatedAt = 0): MentionItem => ({ id, type, label: `Mention ${id}`, updatedAt });

describe("mention suggestions", () => {
  test("viewed order wins across types, then update order fills in unvisited items", () => {
    const times = mentionViewTimes({
      _lastViewedAt: { older: 100, recent: 300 },
      recentVisits: [
        { kind: "session", key: "recent", ts: 200 },
        { kind: "page", key: "page:/tasks/ct-1?panel=details", ts: 250 },
        { kind: "page", key: "page:/docs/doc1#section", ts: 150 },
        { kind: "view", key: "label:label1", ts: 50 },
      ],
    });
    const candidates = [item("unseen-new", "session", 900), item("unseen-old", "doc", 800),
      item("older", "session", 1000), { ...item("task1", "task"), shortId: "ct-1" },
      item("doc1", "doc"), item("recent"), item("label1", "label")];
    expect(mergeMentionSuggestions(candidates, [], times).map((m) => m.id))
      .toEqual(["recent", "task1", "doc1", "older", "label1", "unseen-new", "unseen-old"]);
  });

  test("merges and sorts server hits before applying per-type limits, keeping local edits", () => {
    const local = [item("old", "session", 1), { ...item("both", "session", 5), label: "Local title" }];
    const remote = [{ ...item("both", "session", 10), label: "Stale server title" }, item("recent", "session", 20), item("task", "task", 3)];
    const result = mergeMentionSuggestions(local, remote, new Map([["session:both", 100]]), 2);
    expect(result.map((m) => m.id)).toEqual(["both", "recent", "task"]);
    expect(result[0].label).toBe("Local title");
    expect(local.map((m) => m.id)).toEqual(["old", "both"]);
  });

  test("equal viewing times fall back to updates and missing timestamps keep stable order", () => {
    const times = new Map([["session:a", 10], ["session:b", 10]]);
    expect(mergeMentionSuggestions([item("a", "session", 1), item("b", "session", 2), item("c"), item("d")], [], times)
      .map((m) => m.id)).toEqual(["b", "a", "c", "d"]);
  });

  test("builds the same rich candidates from full store collections and windowed index", () => {
    const state = {
      ...useInboxStore.getState(),
      currentUser: { _id: "me" }, teamMembers: [], buckets: {}, bucketAssignments: {},
      mentionIndex: { tasks: { t1: { _id: "t1", title: "Stale task", team_id: "team", status: "open" } }, docs: {}, plans: {} },
      tasks: { t1: { _id: "t1", title: "Live task", workspace: "team:team", status: "done", priority: "high", updated_at: 100 } },
      docs: {
        d1: { _id: "d1", title: "Live doc", workspace: "team:team", doc_type: "spec", updated_at: 200 },
        secret: { _id: "secret", title: "Private", team_id: "team", workspace: "user:me" },
      },
      plans: { p1: { _id: "p1", title: "Plan", workspace: "team:team", status: "active", goal: "Launch release", updated_at: 300 } },
      sessions: {
        session1: { _id: "session1", title: "Session", team_id: "team", message_count: 8, agent_status: "working", agent_type: "codex", model: "gpt-6", updated_at: 400 },
        worker: { _id: "worker", title: "Worker", team_id: "team", is_subagent: true },
      },
      _lastViewedAt: { session1: 300 },
      recentVisits: [{ kind: "page", key: "page:/tasks/t1", ts: 500 }],
    } as unknown as ReturnType<typeof useInboxStore.getState>;
    const result = buildMentionItems(state, { kind: "team", teamId: "team" });
    expect(result.map((m) => m.id)).toEqual(["t1", "session1", "p1", "d1"]);
    expect(result[0]).toMatchObject({ label: "Live task", status: "done", priority: "high", updatedAt: 100, viewedAt: 500 });
    expect(result[1]).toMatchObject({ status: "working", agentType: "codex", model: "gpt-6", messageCount: 8 });
    expect(result[3].label).toBe("Live doc");
    expect(mentionItemMatches(result[2], "launch release")).toBe(true);
    expect(mentionItemMatches(result[1], "session")).toBe(true);
    expect(mentionItemMatches(result[1], "missing words")).toBe(false);
  });
});
