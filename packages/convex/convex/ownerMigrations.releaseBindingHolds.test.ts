import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { releaseBindingHoldsPage } from "./lib/roleStartedBackfill";

// ownerMigrations:releaseBindingHolds: a person's live session that a task
// binding filed under a role goes back to its starter before the owner model
// turns on; the role's own starts, deliberate filings and history stay.

const ME = "users_me";
const ROLE = "org_roles_growth";
const TEAM = "teams_union";

const conv = (id: string, over: Record<string, any> = {}) => ({
  _id: `conversations_${id}`, short_id: id, user_id: ME, status: "active", message_count: 3, updated_at: 1, org_role_id: ROLE, ...over,
});

function fixtures() {
  return makeFakeDb({
    org_roles: [{ _id: ROLE, team_id: TEAM, handle: "growth", name: "Growth lead", status: "active" }],
    conversations: [
      conv("person_bound", { org_role_hold: "bound" }),
      conv("person_filed", { org_role_hold: "filed" }),
      conv("hand_bound", { org_role_hold: "bound", role_started: true }),
      conv("standing", { org_role_hold: "bound", standing_role_id: ROLE }),
      conv("done_bound", { org_role_hold: "bound", status: "completed" }),
      conv("killed_bound", { org_role_hold: "bound", inbox_killed_at: 5 }),
    ],
  });
}

const row = (db: any, id: string) => db._tables.conversations.find((c: any) => c.short_id === id);

describe("releaseBindingHolds", () => {
  test("dry names only the live person session a binding filed, and writes nothing", async () => {
    const db = fixtures();
    const res = await releaseBindingHoldsPage({ db } as any, { team_id: TEAM });
    expect([res.sessions, res.next]).toEqual([["person_bound"], null]);
    expect(row(db, "person_bound").org_role_id).toBe(ROLE);
  });

  test("a real run takes the hold off; a rerun releases nothing", async () => {
    const db = fixtures();
    await releaseBindingHoldsPage({ db } as any, { team_id: TEAM, dryRun: false });
    expect([row(db, "person_bound").org_role_id, row(db, "person_bound").org_role_hold]).toEqual([undefined, undefined]);
    for (const id of ["person_filed", "hand_bound", "standing", "done_bound", "killed_bound"]) expect(row(db, id).org_role_id).toBe(ROLE);
    expect((await releaseBindingHoldsPage({ db } as any, { team_id: TEAM, dryRun: false })).released).toBe(0);
  });
});
