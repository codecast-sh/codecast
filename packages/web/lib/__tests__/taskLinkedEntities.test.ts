import { describe, expect, test } from "bun:test";
import {
  resolveTaskLinkedConversations,
  resolveTaskRelatedDocs,
  sortTaskLinkedConversations,
  taskLinkedConversationIds,
  taskSessionHref,
} from "../liveEntities";

// The task page must paint its linked sessions and related docs
// from the store on the first frame. The server join (linked_conversations /
// related_docs) is a snapshot that only the detail query carries; until it is
// cached the client derives the same rows from the sessions it already holds,
// the origin badges the list sync fetched, and the workspace doc list.

const ORIGIN = "conv000000000000000000000000000a";
const ADOPTED = "conv000000000000000000000000000b";

describe("taskLinkedConversationIds", () => {
  test("origin first, then conversation_ids, deduplicated", () => {
    expect(taskLinkedConversationIds({ created_from_conversation: ORIGIN, conversation_ids: [ADOPTED, ORIGIN] }))
      .toEqual([ORIGIN, ADOPTED]);
    expect(taskLinkedConversationIds({ conversation_ids: [ADOPTED] })).toEqual([ADOPTED]);
    expect(taskLinkedConversationIds(undefined)).toEqual([]);
  });
});

describe("resolveTaskLinkedConversations", () => {
  test("the cached detail snapshot wins when present", () => {
    const snapshot = [{ _id: ORIGIN, session_id: "s1", title: "from server", headline: "h" }];
    const out = resolveTaskLinkedConversations(
      { linked_conversations: snapshot, created_from_conversation: ORIGIN },
      { [ORIGIN]: { title: "from store" } },
      {},
    );
    expect(out).toBe(snapshot);
  });

  test("derives rows from store sessions and origin badges when no snapshot is cached", () => {
    const out = resolveTaskLinkedConversations(
      { created_from_conversation: ORIGIN, conversation_ids: [ORIGIN, ADOPTED] },
      { [ADOPTED]: { session_id: "s-adopted", title: "Adopted session", is_idle: false, updated_at: 20, message_count: 7, agent_type: "codex", project_path: "/p" } },
      { [ORIGIN]: { session_id: "s-origin", title: "Origin session", last_message_at: 10, message_count: 3, agent_type: "claude_code" } },
    );
    expect(out.map((c) => c._id)).toEqual([ORIGIN, ADOPTED]);
    // Origin known only through the list badge: dormant, badge fields.
    expect(out[0]).toMatchObject({ session_id: "s-origin", title: "Origin session", is_active: false, updated_at: 10, message_count: 3, agent_type: "claude_code" });
    // Adopted session is a live store row: liveness from is_idle.
    expect(out[1]).toMatchObject({ session_id: "s-adopted", title: "Adopted session", is_active: true, updated_at: 20, message_count: 7, project_path: "/p" });
  });

  test("ids the client knows nothing about are skipped rather than rendered blank", () => {
    expect(resolveTaskLinkedConversations({ conversation_ids: [ORIGIN] }, {}, {})).toEqual([]);
  });
});

describe("taskSessionHref", () => {
  test("uses the Convex conversation id, never the daemon session_id", () => {
    expect(taskSessionHref({ _id: ORIGIN, session_id: "sess-daemon-handle" } as any)).toBe(`/conversation/${ORIGIN}`);
    expect(taskSessionHref({ session_id: "sess-daemon-handle" } as any)).toBeNull();
    expect(taskSessionHref(null)).toBeNull();
  });
});

describe("sortTaskLinkedConversations", () => {
  test("origin first, then live, then recency", () => {
    const rows = [
      { _id: "c", is_active: false, updated_at: 30 },
      { _id: ORIGIN, is_active: false, updated_at: 1 },
      { _id: ADOPTED, is_active: true, updated_at: 10 },
    ];
    expect(sortTaskLinkedConversations(rows, ORIGIN).map((r) => r._id)).toEqual([ORIGIN, ADOPTED, "c"]);
    expect(sortTaskLinkedConversations(rows).map((r) => r._id)).toEqual([ADOPTED, "c", ORIGIN]);
  });
});

describe("resolveTaskRelatedDocs", () => {
  const HOUR = 60 * 60 * 1000;
  const docs = {
    d1: { _id: "d1", conversation_id: ORIGIN, title: "Plan", display_title: "The plan", doc_type: "plan", source: "agent", created_at: 2 },
    d2: { _id: "d2", conversation_id: ORIGIN, title: "Older", doc_type: "note", created_at: 1 },
    d3: { _id: "d3", conversation_id: ORIGIN, title: "Archived", archived_at: 5, created_at: 3 },
    d4: { _id: "d4", conversation_id: ADOPTED, title: "Other session", created_at: 4 },
    d5: { _id: "d5", conversation_id: ORIGIN, title: "Months earlier", doc_type: "note", created_at: -40 * 24 * HOUR },
  };

  test("snapshot wins; else the origin conversation's live docs, oldest first, archived excluded", () => {
    const snapshot = [{ _id: "x", title: "server" }];
    expect(resolveTaskRelatedDocs({ related_docs: snapshot, created_from_conversation: ORIGIN }, docs)).toBe(snapshot);
    const out = resolveTaskRelatedDocs({ created_from_conversation: ORIGIN, created_at: 3 }, docs);
    expect(out.map((d) => d._id)).toEqual(["d2", "d1"]);
    expect(out[1]).toMatchObject({ title: "The plan", doc_type: "plan", source: "agent" });
    expect(resolveTaskRelatedDocs({ created_from_conversation: null }, docs)).toEqual([]);
  });

  test("a long-lived origin session's older journal stays out", () => {
    const out = resolveTaskRelatedDocs({ created_from_conversation: ORIGIN, created_at: 3 }, docs);
    expect(out.map((d) => d._id)).not.toContain("d5");
  });
});
