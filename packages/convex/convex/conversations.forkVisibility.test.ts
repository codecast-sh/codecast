import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { forkFromMessage } from "./conversations";

// A fork takes the visibility a fresh session in the same project would get
// under the FORKER's mappings. Forking a teammate's session hands over their
// checkout path, which none of the forker's path mappings name, so the repo
// mapping has to decide it.
describe("forkFromMessage visibility for a teammate's session", () => {
  const owner = "users_owner" as any;
  const forker = "users_forker" as any;
  const team = "teams_union" as any;
  const ctx = (db: any) => ({ db, auth: { getUserIdentity: async () => ({ subject: `${forker}|session` }) } });

  function fixture(mappings: Record<string, any>[]) {
    return makeFakeDb({
      users: [{ _id: owner, team_id: team }, { _id: forker, team_id: team }],
      team_memberships: [
        { _id: "tm_1", team_id: team, user_id: owner, role: "admin" },
        { _id: "tm_2", team_id: team, user_id: forker, role: "admin" },
      ],
      conversations: [{
        _id: "conv_parent", user_id: owner, team_id: team, is_private: false, auto_shared: true,
        session_id: "sess-parent", agent_type: "claude_code", short_id: "convpar", title: "Deal simulation rules",
        project_path: "/Users/owner/src/union-mobile", git_root: "/Users/owner/src/union-mobile",
        git_remote_url: "git@github.com:Union-AI/union-mobile.git", started_at: 1, updated_at: 1, message_count: 0,
      }],
      messages: [],
      devices: [],
      daemon_commands: [],
      pending_messages: [],
      directory_team_mappings: mappings.map((m, i) => ({ _id: `dtm_${i}`, user_id: forker, ...m })),
      session_owners: [],
      label_assignments: [],
      change_log: [],
      local_view_heads: [],
      rate_limits: [],
    });
  }

  test("the forker's repo mapping shares the fork with the team", async () => {
    const db = fixture([
      { path_prefix: "/Users/forker/dev/union-mobile", repository: "union-ai/union-mobile", team_id: team, auto_share: true },
    ]);
    const r = await (forkFromMessage as any)._handler(ctx(db), { conversation_id: "conv_parent" });
    const fork = await db.get(r.conversation_id);
    expect(fork).toMatchObject({ user_id: forker, team_id: team, is_private: false, auto_shared: true });
  });

  test("with no mapping for the path or repo the fork stays private and unrouted", async () => {
    const db = fixture([
      { path_prefix: "/Users/forker/dev/other", repository: "someone/other", team_id: team, auto_share: true },
    ]);
    const r = await (forkFromMessage as any)._handler(ctx(db), { conversation_id: "conv_parent" });
    const fork = await db.get(r.conversation_id);
    expect(fork.is_private).toBe(true);
    expect(fork.team_id).toBeUndefined();
  });
});
