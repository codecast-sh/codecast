// A new session started as Team from the composer's Personal | Team switch is
// born a team session; Personal sends nothing, so the folder rule decides; an
// explicit `private` create (not sent by the switch) is private and locked.
// The preview query the switch reads agrees with what the create does.
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

async function start(db: any, sessionId: string, pick: Record<string, boolean | string> = {}) {
  await (dispatch as any)._handler(ctxAs(db), { action: "createSession", args: [{ agent_type: "claude_code", project_path: "/repo", session_id: sessionId, ...pick }] });
  return db._tables.conversations.find((c: any) => c.session_id === sessionId);
}

describe("starting a session as Team, Personal or private", () => {
  test("Team makes it a team session even where the folder rule keeps it private", async () => {
    const db = seed();
    expect(await start(db, "s-team", { team: true })).toMatchObject({ team_id: TEAM, is_private: false, team_visibility: "full" });
    expect(db._tables.session_team_owners ?? []).toHaveLength(1);
  });

  test("an explicit private create is private and locked even where the folder rule shares it", async () => {
    const db = seed([{ path_prefix: "/repo", team_id: TEAM, auto_share: true }]);
    expect(await start(db, "s-mine", { private: true })).toMatchObject({ is_private: true, team_visibility: "private" });
  });

  test("no pick follows the folder rule", async () => {
    const db = seed([{ path_prefix: "/repo", team_id: TEAM, auto_share: true }]);
    expect(await start(db, "s-rule")).toMatchObject({ team_id: TEAM, is_private: false });
  });

  test("Summary or Full shares it at that level even where the folder rule keeps it private", async () => {
    const db = seed();
    expect(await start(db, "s-summary", { team_visibility: "summary" })).toMatchObject({ team_id: TEAM, is_private: false, team_visibility: "summary" });
    const full = await start(db, "s-full", { team_visibility: "full" });
    expect(full).toMatchObject({ team_id: TEAM, is_private: false, team_visibility: "full" });
    expect(full.auto_shared).toBeUndefined();
  });

  test("a level never outranks Hidden or Team", async () => {
    const db = seed();
    expect(await start(db, "s-both", { private: true, team_visibility: "full" })).toMatchObject({ is_private: true, team_visibility: "private" });
    expect(await start(db, "s-team-level", { team: true, team_visibility: "summary" })).toMatchObject({ team_visibility: "full" });
  });
});
