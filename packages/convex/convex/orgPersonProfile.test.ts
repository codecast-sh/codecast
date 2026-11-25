import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performAcceptAll, performCreateProposal, performDecideChange } from "./orgProposals";
import { tallyPeopleEvidence } from "./lib/orgPeopleEvidence";

// A person's profile read from their work (docs/architecture/org-people.md P5):
// the Head of People proposes it as a person_profile change; the person it
// describes or a team admin approves it; applying it writes the profile and
// nothing about what anyone may read.

const ADMIN = "u".repeat(31) + "a";
const JASON = "u".repeat(31) + "j";
const MATE = "u".repeat(31) + "t";
const BOT = "u".repeat(31) + "b";
const TEAM = "teams_acme" as any;
const HOP = "org_roles_hop";
const evidence = { window_days: 30, sessions: 41, commits: 120, tasks_closed: 9, decisions_answered: 6, calls_led: 2, projects: ["Eval Suite"] };

function fixtures() {
  return makeFakeDb({
    users: [
      { _id: ADMIN, name: "Ashot", email: "ashot@x.ai" },
      { _id: JASON, name: "Jason Benn", email: "jason@x.ai", github_username: "jasonbenn" },
      { _id: MATE, name: "Mate", email: "mate@x.ai" },
      { _id: BOT, name: "Bot", email: "bot@x.ai", is_bot: true },
    ],
    team_memberships: [
      { _id: "m_admin", user_id: ADMIN, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m_jason", user_id: JASON, team_id: TEAM, role: "member", joined_at: 1, title: "Agent Quality", focus: "agent quality" },
      { _id: "m_mate", user_id: MATE, team_id: TEAM, role: "member", joined_at: 1 },
    ],
    teams: [{ _id: TEAM, name: "Acme" }],
    counters: [],
    org_roles: [{ _id: HOP, short_id: "or-2", scope_type: "team", team_id: TEAM, host_user_id: ADMIN, name: "Head of People", handle: "head-of-people", trust: "understand", scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: ADMIN }, status: "active", anchor_id: "anchors_hop", created_by: ADMIN, created_at: 1, updated_at: 1 }],
    org_role_history: [],
    anchors: [{ _id: "anchors_hop", name: "Head of People", scope_type: "team", team_id: TEAM, host_user_id: ADMIN, bot_user_id: BOT, org_role_id: HOP, conversation_id: "conversations_hop", status: "active" }],
    projects: [], plans: [], tasks: [], docs: [], agent_tasks: [], session_owners: [], decision_inbox: [], session_decisions: [], decision_grants: [],
    org_proposals: [], org_proposal_changes: [], conversation_links: [], org_changes: [], org_change_batches: [],
    conversations: [{ _id: "conversations_hop", user_id: ADMIN, team_id: TEAM, status: "active", agent_type: "claude_code", title: "Head of People", short_id: "jxhopxx", session_id: "hop", standing_role_id: HOP, anchor_id: "anchors_hop", persistent: true, updated_at: 1, created_at: 1, message_count: 1 }],
  });
}
const ctxOf = (db: any) => ({ db, auth: { getUserIdentity: async () => ({ subject: "browser" }) } }) as any;
const profile = (person: string, over: Record<string, unknown> = {}) => ({ change: { kind: "person_profile", person, title: "Head of Agentic Quality", focus: "evals, agent quality", evidence, ...over }, rationale: "70% of the month's sessions were evals" });
const spec = (changes: any[]) => ({ title: "Profiles", summary_md: "What each person does now.", mode: "review", changes });
const post = (db: any, changes: any[]) => performCreateProposal(ctxOf(db), ADMIN as any, { team_id: TEAM, from_session: "conversations_hop", spec: spec(changes) });
const rows = async (db: any) => (await db.query("org_proposal_changes").collect()).sort((a: any, b: any) => a.seq - b.seq);

describe("person_profile through a proposal", () => {
  test("posting names the member and keeps the profile as it stood, for the card's before", async () => {
    const db = fixtures();
    await post(db, [profile("@jasonbenn")]);
    const [row] = await rows(db);
    expect(row.change).toMatchObject({ user_id: JASON, name: "Jason Benn", before: { title: "Agent Quality", focus: "agent quality" } });
  });

  test("a change about someone outside the team is refused at post", async () => {
    await expect(post(fixtures(), [profile("@nobody")])).rejects.toThrow("not a member of this team");
  });

  test("the person approves their own; the write is the profile, and their role and access stay", async () => {
    const db = fixtures();
    await post(db, [profile("@jasonbenn")]);
    const [row] = await rows(db);
    await performDecideChange(ctxOf(db), JASON as any, { change_id: String(row._id), verdict: "accept" });
    const m: any = await db.get("m_jason");
    expect(m).toMatchObject({ title: "Head of Agentic Quality", focus: "evals, agent quality", role: "member" });
    expect(m.profile_updated.by).toBe(JASON);
    expect((await rows(db))[0].status).toBe("applied");
    const logged = (await db.query("org_changes").collect()).find((r: any) => r.kind === "person_profile");
    expect(logged).toMatchObject({ subject: { type: "person", id: "m_jason" }, before: { profile: { title: "Agent Quality", focus: "agent quality" } }, after: { profile: { title: "Head of Agentic Quality", focus: "evals, agent quality" } } });
  });

  test("another member cannot approve it, nor their own beside someone else's in one sweep", async () => {
    const db = fixtures();
    await post(db, [profile("@jasonbenn"), profile("Mate", { title: "Designer", focus: "the phone app" })]);
    const [jason] = await rows(db);
    await expect(performDecideChange(ctxOf(db), MATE as any, { change_id: String(jason._id), verdict: "accept" })).rejects.toThrow("the person it describes");
    await expect(performAcceptAll(ctxOf(db), MATE as any, { proposal: "op-1" })).rejects.toThrow("team admin can decide it");
    expect(((await db.get("m_jason")) as any).title).toBe("Agent Quality");
  });

  test("an admin approves anyone's", async () => {
    const db = fixtures();
    await post(db, [profile("@jasonbenn"), profile("Mate", { title: "Designer", focus: "the phone app" })]);
    await performAcceptAll(ctxOf(db), ADMIN as any, { proposal: "op-1" });
    expect(((await db.get("m_mate")) as any).title).toBe("Designer");
    expect((await rows(db)).map((r: any) => r.status)).toEqual(["applied", "applied"]);
  });
});

describe("the people evidence", () => {
  const user = (id: string, name: string, email: string) => ({ user: { _id: id, name, email }, membership: { user_id: id, title: id === JASON ? "Agent Quality" : undefined } });
  test("counts each person's sessions, commits, tasks, decisions and calls, with the projects busiest first", () => {
    const out = tallyPeopleEvidence({
      members: [user(JASON, "Jason Benn", "jason@x.ai"), user(MATE, "Mate", "mate@x.ai"), { user: { _id: BOT, name: "Bot", is_bot: true }, membership: {} }],
      sessions: [
        { id: "s1", owner: JASON, project_id: "p_eval" }, { id: "s2", owner: JASON, project_id: "p_eval" }, { id: "s3", owner: JASON, project_id: "p_watch" },
        { id: "s4", owner: MATE, project_id: null },
      ],
      tasks: [
        { assignee: JASON, status: "done", project_id: "p_watch", updated_at: 200 },
        { assignee: JASON, status: "done", project_id: "p_watch", updated_at: 50 },
        { assignee: MATE, status: "open", project_id: "p_eval", updated_at: 200, conversation_ids: ["s1"] },
      ],
      commits: [{ author_email: "JASON@x.ai" }, { author_email: "jason@x.ai" }, { author_email: "stranger@y.io" }],
      decisions: [{ answered_by: { kind: "user", id: JASON } }, { answered_by: { kind: "role", id: HOP } }, { answered_by: null }],
      calls: [{ started_by: MATE }],
      projects: new Map([["p_eval", { title: "Eval Suite", short_id: "pr-1" }], ["p_watch", { title: "AgentWatch" }]]),
      since: 100,
    });
    expect(out.map((p) => p.name)).toEqual(["Jason Benn", "Mate"]);
    const [jason, mate] = out;
    expect(jason).toMatchObject({ sessions: 3, commits: 2, tasks_closed: 1, tasks_open: 0, decisions_answered: 1, calls_led: 0, profile: { title: "Agent Quality" } });
    // A task worked from Jason's session counts toward his projects; it stays Mate's open task.
    expect(jason.projects).toEqual([{ title: "Eval Suite", short_id: "pr-1", sessions: 2, tasks: 1 }, { title: "AgentWatch", sessions: 1, tasks: 2 }]);
    expect(mate).toMatchObject({ sessions: 1, tasks_open: 1, calls_led: 1, commits: 0, projects: [{ title: "Eval Suite", sessions: 0, tasks: 1 }] });
  });
});
