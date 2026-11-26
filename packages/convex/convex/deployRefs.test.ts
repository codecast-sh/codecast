import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { recentForTeam } from "./deployRefs";

// A team's deploy list names the sessions and tasks each deploy carried. A
// commit's session can be private to its owner (team_id is routing), so each
// title is shown only to a viewer who may read that session or task.

const TEAM = "teams_acme";
const WS = `team:${TEAM}`;
const ANA = "users_ana";
const BEN = "users_ben";
const EVE = "users_eve"; // no team

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

function ctxAs(userId: string, o: { priorities?: boolean } = {}) {
  const db = makeFakeDb({
    users: [{ _id: ANA }, { _id: BEN }, { _id: EVE }],
    teams: [{ _id: TEAM, name: "Acme", features: { priorities: o.priorities ?? false } }],
    team_memberships: [
      { _id: "m1", user_id: ANA, team_id: TEAM, role: "member", visibility: "full" },
      { _id: "m2", user_id: BEN, team_id: TEAM, role: "member", visibility: "full" },
    ],
    conversations: [
      { _id: "conv_open", title: "Shared fix", user_id: BEN, team_id: TEAM, is_private: false },
      { _id: "conv_private", title: "Secret work", user_id: BEN, team_id: TEAM, is_private: true, priority_id: "pri_ben", git_branch: "ben/secret" },
    ],
    priorities: [{ _id: "pri_ben", short_id: "pri-4", title: "Ship the board", user_id: BEN, workspace: `user:${BEN}`, status: "active", steps: [] }],
    // Main's rows: a checkout's numstat counts its lines, a push webhook names files with none (its insertions count
    // files), and a squash merge's lines are its pull request's.
    commits: [
      { _id: "c_a", sha: SHA_A, repository: "o/r", message: "one", files: [{ filename: "x.ts", status: "modified", additions: 7, deletions: 2, changes: 9 }, { filename: "y.ts", status: "added", additions: 3, deletions: 0, changes: 3 }], insertions: 10, deletions: 2, pr_number: 41 },
      { _id: "c_b", sha: SHA_B, repository: "o/r", message: "two (#42)", files: [{ filename: "z.ts", status: "modified", additions: 0, deletions: 0, changes: 0 }], insertions: 1, deletions: 0 },
      { _id: "c_c", sha: SHA_C, repository: "o/r", message: "three", files: [{ filename: "w.ts", status: "modified", additions: 0, deletions: 0, changes: 0 }], insertions: 1, deletions: 0 },
    ],
    pull_requests: [{ _id: "pr_42", repository: "o/r", number: 42, head_ref: "ana/two", additions: 120, deletions: 30 }],
    tasks: [
      { _id: "task_team", short_id: "ct-1", title: "Team task", user_id: BEN, team_id: TEAM, workspace: WS },
      { _id: "task_private", short_id: "ct-2", title: "Private task", user_id: BEN, team_id: TEAM, workspace: `user:${BEN}` },
    ],
    session_owners: [],
    deploys: [{
      _id: "dep_1", workspace: WS, team_id: TEAM, target: "backend", repository: "o/r", short_id: "dp-1", status: "live", trigger: "manual", source: "marker",
      created_at: 1, carries: [],
      commits: [
        { sha: SHA_A, subject: "one", conversation_id: "conv_open", task_ids: ["task_team"] },
        { sha: SHA_B, subject: "two (#42)", conversation_id: "conv_private", task_ids: ["task_private"] },
        { sha: SHA_C, subject: "three", conversation_id: "conv_private" },
      ],
    }],
  });
  return { db, auth: { getUserIdentity: async () => ({ subject: `${userId}|sess`, tokenIdentifier: "x" }) } } as any;
}

const run = (userId: string, o: { priorities?: boolean } = {}) => (recentForTeam as any)._handler(ctxAs(userId, o), { team_id: TEAM });

describe("deployRefs.recentForTeam", () => {
  test("a teammate sees the team visible session and task, never the private ones", async () => {
    const [d] = await run(ANA);
    expect(d.sessions.map((s: any) => s.title)).toEqual(["Shared fix"]);
    expect(d.tasks.map((t: any) => t.short_id)).toEqual(["ct-1"]);
    expect(d.commit_rows[1].tasks).toEqual([]);
  });

  test("the owner still sees their own private session and task", async () => {
    const [d] = await run(BEN);
    expect(d.sessions.map((s: any) => s.title).sort()).toEqual(["Secret work", "Shared fix"]);
    expect(d.tasks.map((t: any) => t.short_id).sort()).toEqual(["ct-1", "ct-2"]);
  });

  test("someone outside the team gets nothing", async () => {
    expect(await run(EVE)).toEqual([]);
  });

  test("each session names its owner; a session the viewer may not read names nobody", async () => {
    const [mate] = await run(ANA);
    expect(mate.sessions).toEqual([{ conversation_id: "conv_open", short_id: "conv_op", title: "Shared fix", user_id: BEN }]);
    const [own] = await run(BEN);
    expect(own.sessions.map((s: any) => s.user_id)).toEqual([BEN, BEN]);
  });

  test("a session's priority shows only while the team has priorities on, to a viewer who may read it", async () => {
    const [off] = await run(BEN);
    expect(off.sessions.find((s: any) => s.conversation_id === "conv_private").priority).toBeUndefined();
    const [on] = await run(BEN, { priorities: true });
    expect(on.sessions.find((s: any) => s.conversation_id === "conv_private").priority).toEqual({ id: "pri-4", title: "Ship the board" });
    expect(on.sessions.find((s: any) => s.conversation_id === "conv_open").priority).toBeUndefined();
  });

  test("each commit carries its lines, pull request and branch from its row on main", async () => {
    const [d] = await run(BEN);
    const [a, b, c] = d.commit_rows;
    // The checkout's numstat: the files' own counts.
    expect(a).toMatchObject({ insertions: 10, deletions: 2, pr_number: 41, branch: null });
    // A push webhook row with no line counts, squash-merged from #42: the pull request's lines and head.
    expect(b).toMatchObject({ insertions: 120, deletions: 30, pr_number: 42, branch: "ana/two" });
    // Nothing recorded its lines: none are claimed (never the row's file count); the branch is its session's.
    expect(c.insertions).toBeUndefined();
    expect(c.deletions).toBeUndefined();
    expect(c).toMatchObject({ pr_number: null, branch: "ben/secret" });
  });

  test("a session's branch is never read for a viewer who may not read that session", async () => {
    const [d] = await run(ANA);
    expect(d.commit_rows[2].branch).toBeNull();
  });
});
