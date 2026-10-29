import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performAcceptAll, performCreateProposal, performDecideAsk, performDecideChange } from "./orgProposals";
import { looseSessionsOf } from "./lib/orgSessionFiling";
import { newSinceLook, syncInboxLook } from "./orgInbox";
import { HEAD_INBOX_EVERY_MS, HEAD_INBOX_TITLE } from "./lib/orgRoutine";

// The person's sessions filed where they belong (org-staffing.md S43): a
// filing goes under a role, onto a task, or out of the inbox as done, through
// a proposal the person accepts; a role a person lets start work on its own
// files without asking.

const ME = "u".repeat(31) + "m";
const BOT = "u".repeat(31) + "b";
const MATE = "u".repeat(31) + "t";
const TEAM = "teams_acme" as any;
const WS = `team:${TEAM}`;
const NOW = 1_800_000_000_000;
const GROWTH = "org_roles_growth";
const HOP = "org_roles_hop";

function fixtures(o: { hopTrust?: string } = {}) {
  const conv = (id: string, short: string, title: string, extra: Record<string, any> = {}) => ({ _id: id, user_id: ME, team_id: TEAM, status: "active", agent_type: "claude_code", title, short_id: short, session_id: id, project_path: "/repo", updated_at: NOW, created_at: 1, message_count: 4, ...extra });
  return makeFakeDb({
    users: [{ _id: ME, name: "Me", email: "me@x.ai" }, { _id: BOT, name: "Bot", email: "bot@x.ai" }, { _id: MATE, name: "Mate", email: "mate@x.ai" }],
    team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 }, { _id: "m2", user_id: MATE, team_id: TEAM, role: "member", joined_at: 1 }],
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
      conv("conversations_mate", "jxmate1", "Mate's onboarding fix", { user_id: MATE }),
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
    // The answer reports what routing did, not the rows as first written: the author reads it.
    expect(r).toMatchObject({ applied: true, status: "resolved" });
    expect(r.changes.map((c: any) => c.status)).toEqual(r.changes.map(() => "applied"));
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

describe("a new lead and its threads in one proposal", () => {
  const hire = [
    { change: { kind: "role", name: "Head of Mobile", handle: "mobile", reports_to: "@growth" }, rationale: "nobody owns the apps" },
    filing("jxtweet", "@mobile"),
    filing("jxrefnd", "@mobile"),
  ];

  test("posts as one structure proposal with one card, and accepting it seats the lead and files both sessions under it", async () => {
    const db = fixtures();
    const r = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "conversations_hop", spec: spec(hire) });
    expect(r.status).toBe("open");
    await performDecideAsk(ctxOf(db), ME as any, { proposal: r.short_id, ask: 0, verdict: "accept", provision: false });
    const mobile = (await db.query("org_roles").collect()).find((x: any) => x.handle === "mobile");
    expect(mobile).toBeTruthy();
    expect(await db.get("conversations_tweet")).toMatchObject({ org_role_id: mobile._id });
    expect(await db.get("conversations_refund")).toMatchObject({ org_role_id: mobile._id });
    expect((await db.query("org_proposal_changes").collect()).map((c: any) => c.status)).toEqual(["applied", "applied", "applied"]);
  });

  test("a filing cannot run ahead of its role: refused alone, held back from a narrowed accept, skipped with its role", async () => {
    const db = fixtures();
    const r = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "conversations_hop", spec: spec(hire) });
    const rows = await db.query("org_proposal_changes").collect();
    const bySeq = (n: number) => rows.find((c: any) => c.seq === n)!;
    await expect(performDecideChange(ctxOf(db), ME as any, { change_id: String(bySeq(2)._id), verdict: "accept" })).rejects.toThrow("accept #1 first");
    const narrowed = await performAcceptAll(ctxOf(db), ME as any, { proposal: r.short_id, kinds: ["file_session"] });
    expect(narrowed.applied + narrowed.failed).toBe(0);
    await performDecideChange(ctxOf(db), ME as any, { change_id: String(bySeq(1)._id), verdict: "skip" });
    const after = await db.query("org_proposal_changes").collect();
    expect(after.map((c: any) => c.status)).toEqual(["skipped", "skipped", "skipped"]);
    expect(after[1].applied_note).toContain("skipped with @mobile");
  });

  test("skipping the lead's card leaves its threads where they were", async () => {
    const db = fixtures();
    const r = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "conversations_hop", spec: spec(hire) });
    await performDecideAsk(ctxOf(db), ME as any, { proposal: r.short_id, ask: 0, verdict: "skip" });
    expect((await db.query("org_roles").collect()).some((x: any) => x.handle === "mobile")).toBe(false);
    expect((await db.get("conversations_tweet") as any).org_role_id).toBeUndefined();
    expect((await db.get("conversations_refund") as any).org_role_id).toBeUndefined();
  });
});

describe("who decides a filing", () => {
  test("a member who is no admin accepts the filings of their own sessions on the card", async () => {
    const db = fixtures();
    const r = await performCreateProposal(ctxOf(db), MATE as any, { team_id: TEAM, spec: spec([filing("jxmate1", "@growth")]) });
    await performAcceptAll(ctxOf(db), MATE as any, { proposal: r.short_id });
    expect(await db.get("conversations_mate")).toMatchObject({ org_role_id: GROWTH });
  });

  test("a member cannot decide a filing of someone else's session, nor any other kind of change", async () => {
    const db = fixtures();
    const theirs = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "conversations_hop", spec: spec([filing("jxmate1", "@growth"), filing("jxtweet", "@growth")]) });
    await expect(performAcceptAll(ctxOf(db), MATE as any, { proposal: theirs.short_id })).rejects.toThrow("team admin can decide it");
    const structure = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, spec: spec([{ change: { kind: "budget", handle: "growth", caps: { wakes_per_day: 9 } }, rationale: "quiet" }]) });
    await expect(performAcceptAll(ctxOf(db), MATE as any, { proposal: structure.short_id })).rejects.toThrow("team admin can decide it");
    expect(await db.get("conversations_mate")).not.toHaveProperty("org_role_id");
  });
});

describe("the Head of People's daily look at the inbox", () => {
  const standing = (db: any) => db.get("conversations_hop");
  const looks = async (db: any) => (await db.query("agent_tasks").collect()).filter((t: any) => t.title === HEAD_INBOX_TITLE);

  test("arms once, daily, behind the gate that spends nothing without a new loose session", async () => {
    const db = fixtures();
    const role = await db.get(HOP);
    expect(await syncInboxLook(ctxOf(db), role, await standing(db), NOW)).toBe("armed");
    expect(await syncInboxLook(ctxOf(db), role, await standing(db), NOW)).toBe("kept");
    const [look] = await looks(db);
    expect(await looks(db)).toHaveLength(1);
    expect(look).toMatchObject({ schedule_type: "recurring", interval_ms: HEAD_INBOX_EVERY_MS, precheck: `cast org loose --new --team ${TEAM}`, role_id: HOP });
  });

  test("only the Head of People looks, and a look the person cancelled stays cancelled", async () => {
    const db = fixtures();
    expect(await syncInboxLook(ctxOf(db), await db.get(GROWTH), await db.get("conversations_growth"), NOW)).toBe("none");
    await syncInboxLook(ctxOf(db), await db.get(HOP), await standing(db), NOW);
    const [look] = await looks(db);
    await db.patch(look._id, { status: "cancelled" });
    expect(await syncInboxLook(ctxOf(db), await db.get(HOP), await standing(db), NOW)).toBe("kept");
    expect(await looks(db)).toHaveLength(1);
  });

  test("new means started since the look last ran; before any look every loose session is new", () => {
    const rows = [{ short_id: "a", started_at: 100, last_active_at: 500 }, { short_id: "b", started_at: 300, last_active_at: 300 }, { short_id: "c", started_at: null, last_active_at: 400 }];
    expect(newSinceLook(rows, 200).map((r) => r.short_id)).toEqual(["b", "c"]);
    expect(newSinceLook(rows, 1000)).toEqual([]);
    expect(newSinceLook(rows, null)).toHaveLength(3);
  });
});

describe("the inputs' loose sessions", () => {
  test("the caller's own sessions that no role, task, seat, workflow or trigger places, and not stashed, newest first", async () => {
    const row = (id: string, updated_at: number, raw: Record<string, any> = {}) => ({ s: { _id: id, short_id: id, title: id, state: "idle", updated_at }, raw: { _id: id, ...raw } });
    const rows = [row("old", 1), row("new", 3), row("bound", 2, { active_task_id: "t" }), row("filed", 2, { org_role_id: "r" }), row("seat", 2, { standing_role_id: "r" }), row("station", 2, { workflow_run_id: "w" }), row("run", 2, { agent_task_id: "t" }), row("stashed", 2, { inbox_stashed_at: 1 })];
    const scan: any = { byParent: new Map([[`user:${ME}`, rows.map((r) => r.s)]]), sessions: new Map(rows.map((r) => [r.s._id, { session: r.s, raw: r.raw }])) };
    const loose = await looseSessionsOf({ db: null }, scan, ME as any);
    expect(loose.count).toBe(2);
    expect(loose.rows.map((r) => r.short_id)).toEqual(["new", "old"]);
  });
});
