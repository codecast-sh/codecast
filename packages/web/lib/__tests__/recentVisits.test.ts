import { describe, expect, it } from "bun:test";
import { resolveRecentVisits } from "../recentVisits";

// The recents list is one list behind three surfaces (header menu, Ctrl+Tab
// switcher, palette). Each row resolves the live object behind the visit so
// the row can say what kind of thing it is and what state it is in.

const ME = "user_me";
const base = {
  currentUser: { _id: ME },
  clientState: { ui: { inbox_scope: "mine" } },
  teamInboxIds: new Set<string>(),
  currentSessionId: null,
  teamMembers: [],
  bucketAssignments: {},
  sessions: {},
  conversations: {},
  buckets: {},
  tasks: {},
  plans: {},
  docs: {},
  chatChannels: {},
  recentVisits: [] as any[],
};

describe("resolveRecentVisits", () => {
  it("resolves every kind to its object type with the live row attached", () => {
    const state = {
      ...base,
      sessions: { s1: { _id: "s1", title: "Fix auth", message_count: 3, git_root: "/x/codecast", user_id: ME } },
      tasks: { t1: { _id: "t1", short_id: "ct-1", title: "Ship it", status: "in_progress", priority: "high" } },
      plans: { p1: { _id: "p1", short_id: "pl-1", title: "Big plan", status: "active", progress: { total: 4, done: 1, in_progress: 1, open: 2 } } },
      docs: { d1: { _id: "d1", title: "Spec doc", doc_type: "spec" } },
      chatChannels: { c1: { _id: "c1", name: "design", kind: "public" } },
      buckets: { b1: { _id: "b1", name: "api" } },
      bucketAssignments: { a1: { _id: "a1", conversation_id: "s1", bucket_id: "b1", created_at: 1 } },
      recentVisits: [
        { kind: "session", key: "s1", ts: 9 },
        { kind: "page", key: "page:/tasks/ct-1", path: "/tasks/ct-1", ts: 8 },
        { kind: "page", key: "page:/plans/pl-1", path: "/plans/pl-1", ts: 7 },
        { kind: "page", key: "page:/docs/d1", path: "/docs/d1", ts: 6 },
        { kind: "page", key: "page:/chat/c1", path: "/chat/c1", ts: 5 },
        { kind: "view", key: "label:b1", ts: 4 },
        { kind: "view", key: "project:codecast", label: "codecast", path: "/x/codecast", ts: 3 },
        { kind: "page", key: "page:/inbox", path: "/inbox", label: "Inbox", ts: 2 },
      ],
    };
    const rows = resolveRecentVisits(state, 20);
    expect(rows.map((r) => [r.objectType, r.title])).toEqual([
      ["session", "Fix auth"],
      ["task", "Ship it"],
      ["plan", "Big plan"],
      ["doc", "Spec doc"],
      ["channel", "design"],
      ["label", "api"],
      ["project", "codecast"],
      ["page", "Inbox"],
    ]);
    expect(rows[1].entity.short_id).toBe("ct-1");
    expect(rows[2].entity.progress.total).toBe(4);
    expect(rows[3].entity.doc_type).toBe("spec");
    expect(rows[4].entity.kind).toBe("public");
    expect(rows[5].sessionCount).toBe(1);
    expect(rows[6].sessionCount).toBe(1);
    expect(rows[6].projectPath).toBe("/x/codecast");
  });

  it("keeps the object type when the row has left the store, falling back to the label", () => {
    const state = {
      ...base,
      recentVisits: [{ kind: "page", key: "page:/tasks/ct-9", path: "/tasks/ct-9", label: "Old task", ts: 1 }],
    };
    const [row] = resolveRecentVisits(state, 10);
    expect(row.objectType).toBe("task");
    expect(row.entity).toBeUndefined();
    expect(row.title).toBe("Old task");
  });

  it("drops a session the inbox scope hides, keeps one only the conversation cache knows", () => {
    const state = {
      ...base,
      clientState: { ui: { inbox_scope: "team" } },
      teamInboxIds: new Set(["k7abcdefghijklmnopqrstuvwxyz0123"]),
      sessions: {
        k7abcdefghijklmnopqrstuvwxyz0123: { _id: "k7abcdefghijklmnopqrstuvwxyz0123", title: "Mine", message_count: 1 },
        k7zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz: { _id: "k7zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", title: "Other team", message_count: 1 },
      },
      conversations: { convOnly: { _id: "convOnly", title: "From search", message_count: 2 } },
      recentVisits: [
        { kind: "session", key: "k7zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", ts: 3 },
        { kind: "session", key: "k7abcdefghijklmnopqrstuvwxyz0123", ts: 2 },
        { kind: "session", key: "convOnly", ts: 1 },
      ],
    };
    expect(resolveRecentVisits(state, 10).map((r) => r.title)).toEqual(["Mine", "From search"]);
  });
});
