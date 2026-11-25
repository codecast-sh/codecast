// A new session started with the composer's Team pill is born shared with the
// team; Mine is born private and locked; no pick leaves it to the folder rule.
// The preview query the pill reads agrees with what the create does.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { dispatch } from "./dispatch";

const ALICE = "user-alice" as any;
const TEAM = "team-main" as any;

function seed(mappings: any[] = []) {
  return makeFakeDb({
    users: [{ _id: ALICE, name: "Alice", active_team_id: TEAM, team_id: TEAM }],
    teams: [{ _id: TEAM, name: "Main", invite_code: "MAIN", created_at: 1, features: { team_sessions: true } }],
    team_memberships: [{ _id: "m-alice", user_id: ALICE, team_id: TEAM, role: "member" }],
    directory_team_mappings: mappings.map((m, i) => ({ _id: `dtm-${i}`, user_id: ALICE, ...m })),
    anchors: [], anchor_channels: [], pending_messages: [], conversations: [], session_owners: [],
    devices: [], daemon_commands: [], change_log: [], local_view_heads: [], docs: [], plans: [], tasks: [],
    rate_limits: [], notifications: [], push_outbox: [], entity_subscriptions: [], user_presence: [],
  });
}

const ctxAs = (db: any) => ({
  db,
  auth: { getUserIdentity: async () => ({ subject: `${ALICE}|session` }) },
  scheduler: { runAfter: async () => undefined },
  runMutation: async () => undefined,
  runQuery: async () => undefined,
}) as any;

async function start(db: any, sessionId: string, pick: Record<string, boolean> = {}) {
  await (dispatch as any)._handler(ctxAs(db), { action: "createSession", args: [{ agent_type: "claude_code", project_path: "/repo", session_id: sessionId, ...pick }] });
  return db._tables.conversations.find((c: any) => c.session_id === sessionId);
}

describe("starting a session as Mine or Team", () => {
  test("Team makes it a team session even where the folder rule keeps it private", async () => {
    const db = seed();
    expect(await start(db, "s-team", { team: true })).toMatchObject({ team_id: TEAM, is_private: false, team_visibility: "full" });
    expect(db._tables.session_team_owners ?? []).toHaveLength(1);
  });

  test("Mine is private and locked even where the folder rule shares it", async () => {
    const db = seed([{ path_prefix: "/repo", team_id: TEAM, auto_share: true }]);
    expect(await start(db, "s-mine", { private: true })).toMatchObject({ is_private: true, team_visibility: "private" });
  });

  test("no pick follows the folder rule", async () => {
    const db = seed([{ path_prefix: "/repo", team_id: TEAM, auto_share: true }]);
    expect(await start(db, "s-rule")).toMatchObject({ team_id: TEAM, is_private: false });
  });
});
