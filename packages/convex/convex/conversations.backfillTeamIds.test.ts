import { describe, expect, test } from "bun:test";
import { backfillTeamIds, backfillUserTeamIds } from "./conversations";
import { sweepPage } from "./teamScopeSweep";
import { canAccessTask } from "./lib/access";
import { makeFakeDb } from "./testDb";

// Regression for ct-49655. Both team_id backfills used to `ctx.db.patch` a
// conversation directly. team_id is ROUTING, but on a conversation it is also
// the input to `teamVisibleConvTeam`, which decides the stored `workspace`
// ACCESS key of every task, doc and plan linked to it. So a raw patch made a
// personal session team-visible while its work items kept `user:<owner>` — the
// team could read the session and none of its work. Both now go through
// patchConversationVisibility, the chokepoint that patches the row and
// rewrites the linked keys in one call.
//
// The second half of the rule is just as load-bearing: a PRIVATE conversation
// gets the routing stamp and its work items stay personal. "Routed to team T,
// readable only by its owner" is the product requirement the split exists for.

const OWNER = "u_owner";
const MATE = "u_mate";
const TEAM = "t_team";

function fixture() {
  return makeFakeDb({
    users: [{ _id: OWNER, active_team_id: TEAM }, { _id: MATE, active_team_id: TEAM }],
    teams: [{ _id: TEAM }],
    team_memberships: [
      { _id: "m1", user_id: OWNER, team_id: TEAM, role: "member", visibility: "full" },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "member", visibility: "full" },
    ],
    conversations: [
      { _id: "c_shared", user_id: OWNER, is_private: false },
      { _id: "c_private", user_id: OWNER, is_private: true },
    ],
    tasks: [
      { _id: "task_shared", user_id: OWNER, created_from_conversation: "c_shared", workspace: `user:${OWNER}` },
      { _id: "task_private", user_id: OWNER, created_from_conversation: "c_private", workspace: `user:${OWNER}` },
    ],
    docs: [{ _id: "doc_shared", user_id: OWNER, conversation_id: "c_shared", workspace: `user:${OWNER}` }],
    plans: [{ _id: "plan_shared", user_id: OWNER, created_from_conversation_id: "c_shared", workspace: `user:${OWNER}` }],
    projects: [],
  });
}

const run = (fn: any, ctx: any, args: any) => ((fn as any)._handler ?? (fn as any).handler)(ctx, args);

/** Every disagreement the reconciler finds across the key-carrying tables. */
async function sweepDisagreements(ctx: any) {
  const findings: any[] = [];
  let stale = 0;
  let missing = 0;
  for (const table of ["tasks", "plans", "docs", "projects"]) {
    const page = await run(sweepPage, ctx, { table });
    findings.push(...page.findings);
    stale += page.stale;
    missing += page.missing;
  }
  return { findings, stale, missing };
}

describe("conversation team_id backfills propagate the workspace access key", () => {
  test("backfillTeamIds: linked work items move to the team key, the private session's stay personal", async () => {
    const db = fixture();
    const ctx = { db } as any;

    const result = await run(backfillTeamIds, ctx, {});

    expect(result.updated).toBe(2);
    // task_shared + doc_shared + plan_shared; the private session's task is
    // already on the key its conversation implies, so nothing to rewrite.
    expect(result.rescoped).toBe(3);

    const byId = (table: string, id: string) => db._tables[table].find((r: any) => r._id === id);
    expect(byId("conversations", "c_shared").team_id).toBe(TEAM);
    expect(byId("conversations", "c_private").team_id).toBe(TEAM);
    expect(byId("tasks", "task_shared").workspace).toBe(`team:${TEAM}`);
    expect(byId("docs", "doc_shared").workspace).toBe(`team:${TEAM}`);
    expect(byId("plans", "plan_shared").workspace).toBe(`team:${TEAM}`);
    expect(byId("tasks", "task_private").workspace).toBe(`user:${OWNER}`);

    // The point of the key: a teammate can now read the shared session's work
    // and still cannot read the private session's.
    expect(await canAccessTask(ctx, MATE as any, byId("tasks", "task_shared"))).toBe(true);
    expect(await canAccessTask(ctx, MATE as any, byId("tasks", "task_private"))).toBe(false);

    expect(await sweepDisagreements(ctx)).toEqual({ findings: [], stale: 0, missing: 0 });
  });

  test("backfillUserTeamIds: same propagation, and the reconciler reports nothing", async () => {
    const db = fixture();
    const ctx = { db } as any;

    const result = await run(backfillUserTeamIds, ctx, { userId: OWNER, teamId: TEAM });

    expect(result).toEqual({ updated: 2, alreadyHad: 0, rescoped: 3 });

    const byId = (table: string, id: string) => db._tables[table].find((r: any) => r._id === id);
    expect(byId("tasks", "task_shared").workspace).toBe(`team:${TEAM}`);
    expect(byId("docs", "doc_shared").workspace).toBe(`team:${TEAM}`);
    expect(byId("plans", "plan_shared").workspace).toBe(`team:${TEAM}`);
    expect(byId("tasks", "task_private").workspace).toBe(`user:${OWNER}`);

    expect(await sweepDisagreements(ctx)).toEqual({ findings: [], stale: 0, missing: 0 });
  });

  test("a conversation that already carries a team is left alone", async () => {
    const db = fixture();
    db._tables.conversations.push({ _id: "c_other", user_id: OWNER, team_id: TEAM, is_private: false });
    const ctx = { db } as any;

    const result = await run(backfillUserTeamIds, ctx, { userId: OWNER, teamId: TEAM });

    expect(result.alreadyHad).toBe(1);
    expect(db._patched.some((p: any) => p._id === "c_other")).toBe(false);
  });
});
