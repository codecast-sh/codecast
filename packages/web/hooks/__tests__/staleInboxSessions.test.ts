import { describe, expect, it } from "bun:test";
import { blockedInboxSessions, staleInboxSessions } from "../useCardSubagents";
import type { InboxSession } from "../../store/inboxStore";

// The rail's stale sweep counts and dismisses inbox rows. Under the owners
// model the store also holds the children a listed session owns (the inbox
// read sends them with the parent), which are in nobody's inbox.

const ME = "users_me";
const NOW = Date.now();
const CUTOFF = NOW - 30 * 24 * 3600_000;
const OLD = CUTOFF - 3600_000;
const LEAD = "l1234567890123456789012345678901";
const OWNED = "c1234567890123456789012345678901";
const MINE = "m1234567890123456789012345678901";
const LEGACY = "s1234567890123456789012345678901";

const row = (id: string, over: Partial<InboxSession> = {}): InboxSession =>
  ({ _id: id, session_id: `sess-${id}`, user_id: ME, agent_type: "claude_code", message_count: 3, updated_at: OLD, title: id, ...(over as any) }) as InboxSession;

describe("staleInboxSessions", () => {
  const sessions = Object.fromEntries([
    row(LEAD, { owners_model: true, owned_by_me: true }),
    // Owned by its lead: rides the lead's card, in no inbox.
    row(OWNED, { owners_model: true, owned_by_me: false, owner_session_id: LEAD, parent_conversation_id: LEAD, is_subagent: true } as any),
    // A child the viewer owns stands as its own inbox row.
    row(MINE, { owners_model: true, owned_by_me: true, owner_session_id: LEAD, parent_conversation_id: LEAD, is_subagent: true } as any),
    // Off the owners model a nested subagent still counts: dismissing its
    // parent promotes it to top level.
    row(LEGACY, { parent_conversation_id: LEAD, is_subagent: true } as any),
  ].map((s) => [s._id, s]));

  it("skips a child its session owns, counting only inbox rows", () => {
    const ids = staleInboxSessions(sessions, null, CUTOFF, ME).map((s) => s._id);
    expect(ids).not.toContain(OWNED);
    expect(ids.sort()).toEqual([LEAD, MINE, LEGACY].sort());
  });

  it("keeps the open, pinned, recent and unstamped rows out", () => {
    const more = {
      ...sessions,
      p: row("p", { is_pinned: true }),
      r: row("r", { updated_at: NOW }),
      u: row("u", { updated_at: undefined }),
    };
    const ids = staleInboxSessions(more, LEAD, CUTOFF, ME).map((s) => s._id);
    expect(ids.sort()).toEqual([MINE, LEGACY].sort());
  });

  // Its wait reached the viewer (wait_up_person, no message since): it is in
  // their Needs You, so the sweep counts it like any of their rows. A role's
  // child is not on its old parent's card either: the card's rule is the
  // server's (shared ridesParentCard).
  it("counts a child whose wait reached the viewer, and one a role took", () => {
    const more = {
      ...sessions,
      esc: row("esc", { owners_model: true, owned_by_me: false, owner_session_id: LEAD, parent_conversation_id: LEAD, is_subagent: true, wait_up_person: ME, wait_up_count: 3, wait_up_at: OLD } as any),
      roled: row("roled", { owners_model: true, owned_by_me: false, owner_session_id: LEAD, parent_conversation_id: LEAD, org_role_id: "r_1" } as any),
    };
    const ids = staleInboxSessions(more, null, CUTOFF, ME).map((s) => s._id);
    expect(ids).toEqual(expect.arrayContaining(["esc", "roled"]));
    expect(ids).not.toContain(OWNED);
  });
});

// The blocked pill and the fleet revive banner count only inbox rows: a child
// its session owns rides its owner's card and is in nobody's inbox.
describe("blockedInboxSessions", () => {
  const blocked = { pending_api_error: true, pending_api_error_kind: "limit", pending_api_error_at: NOW - 60_000, updated_at: NOW - 60_000 } as Partial<InboxSession>;
  const sessions = Object.fromEntries([
    row(LEAD, { owners_model: true, owned_by_me: true, ...blocked } as any),
    row(OWNED, { owners_model: true, owned_by_me: false, owner_session_id: LEAD, parent_conversation_id: LEAD, is_subagent: true, ...blocked } as any),
    row(MINE, { owners_model: true, owned_by_me: true, owner_session_id: LEAD, parent_conversation_id: LEAD, is_subagent: true, ...blocked } as any),
    row(LEGACY, { parent_conversation_id: LEAD, is_subagent: true, ...blocked } as any),
  ].map((s) => [s._id, s]));

  it("skips a child its session owns", () => {
    const ids = blockedInboxSessions(sessions, undefined, NOW, ME).map((s) => s._id);
    expect(ids.sort()).toEqual([LEAD, MINE, LEGACY].sort());
  });

  it("drops a row just told to revive, a stale block and a row with no block", () => {
    const more = {
      ...sessions,
      old: row("old", { ...blocked, pending_api_error_at: NOW - 30 * 24 * 3600_000, updated_at: NOW - 30 * 24 * 3600_000 } as any),
      fine: row("fine", { updated_at: NOW }),
    };
    const ids = blockedInboxSessions(more, { [LEGACY]: NOW - 1000 }, NOW, ME).map((s) => s._id);
    expect(ids.sort()).toEqual([LEAD, MINE].sort());
  });

  it("counts a blocked child whose wait reached the viewer: it is in their inbox", () => {
    const more = { ...sessions, esc: row("esc", { owners_model: true, owned_by_me: false, owner_session_id: LEAD, parent_conversation_id: LEAD, is_subagent: true, wait_up_person: ME, wait_up_count: 3, ...blocked } as any) };
    expect(blockedInboxSessions(more, undefined, NOW, ME).map((s) => s._id)).toContain("esc");
  });
});
