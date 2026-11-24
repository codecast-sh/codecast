// A session is the role's own start (role_started) when the session that
// started it acts for the role (shared contracts/sessionOwners actsForRole):
// its standing session, or a session it started and still owns. Stamped on
// every team. Under the session_owners feature a person's own session with a
// role among its owners starts a plain worker, and a role's hand takes no
// person owner from its run.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { createSessionFromCli } from "./spawn";

const OWNER = "users_owner";
const MATE = "users_mate";
const ROLE = "org_roles_r";
const TEAM = "teams_t";
const RUN_TEAM = "teams_run";

// `runOn`: the flag on the team the run's session (and so a station nested
// under it) lives in, when it differs from the spawner's.
function fixture(on: boolean, runOn?: boolean) {
  const conv = (over: Record<string, any>) => ({ user_id: OWNER, team_id: TEAM, status: "active", ...over });
  const tables: Record<string, any[]> = {
    users: [{ _id: OWNER, name: "Owner" }, { _id: MATE, name: "Mate" }],
    teams: [
      { _id: TEAM, name: "T", features: on ? { session_owners: true } : {} },
      { _id: RUN_TEAM, name: "R", features: runOn ? { session_owners: true } : {} },
    ],
    team_memberships: [{ _id: "m1", user_id: OWNER, team_id: TEAM, role: "admin" }],
    org_roles: [{ _id: ROLE, short_id: "or-1", name: "Eval lead", handle: "eval", status: "active", trust: "direct", host_user_id: OWNER, scope_type: "team", team_id: TEAM }],
    conversations: [
      conv({ _id: "conversations_standing", session_id: "standing", standing_role_id: ROLE }),
      conv({ _id: "conversations_hand", session_id: "hand", org_role_id: ROLE, role_started: true }),
      conv({ _id: "conversations_filed", session_id: "filed", org_role_id: ROLE }),
      conv({ _id: "conversations_run", session_id: "wf-run", workflow_run_id: "workflow_runs_1", is_workflow_primary: true, ...(runOn === undefined ? {} : { team_id: RUN_TEAM, is_private: false }) }),
    ],
    session_owners: [{ _id: "so_run", conversation_id: "conversations_run", user_id: MATE, added_by: MATE, added_at: 1 }],
    workflow_runs: [{ _id: "workflow_runs_1", user_id: OWNER, primary_conversation_id: "conversations_run" }],
    managed_sessions: [],
  };
  const db = makeFakeDb(tables);
  const ctx = { db, auth: { getUserIdentity: async () => ({ subject: `${OWNER}|session` }) } } as any;
  const spawn = async (spawner: string, extra: Record<string, any> = {}) => {
    const before = new Set(tables.conversations.map((c) => c._id));
    await (createSessionFromCli as any)._handler(ctx, { agent_type: "claude_code", spawner_session: spawner, prompt: "Do it", ...extra });
    return tables.conversations.find((c) => !before.has(c._id))!;
  };
  return { tables, spawn };
}

for (const on of [false, true]) {
  describe(`session_owners ${on ? "on" : "off"}`, () => {
    test("a hand of the standing session is the role's start", async () => {
      const { spawn } = fixture(on);
      expect(await spawn("standing")).toMatchObject({ org_role_id: ROLE, role_started: true });
    });

    test("a hand of a role's own start is the role's start too", async () => {
      const { spawn } = fixture(on);
      expect(await spawn("hand")).toMatchObject({ org_role_id: ROLE, role_started: true });
    });

    test("a person's session filed under a role never starts the role's session", async () => {
      const { spawn } = fixture(on);
      const child = await spawn("filed");
      expect(child.role_started).toBeUndefined();
      // Off, it is still filed under the role as before; on, it is a plain worker.
      expect(child.org_role_id).toBe(on ? undefined : ROLE);
    });

    test("a role's station under a run takes the run's person owners only with the feature off", async () => {
      const { spawn, tables } = fixture(on);
      const station = await spawn("standing", { parent_session: "wf-run" });
      const owners = tables.session_owners.filter((r) => r.conversation_id === station._id).map((r) => r.user_id);
      expect(owners).toEqual(on ? [] : [MATE]);
    });
  });
}

// The role gate reads the flag on the spawner (the role acting); who owns the
// new session reads it on the new row, which may land in another team.
describe("the owner rows follow the new session's team, not the spawner's", () => {
  const stationOwners = async (on: boolean, runOn: boolean) => {
    const { spawn, tables } = fixture(on, runOn);
    const station = await spawn("standing", { parent_session: "wf-run" });
    expect(station.team_id).toBe(RUN_TEAM);
    expect(station.role_started).toBe(true);
    return tables.session_owners.filter((r) => r.conversation_id === station._id).map((r) => r.user_id);
  };

  test("a flagged spawner's hand in an unflagged team keeps its person owners", async () => {
    expect(await stationOwners(true, false)).toEqual([MATE]);
  });

  test("an unflagged spawner's hand in a flagged team takes no person owner", async () => {
    expect(await stationOwners(false, true)).toEqual([]);
  });
});
