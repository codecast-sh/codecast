// One row shape for every channel of the tasks collection (ct-56354). The
// bootstrap floor (webList), the reconcile crawl (webListPaginated) and the
// sync log's refetch (webGetByIds) all write tasks[id] on the client. When one
// of them carried a join the others lacked, the first byIds over a row the
// floor delivered rewrote it (the sim's INV-fixpoint: "add comments"). For one
// viewer, every channel that returns a task returns the same row.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { webGetByIds, webList, webListPaginated } from "./tasks";

const VIEWER = "u_viewer";
const MATE = "u_mate";
const TEAM = "t_team";

function ctx(tables: Record<string, any[]>) {
  return {
    auth: { async getUserIdentity() { return { subject: `${VIEWER}|session` }; } },
    db: makeFakeDb(tables),
    scheduler: { runAfter: async () => null },
    runMutation: async () => null,
  } as any;
}

const taskDefaults = { status: "open", task_type: "task", priority: "medium", source: "human", created_at: 1 };

function world(): Record<string, any[]> {
  return {
    users: [
      { _id: VIEWER, name: "Viewer", team_id: TEAM },
      { _id: MATE, name: "Mate", team_id: TEAM },
    ],
    teams: [{ _id: TEAM, name: "Acme", invite_code: "X" }],
    team_memberships: [
      { _id: "m_viewer", user_id: VIEWER, team_id: TEAM, role: "member" },
      { _id: "m_mate", user_id: MATE, team_id: TEAM, role: "member" },
    ],
    conversations: [
      // The viewer's own session: its comments carry session_info.
      { _id: "c_mine", user_id: VIEWER, session_id: "sess-mine", title: "Mine", agent_type: "claude_code", is_private: true, status: "active", started_at: 1, updated_at: 1 },
      // A teammate's private session: unreadable, so its comment drops the link.
      { _id: "c_hidden", user_id: MATE, session_id: "sess-hidden", title: "Hidden", agent_type: "claude_code", is_private: true, status: "active", started_at: 1, updated_at: 1 },
    ],
    tasks: [
      { _id: "k_team", short_id: "ct-1", title: "Team task", user_id: MATE, team_id: TEAM, workspace: `team:${TEAM}`, assignee: VIEWER, ...taskDefaults, updated_at: 30 },
      { _id: "k_quiet", short_id: "ct-2", title: "No comments", user_id: VIEWER, team_id: TEAM, workspace: `team:${TEAM}`, ...taskDefaults, updated_at: 20 },
      { _id: "k_personal", short_id: "ct-3", title: "Personal", user_id: VIEWER, workspace: `user:${VIEWER}`, ...taskDefaults, updated_at: 10 },
    ],
    task_comments: [
      { _id: "tc_1", task_id: "k_team", author: "Viewer", text: "from my session", comment_type: "note", conversation_id: "c_mine", created_at: 5 },
      { _id: "tc_2", task_id: "k_team", author: "Mate", text: "from a hidden session", comment_type: "progress", conversation_id: "c_hidden", created_at: 6 },
      { _id: "tc_3", task_id: "k_team", author: "Mate", text: "plain", comment_type: "note", author_user_id: MATE, created_at: 7 },
      { _id: "tc_4", task_id: "k_personal", author: "Viewer", text: "same session again", comment_type: "note", conversation_id: "c_mine", created_at: 8 },
    ],
    plans: [],
  };
}

const byId = (rows: any[]) => Object.fromEntries(rows.map((r) => [String(r._id), r]));

async function channels(scope: { workspace: "team"; team_id: string } | { workspace: "personal" }) {
  const list = (await (webList as any)._handler(ctx(world()), { ...scope, include_derived: true })).items;
  const crawl = (await (webListPaginated as any)._handler(ctx(world()), { ...scope, include_derived: true, paginationOpts: { numItems: 100, cursor: null } })).page;
  const ids = list.map((r: any) => String(r._id));
  const refetch = (await (webGetByIds as any)._handler(ctx(world()), { ids })).items;
  return { list: byId(list), crawl: byId(crawl), refetch: byId(refetch), ids };
}

describe("tasks: one row, every channel", () => {
  for (const scope of [{ workspace: "team", team_id: TEAM } as const, { workspace: "personal" } as const]) {
    test(`${scope.workspace} floor, crawl and byIds write each row the same way`, async () => {
      const { list, crawl, refetch, ids } = await channels(scope);
      expect(ids.length).toBeGreaterThan(0);
      expect(Object.keys(crawl).sort()).toEqual([...ids].sort());
      for (const id of ids) {
        expect(refetch[id]).toEqual(list[id]);
        expect(crawl[id]).toEqual(list[id]);
      }
    });
  }

  test("every channel carries comments, oldest first, with session_info only where the viewer can read the session", async () => {
    const { list } = await channels({ workspace: "team", team_id: TEAM });
    expect(list.k_quiet.comments).toEqual([]);
    const comments = list.k_team.comments;
    expect(comments.map((c: any) => c._id)).toEqual(["tc_1", "tc_2", "tc_3"]);
    expect(comments[0].session_info?.session_id).toBe("sess-mine");
    expect(comments[1].session_info).toBeNull();
    expect(comments[1].conversation_id).toBeUndefined();
    expect(comments[2].session_info).toBeNull();
  });
});
