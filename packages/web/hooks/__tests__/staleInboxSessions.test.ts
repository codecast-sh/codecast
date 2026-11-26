import { describe, expect, it } from "bun:test";
import { staleInboxSessions } from "../useCardSubagents";
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
    const ids = staleInboxSessions(sessions, null, CUTOFF).map((s) => s._id);
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
    const ids = staleInboxSessions(more, LEAD, CUTOFF).map((s) => s._id);
    expect(ids.sort()).toEqual([MINE, LEGACY].sort());
  });
});
