import { describe, expect, it } from "bun:test";
import type { InboxSession } from "../inboxStore";
import { placeSections } from "./placeTestHarness";

// Under the owners model a subagent belongs to the session that started it, so
// it is in nobody's inbox; the server still sends it under that session, and
// the placement nests it under the session's card for display only.

const ME = "users_me";
const T0 = Date.now();
const PARENT = "p1234567890123456789012345678901";
const CHILD = "c1234567890123456789012345678901";
const ORPHAN = "o1234567890123456789012345678901";

const row = (id: string, over: Partial<InboxSession> = {}): InboxSession => ({
  _id: id,
  session_id: `sess-${id}`,
  user_id: ME,
  agent_type: "claude_code",
  agent_status: "idle",
  is_idle: true,
  has_pending: false,
  message_count: 3,
  updated_at: T0 - 60_000,
  agent_status_updated_at: T0 - 60_000,
  last_role_is_user: false,
  title: id,
  ...(over as any),
});
const owned = (id: string, owner: string, over: Partial<InboxSession> = {}) =>
  row(id, { owners_model: true, owned_by_me: false, owner_session_id: owner, parent_conversation_id: owner, is_subagent: true, ...(over as any) });
const place = (rows: InboxSession[]) =>
  placeSections(Object.fromEntries(rows.map((s) => [s._id, s])), new Set(), undefined, { currentUser: { _id: ME } });
const sectioned = (p: ReturnType<typeof place>) =>
  [...p.questions, ...p.needsInput, ...p.working, ...p.done, ...p.dormant, ...p.pinned, ...p.newSessions].map((s) => s._id);

describe("a subagent its session owns rides that session's card", () => {
  it("nests under the parent's card and takes no section of its own", () => {
    const p = place([row(PARENT, { owners_model: true, owned_by_me: true }), owned(CHILD, PARENT)]);
    expect((p.subsByParent.get(PARENT) ?? []).map((s) => s._id)).toEqual([CHILD]);
    expect(sectioned(p)).toContain(PARENT);
    expect(sectioned(p)).not.toContain(CHILD);
  });

  it("is not drawn when its parent is not in the viewer's inbox", () => {
    const p = place([row(PARENT, { owners_model: true, owned_by_me: false }), owned(CHILD, PARENT)]);
    expect([...p.subsByParent.values()].flat().map((s) => s._id)).not.toContain(CHILD);
    expect(sectioned(p)).toEqual([]);
  });

  it("a closed or killed child is not drawn", () => {
    const p = place([
      row(PARENT, { owners_model: true, owned_by_me: true }),
      owned(CHILD, PARENT, { inbox_killed_at: T0 - 1000 } as any),
      owned(ORPHAN, PARENT, { inbox_dismissed_at: T0 - 1000, inbox_closed_at: T0 - 1000 } as any),
    ]);
    expect(p.subsByParent.get(PARENT) ?? []).toEqual([]);
  });
});
