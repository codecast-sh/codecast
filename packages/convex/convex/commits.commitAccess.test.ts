// A commit reaches the database by two different roads, and until this was
// fixed only one of them could be read back.
//
// The transcript path writes conversation_id, and the session decides who may
// read the commit. The git ingest path (a push webhook, or a backfill) has no
// session at all: it writes team_id, which the schema names as the access
// fallback. canAccessCommit used to require conversation_id outright, so every
// commit the new git ingest created was invisible to everyone and the commit
// page rendered empty for exactly those commits.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { canAccessCommit } from "./lib/access";

const MEMBER = "user_member" as any;
const OUTSIDER = "user_outsider" as any;
const TEAM = "team_1" as any;

function ctxWith(rows: Record<string, any[]> = {}) {
  return {
    db: makeFakeDb({
      team_memberships: [{ _id: "m1", user_id: MEMBER, team_id: TEAM }],
      conversations: [],
      ...rows,
    }),
  } as any;
}

describe("canAccessCommit", () => {
  test("a commit from the git ingest is readable by the installing team", async () => {
    const commit = { team_id: TEAM };
    expect(await canAccessCommit(ctxWith(), MEMBER, commit as any)).toBe(true);
  });

  test("a commit from the git ingest is not readable outside that team", async () => {
    const commit = { team_id: TEAM };
    expect(await canAccessCommit(ctxWith(), OUTSIDER, commit as any)).toBe(false);
  });

  test("a commit with a session is readable by that session's owner", async () => {
    const ctx = ctxWith({
      conversations: [{ _id: "c1", user_id: OUTSIDER, is_private: true }],
    });
    const commit = { conversation_id: "c1" as any };
    expect(await canAccessCommit(ctx, OUTSIDER, commit as any)).toBe(true);
  });

  test("a session the caller cannot read falls back to the team", async () => {
    const ctx = ctxWith({
      conversations: [{ _id: "c1", user_id: OUTSIDER, is_private: true }],
    });
    // The member does not own this private session, but the commit still names
    // their team, so the fallback is what lets them read it.
    expect(await canAccessCommit(ctx, MEMBER, { conversation_id: "c1", team_id: TEAM } as any)).toBe(true);
    // Without that team stamp the same commit stays private to its owner.
    expect(await canAccessCommit(ctx, MEMBER, { conversation_id: "c1" } as any)).toBe(false);
  });

  test("a commit with neither provenance is readable by nobody", async () => {
    expect(await canAccessCommit(ctxWith(), MEMBER, {} as any)).toBe(false);
  });
});
