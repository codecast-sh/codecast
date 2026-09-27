import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { applyScope, takeOverSessions } from "./orgInit";
import { performCreateRole, performRetireRole } from "./orgRoles";
import { performEscalateSession } from "./sessionOwnership";

// REVIEW (W7, org-roles-run-work.md R1). Left untracked by the adversarial
// reviewer. Each test states the behaviour the contract asks for and fails on
// the tree as reviewed. Nothing here is a fix.

const ME = "u".repeat(31) + "m"; // team admin, the host
const MATE = "u".repeat(31) + "t";
const TEAM = "teams_acme" as any;
const WS = `team:${TEAM}`;
const NOW = Date.now();
const P = "projects_p";

const conv = (n: number, over: Record<string, any> = {}) => ({
  _id: `conversations_s${n}`,
  short_id: `jx7000${n}`,
  user_id: ME,
  team_id: TEAM,
  status: "active",
  agent_type: "claude_code",
  title: `Growth work ${n}`,
  project_path: "/repo/growth",
  message_count: 3,
  last_message_role: "assistant",
  updated_at: NOW - 60_000,
  created_at: 1,
  ...over,
});

function fixtures(conversations: any[]) {
  return makeFakeDb({
    users: [{ _id: ME, name: "Me", email: "me@x.ai" }, { _id: MATE, name: "Mate", email: "mate@x.ai" }],
    team_memberships: [
      { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "member", joined_at: 1 },
    ],
    teams: [{ _id: TEAM, name: "Acme" }],
    counters: [],
    org_roles: [],
    org_role_history: [],
    anchors: [],
    projects: [
      { _id: P, user_id: ME, team_id: TEAM, workspace: WS, short_id: "pr-1", title: "Growth", status: "active", project_path: "/repo/growth", created_at: 1, updated_at: NOW },
      { _id: "projects_q", user_id: ME, team_id: TEAM, workspace: WS, short_id: "pr-2", title: "Billing", status: "active", project_path: "/repo/billing", created_at: 1, updated_at: NOW },
    ],
    plans: [],
    tasks: [],
    docs: [],
    conversations,
    session_owners: [],
    session_decisions: [],
    managed_sessions: [],
    messages: [],
    user_presence: [],
    pending_messages: [],
    devices: [],
  });
}

const ctxOf = (db: any) => ({ db }) as any;
const row = (db: any, n: number) => db._tables.conversations.find((c: any) => c._id === `conversations_s${n}`);

describe("review: the takeover moves a session it should not", () => {
  test("the host's PRIVATE session on the project path is not filed under a team role", async () => {
    // A private session keeps team_id (routing) and is_private (access). The
    // org scan admits the caller's own private rows, and the eligibility
    // filter in performRehomeSessions reads team_id only, so the row moves.
    // From then on the team role's wake frame ("Your sessions") prints its
    // title and pinned state into the role's standing session, which the team
    // can read, and the role agent is told to act on it.
    const db = fixtures([conv(1), conv(2, { is_private: true, title: "Salary talk with my lawyer" })]);
    const ctx = ctxOf(db);
    const role = await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM, scope: { project_ids: [P as any], plan_ids: [] } });
    const took = await takeOverSessions(ctx, ME as any, role._id);
    expect(row(db, 1).org_role_id).toBe(role._id);
    expect(took?.sessions).not.toContain("jx70002");
    expect(row(db, 2).org_role_id).toBeUndefined();
  });
});

describe("review: an escalation a person cannot clear", () => {
  test("retiring the role drops the escalation with the pointer, as a reparent to a person does", async () => {
    const db = fixtures([conv(1)]);
    const ctx = ctxOf(db);
    const role = await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM });
    await applyScope(ctx, ME as any, { team_id: TEAM }, { kind: "scope", handle: "@growth", add: ["pr-1"] } as any, { provision: false, human_decision: "sd-1" });
    expect(row(db, 1).org_role_id).toBe(role._id);
    await performEscalateSession(ctx, ME as any, { session_id: "jx70001", line: "needs your eye" });
    await performRetireRole(ctx, ME as any, { role_id: String(role._id) });
    expect(row(db, 1).org_role_id).toBeUndefined();
    // inboxProjection classifies `escalated && hasMsgs` as needs_input, so the
    // card is pinned in needs input with a retired role's line on it...
    expect(row(db, 1).escalated_by_role).toBeUndefined();
  });

  test("...and the person's clear is refused, so nothing in the product removes it", async () => {
    const db = fixtures([conv(1)]);
    const ctx = ctxOf(db);
    const role = await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM });
    await applyScope(ctx, ME as any, { team_id: TEAM }, { kind: "scope", handle: "@growth", add: ["pr-1"] } as any, { provision: false, human_decision: "sd-1" });
    await performEscalateSession(ctx, ME as any, { session_id: "jx70001", line: "needs your eye" });
    await performRetireRole(ctx, ME as any, { role_id: String(role._id) });
    const cleared = await performEscalateSession(ctx, ME as any, { session_id: "jx70001", clear: true }).catch((e: any) => e);
    expect(cleared instanceof Error ? cleared.message : "ok").toBe("ok");
  });
});

describe("review: R2, a teammate's long running session named as a role", () => {
  test("a team admin can accept a role seated on a session a TEAMMATE runs", async () => {
    // R2's own example is a session somebody else has run for 34 days, and
    // applyRole reads the parent from the session's runner "not whoever
    // accepts". But requireAdoptable admits only an OWNER of the session, so
    // the founder accepting the analyzer's proposal always lands it as failed.
    // The existing test of this rule (orgProposals.test.ts "reports to the
    // person who runs the session") keeps user_id: ME on the session and only
    // flips owner_user_id, so the accepting person is still its runner.
    const { applyRole } = await import("./orgInit");
    const db: any = fixtures([conv(1, { user_id: MATE, title: "Market growth mandate", is_private: false })]);
    for (const t of ["bot_users", "daemon_commands"]) db._tables[t] ??= [];
    const res: any = await applyRole({ db } as any, ME as any, { team_id: TEAM }, { kind: "role", name: "Market growth", handle: "market-growth", seat: { existing: "jx70001" } } as any, undefined, { provision: false, human_decision: "sd-1" })
      .catch((e: any) => ({ status: "threw", error: e.message }));
    expect(res.error ?? "").toBe("");
    expect(res.status).toBe("applied");
  });
});


describe("takeover privacy boundaries", () => {
  test("a hidden membership prevents takeover even for the session runner", async () => {
    const db = fixtures([conv(1, { is_private: false })]);
    await db.patch("m1", { visibility: "hidden" });
    const role = await performCreateRole(ctxOf(db), ME as any, { name: "Growth", handle: "growth", team_id: TEAM, scope: { project_ids: [P as any], plan_ids: [] } });
    expect((await takeOverSessions(ctxOf(db), ME as any, role._id))?.sessions ?? []).toHaveLength(0);
    expect(row(db, 1).org_role_id).toBeUndefined();
  });
  test("a team admin cannot seat a teammate's private session", async () => {
    const { applyRole } = await import("./orgInit");
    const db = fixtures([conv(1, { user_id: MATE, is_private: true })]);
    await expect(applyRole(ctxOf(db), ME as any, { team_id: TEAM }, { kind: "role", name: "Growth", handle: "growth", seat: { existing: "jx70001" } }, undefined, { provision: false, human_decision: "sd-1" })).rejects.toThrow();
    expect(row(db, 1).standing_role_id).toBeUndefined();
  });
  test("a plain member cannot seat a teammate-owned session on another person's role", async () => {
    const { performProvisionRole } = await import("./orgRoles");
    const db = fixtures([conv(1, { is_private: false })]);
    const role = await performCreateRole(ctxOf(db), ME as any, { name: "Growth", handle: "growth", team_id: TEAM });
    await expect(performProvisionRole(ctxOf(db), MATE as any, { role_id: role._id, adopt_conversation_id: "jx70001" })).rejects.toThrow("admin");
  });
});
