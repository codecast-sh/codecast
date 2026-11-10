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

function ctxAs(userId: string) {
  const db = makeFakeDb({
    users: [{ _id: ANA }, { _id: BEN }, { _id: EVE }],
    teams: [{ _id: TEAM, name: "Acme" }],
    team_memberships: [
      { _id: "m1", user_id: ANA, team_id: TEAM, role: "member", visibility: "full" },
      { _id: "m2", user_id: BEN, team_id: TEAM, role: "member", visibility: "full" },
    ],
    conversations: [
      { _id: "conv_open", title: "Shared fix", user_id: BEN, team_id: TEAM, is_private: false },
      { _id: "conv_private", title: "Secret work", user_id: BEN, team_id: TEAM, is_private: true },
    ],
    tasks: [
      { _id: "task_team", short_id: "ct-1", title: "Team task", user_id: BEN, team_id: TEAM, workspace: WS },
      { _id: "task_private", short_id: "ct-2", title: "Private task", user_id: BEN, team_id: TEAM, workspace: `user:${BEN}` },
    ],
    session_owners: [],
    deploys: [{
      _id: "dep_1", workspace: WS, team_id: TEAM, target: "backend", short_id: "dp-1", status: "live", trigger: "manual", source: "marker",
      created_at: 1, carries: [],
      commits: [
        { sha: "a".repeat(40), subject: "one", conversation_id: "conv_open", task_ids: ["task_team"] },
        { sha: "b".repeat(40), subject: "two", conversation_id: "conv_private", task_ids: ["task_private"] },
      ],
    }],
  });
  return { db, auth: { getUserIdentity: async () => ({ subject: `${userId}|sess`, tokenIdentifier: "x" }) } } as any;
}

const run = (userId: string) => (recentForTeam as any)._handler(ctxAs(userId), { team_id: TEAM });

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
});
