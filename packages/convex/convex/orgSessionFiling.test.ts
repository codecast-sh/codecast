import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performAcceptAll, performCreateProposal } from "./orgProposals";
import { looseSessionsOf } from "./lib/orgSessionFiling";

// The person's sessions filed where they belong (org-staffing.md S43): a
// filing goes under a role, onto a task, or out of the inbox as done, through
// a proposal the person accepts; a role a person lets start work on its own
// files without asking.

const ME = "u".repeat(31) + "m";
const BOT = "u".repeat(31) + "b";
const TEAM = "teams_acme" as any;
const WS = `team:${TEAM}`;
const NOW = 1_800_000_000_000;
const GROWTH = "org_roles_growth";
const HOP = "org_roles_hop";

function fixtures(o: { hopTrust?: string } = {}) {
  const conv = (id: string, short: string, title: string, extra: Record<string, any> = {}) => ({ _id: id, user_id: ME, team_id: TEAM, status: "active", agent_type: "claude_code", title, short_id: short, session_id: id, project_path: "/repo", updated_at: NOW, created_at: 1, message_count: 4, ...extra });
  return makeFakeDb({
    users: [{ _id: ME, name: "Me", email: "me@x.ai" }, { _id: BOT, name: "Bot", email: "bot@x.ai" }],
    team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 }],
    teams: [{ _id: TEAM, name: "Acme" }],
    counters: [],
    org_roles: [
      { _id: GROWTH, short_id: "or-1", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Growth lead", handle: "growth", trust: "direct", scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", anchor_id: "anchors_growth", created_by: ME, created_at: 1, updated_at: 1 },
      { _id: HOP, short_id: "or-2", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Head of People", handle: "head-of-people", trust: o.hopTrust ?? "understand", scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", anchor_id: "anchors_hop", created_by: ME, created_at: 1, updated_at: 1 },
    ],
    org_role_history: [],
    anchors: [
      { _id: "anchors_growth", name: "Growth lead", scope_type: "team", team_id: TEAM, host_user_id: ME, bot_user_id: BOT, org_role_id: GROWTH, conversation_id: "conversations_growth", status: "active" },
      { _id: "anchors_hop", name: "Head of People", scope_type: "team", team_id: TEAM, host_user_id: ME, bot_user_id: BOT, org_role_id: HOP, conversation_id: "conversations_hop", status: "active" },
    ],
    projects: [], plans: [],
    tasks: [{ _id: "tasks_refunds", user_id: ME, team_id: TEAM, workspace: WS, short_id: "ct-7", title: "Partial refunds", status: "open", created_at: 1, updated_at: 1 }],
    docs: [], agent_tasks: [], session_owners: [], decision_inbox: [], session_decisions: [], decision_grants: [], org_proposals: [], org_proposal_changes: [], conversation_links: [],
    conversations: [
      conv("conversations_growth", "jxgrowt", "Growth lead", { standing_role_id: GROWTH, anchor_id: "anchors_growth", persistent: true }),
      conv("conversations_hop", "jxhopxx", "Head of People", { standing_role_id: HOP, anchor_id: "anchors_hop", persistent: true }),
      conv("conversations_tweet", "jxtweet", "Draft the launch thread"),
      conv("conversations_refund", "jxrefnd", "Wire the refund endpoint"),
      conv("conversations_ci", "jxcinod", "Bump Node in CI"),
    ],
  });
}
const ctxOf = (db: any) => ({ db, auth: { getUserIdentity: async () => ({ subject: "browser" }) } }) as any;
const filing = (session: string, to: string) => ({ change: { kind: "file_session", session, to }, rationale: "its work is that area's" });
const spec = (changes: any[]) => ({ title: "Tidy your inbox", summary_md: "Three sessions find their place.", mode: "review", changes });
const tidy = [filing("jxtweet", "@growth"), filing("jxrefnd", "ct-7"), filing("jxcinod", "done")];

describe("filing the person's sessions", () => {
  test("accepted, each session goes where its filing says, through the person's own doors", async () => {
    const db = fixtures();
    const r = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "conversations_hop", spec: spec(tidy) });
    expect(r.status).toBe("open");
    await performAcceptAll(ctxOf(db), ME as any, { proposal: r.short_id });
    expect(await db.get("conversations_tweet")).toMatchObject({ org_role_id: GROWTH });
    expect(await db.get("conversations_refund")).toMatchObject({ active_task_id: "tasks_refunds" });
    expect((await db.get("tasks_refunds") as any).conversation_ids).toEqual(["conversations_refund"]);
    expect((await db.get("conversations_ci") as any).inbox_dismissed_at).toBeGreaterThan(0);
    expect((await db.query("org_proposal_changes").collect()).map((c: any) => c.status)).toEqual(["applied", "applied", "applied"]);
  });

  test("a role whose switch is off posts a card and moves nothing", async () => {
    const db = fixtures();
    await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "conversations_hop", spec: spec(tidy) });
    expect(await db.get("conversations_tweet")).not.toHaveProperty("org_role_id");
    expect((await db.query("org_proposal_changes").collect()).map((c: any) => c.status)).toEqual(["proposed", "proposed", "proposed"]);
  });

  test("a role a person lets start work on its own files at once, and says so on each row", async () => {
    const db = fixtures({ hopTrust: "direct" });
    const r = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "conversations_hop", spec: spec(tidy) });
    expect(r).toMatchObject({ applied: true });
    expect(await db.get("conversations_tweet")).toMatchObject({ org_role_id: GROWTH });
    expect((await db.query("org_proposal_changes").collect())[0]).toMatchObject({ status: "applied", reply: { verdict: "approve", text: "Filed by @head-of-people, which starts work on its own" } });
  });

  test("filings are their own kind of work: mixed with a structure change the spec is refused", async () => {
    const db = fixtures();
    await expect(performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "conversations_hop", spec: spec([filing("jxtweet", "@growth"), { change: { kind: "retire", handle: "growth" }, rationale: "done" }]) })).rejects.toThrow("session filings as a fourth");
  });

  test("a filing to nowhere is refused at post", async () => {
    const db = fixtures();
    await expect(performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, spec: spec([filing("jxtweet", "growth")]) })).rejects.toThrow('to is "@handle"');
  });
});

describe("the inputs' loose sessions", () => {
  test("the caller's own sessions that no role, task or seat places, newest first", async () => {
    const row = (id: string, updated_at: number, raw: Record<string, any> = {}) => ({ s: { _id: id, short_id: id, title: id, state: "idle", updated_at }, raw: { _id: id, ...raw } });
    const rows = [row("old", 1), row("new", 3), row("bound", 2, { active_task_id: "t" }), row("filed", 2, { org_role_id: "r" }), row("seat", 2, { standing_role_id: "r" })];
    const scan: any = { byParent: new Map([[`user:${ME}`, rows.map((r) => r.s)]]), sessions: new Map(rows.map((r) => [r.s._id, { session: r.s, raw: r.raw }])) };
    const loose = await looseSessionsOf({ db: null }, scan, ME as any);
    expect(loose.count).toBe(2);
    expect(loose.rows.map((r) => r.short_id)).toEqual(["new", "old"]);
  });
});
