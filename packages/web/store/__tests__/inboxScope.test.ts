import { describe, expect, it } from "bun:test";
import { filterInboxScope, type InboxSession } from "../inboxStore";

// filterInboxScope is the gate that keeps the two inbox scopes coherent even
// though both read the SAME never-prune sessions cache:
//   • "mine" must never show a teammate's row (team mode leaves them in the
//     cache, and dismiss/stash/pin/kill mutate GLOBAL conversation fields — a
//     teammate row loose in your personal inbox is how you'd hide their session
//     from them by accident).
//   • "team" must show exactly the rows the team subscription reported.
// Convex ids are 32 lowercase alphanumerics; anything else is an optimistic stub.
const ME = "u1000000000000000000000000000001";
const THEM = "u2000000000000000000000000000002";

const cid = (n: number) => `c${String(n).padStart(31, "0")}`;

const mk = (id: string, extra: Partial<InboxSession> = {}): InboxSession => ({
  _id: id,
  session_id: `s-${id}`,
  updated_at: 1,
  agent_type: "claude_code",
  message_count: 2,
  is_idle: true,
  has_pending: false,
  last_user_message: "hi",
  title: id,
  ...extra,
});

const byId = (rows: InboxSession[]) =>
  Object.fromEntries(rows.map((r) => [r._id, r])) as Record<string, InboxSession>;

const ids = (r: Record<string, InboxSession>) => Object.keys(r).sort();

describe("filterInboxScope — mine", () => {
  it("drops a teammate's row and keeps my own", () => {
    const mine = mk(cid(1), { user_id: ME });
    const theirs = mk(cid(2), { user_id: THEM });
    const out = filterInboxScope(byId([mine, theirs]), "mine", ME);
    expect(ids(out)).toEqual([cid(1)]);
  });

  it("keeps a foreign-run session that is routed to me to steer (owner)", () => {
    // A Mr-Bot-style session: run by another account, assigned to me. It belongs
    // in my inbox and IS mine to triage.
    const owned = mk(cid(3), { user_id: THEM, owner_user_id: ME, owned_by_me: true });
    const out = filterInboxScope(byId([owned]), "mine", ME);
    expect(ids(out)).toEqual([cid(3)]);
  });

  it("keeps optimistic stubs and thin rows with no known author", () => {
    const stub = mk("stub-local-1"); // non-Convex id → mid-create, always mine
    const thin = mk(cid(4)); // no user_id → legacy/thin row, don't hide
    const out = filterInboxScope(byId([stub, thin]), "mine", ME);
    expect(ids(out)).toEqual([cid(4), "stub-local-1"].sort());
  });

  it("keeps the focused row even when it's a teammate's (deep-linked, open)", () => {
    const theirs = mk(cid(5), { user_id: THEM });
    const out = filterInboxScope(byId([theirs]), "mine", ME, undefined, cid(5));
    expect(ids(out)).toEqual([cid(5)]);
  });

  it("returns the SAME object ref when there is nothing to drop (memo stability)", () => {
    const input = byId([mk(cid(6), { user_id: ME })]);
    expect(filterInboxScope(input, "mine", ME)).toBe(input);
  });

  it("hides nothing when the viewer is unknown", () => {
    const theirs = mk(cid(7), { user_id: THEM });
    const input = byId([theirs]);
    expect(filterInboxScope(input, "mine", null)).toBe(input);
  });
});

describe("filterInboxScope — team", () => {
  it("shows exactly the rows the team subscription reported", () => {
    const mine = mk(cid(1), { user_id: ME });
    const theirs = mk(cid(2), { user_id: THEM });
    const staleForeign = mk(cid(3), { user_id: THEM }); // cached, not in the team set
    const teamIds = new Set([cid(1), cid(2)]);
    const out = filterInboxScope(byId([mine, theirs, staleForeign]), "team", ME, teamIds);
    expect(ids(out)).toEqual([cid(1), cid(2)]);
  });

  it("keeps the open session and optimistic stubs alongside the team set", () => {
    const stub = mk("stub-local-2");
    const open = mk(cid(8), { user_id: THEM });
    const teamRow = mk(cid(9), { user_id: THEM });
    const out = filterInboxScope(
      byId([stub, open, teamRow]),
      "team",
      ME,
      new Set([cid(9)]),
      cid(8),
    );
    expect(ids(out)).toEqual([cid(8), cid(9), "stub-local-2"].sort());
  });

  it("falls back to the mine filter before the first team payload lands", () => {
    // Empty team set = still loading. Show my own work immediately rather than
    // flashing an empty board.
    const mine = mk(cid(1), { user_id: ME });
    const theirs = mk(cid(2), { user_id: THEM });
    const out = filterInboxScope(byId([mine, theirs]), "team", ME, new Set());
    expect(ids(out)).toEqual([cid(1)]);
  });
});
