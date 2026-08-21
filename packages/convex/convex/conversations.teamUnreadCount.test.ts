import { describe, expect, test } from "bun:test";
import { getTeamUnreadCount } from "./conversations";
import { makeFakeDb } from "./testDb";

// Regression for the sidebar Feed badge timing out with "too many system
// operations" and crashing the Sidebar (2026-08-24). The count used to scan the
// team's 100 newest-CREATED conversations (by_team_id, creation order) and
// filter in JS, so every live client re-read 100 docs (including the viewer's
// own) on every heartbeat, and the badge missed old sessions that had fresh
// activity. It now reads one bounded range per teammate on
// by_team_user_updated, bounded below by the viewer's read mark: rows older
// than the mark and the viewer's own rows are never read.
const TEAM = "teams_1" as any;
const VIEWER = "users_v" as any;
const MATE = "users_m" as any;
const HIDDEN = "users_h" as any;

function conv(id: string, user: any, updated_at: number, extra: any = {}) {
  return { _id: id, _creationTime: 1, user_id: user, team_id: TEAM, is_private: false, updated_at, ...extra };
}

function ctxFor(rows: any[], lastSeen?: number) {
  const db = makeFakeDb({
    users: [
      { _id: VIEWER, active_team_id: TEAM, team_conversations_last_seen: lastSeen },
      { _id: MATE },
      { _id: HIDDEN },
    ],
    team_memberships: [
      { _id: "tm_v", team_id: TEAM, user_id: VIEWER },
      { _id: "tm_m", team_id: TEAM, user_id: MATE, visibility: "summary" },
      { _id: "tm_h", team_id: TEAM, user_id: HIDDEN, visibility: "hidden" },
    ],
    conversations: rows,
  });
  // Record every conversations index read so a test can assert the read set,
  // not just the number: the fake db has no cost model, and the old
  // implementation (team-wide creation-order scan, filtered in JS) returns the
  // same counts.
  const reads: Array<{ index: string; eq: Record<string, any> }> = [];
  const rawQuery = db.query.bind(db);
  db.query = (table: string) => {
    const builder = rawQuery(table);
    if (table !== "conversations") return builder;
    const rawWithIndex = builder.withIndex.bind(builder);
    builder.withIndex = (name: string, fn?: (q: any) => any) => {
      const eq: Record<string, any> = {};
      return rawWithIndex(name, fn && ((q: any) => {
        const spy = new Proxy(q, {
          get: (t, k) => k === "eq"
            ? (f: string, v: any) => { eq[f] = v; t.eq(f, v); return spy; }
            : (...a: any[]) => { (t as any)[k](...a); return spy; },
        });
        reads.push({ index: name, eq });
        return fn(spy);
      }));
    };
    return builder;
  };
  return {
    db,
    reads,
    auth: { getUserIdentity: async () => ({ subject: `${VIEWER}|sess`, tokenIdentifier: "x" }) },
  };
}

const handler = (getTeamUnreadCount as any)._handler ?? (getTeamUnreadCount as any).handler;

describe("getTeamUnreadCount", () => {
  test("counts teammates' visible rows updated after the read mark, nothing else", async () => {
    const ctx = ctxFor([
      // Old session (low _creationTime irrelevant to the fake, but it sits
      // last in table order) with fresh activity: counts.
      conv("c_fresh", MATE, 600),
      // Updated before the mark: never read.
      conv("c_stale", MATE, 400),
      // Private to its owner: read but not visible.
      conv("c_private", MATE, 700, { is_private: true }),
      // Hidden member: skipped entirely.
      conv("c_hidden", HIDDEN, 700),
      // The viewer's own work never counts as unread.
      conv("c_own", VIEWER, 900),
    ], 500);
    expect(await handler(ctx, { teamId: TEAM })).toBe(1);
    // The read set: one bounded per-member range, never a team-wide scan, and
    // never the viewer's own rows (their heartbeats must not re-run the badge).
    expect(ctx.reads.map((r) => r.index)).toEqual(["by_team_user_updated"]);
    expect(ctx.reads.map((r) => r.eq.user_id)).toEqual([MATE]);
  });

  test("no read mark yet: every visible teammate row counts", async () => {
    const ctx = ctxFor([conv("c1", MATE, 10), conv("c2", MATE, 20), conv("c_own", VIEWER, 30)]);
    expect(await handler(ctx, {})).toBe(2);
  });

  test("falls back to the viewer's active team; no team means zero", async () => {
    const ctx = ctxFor([conv("c1", MATE, 10)]);
    expect(await handler(ctx, {})).toBe(1);
    (ctx.db as any)._tables.users[0].active_team_id = undefined;
    expect(await handler(ctx, {})).toBe(0);
  });
});
