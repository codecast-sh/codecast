// Sharing decisions out by area (decisionRouting.ts, decisionShareOut.ts,
// decisionAreas.ts), driven through askCore and the cores against the fake
// db: the pool a decision's project picks, the fewest-open rotation and its
// tie-break, the members skipped (away, not taking decisions, bots), the
// chain every other ask keeps, the admins' areas card, and Share out's
// preview matching what it applies.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { askCore, finalizeAnswer, reroutePendingDecisionsForConversation } from "./sessionDecisions";
import { passCore } from "./decisionHandoff";
import { shareOutCore, shareOutPreviewCore } from "./decisionShareOut";
import { AREAS_RECHECK_MS, askForAreas } from "./decisionAreas";
import { AREAS_CARD_QUESTION } from "@codecast/shared/contracts/decisionAreas";

const HOST = "users_host" as any; // admin, owns the asking session, covers nothing
const SAM = "users_sam" as any;
const JAS = "users_jas" as any;
const KIM = "users_kim" as any;
const BOT = "users_bot" as any;
const TEAM = "teams_acme" as any;
const NOW = 1_800_000_000_000;
const DEALS = "projects_deals";
const DESK = "projects_desk";
const LOOSE = "projects_loose";

type Seed = { memberships?: any[]; users?: any[]; conversations?: any[]; team?: any; extra?: Record<string, any[]> };

function seed(o: Seed = {}) {
  const member = (id: string, user: string, role: "admin" | "member", focus?: string[], more: any = {}) =>
    ({ _id: id, user_id: user, team_id: TEAM, role, joined_at: NOW, ...(focus ? { focus_project_ids: focus } : {}), ...more });
  const tables: Record<string, any[]> = {
    users: o.users ?? [
      { _id: HOST, name: "Host" },
      { _id: SAM, name: "Samvit" },
      { _id: JAS, name: "Jason" },
      { _id: KIM, name: "Kim" },
      { _id: BOT, name: "Mr Bot", is_bot: true },
    ],
    teams: [{ _id: TEAM, name: "Acme", decision_areas: { set_at: NOW - 1 }, ...o.team }],
    team_memberships: o.memberships ?? [
      member("m_host", HOST, "admin"),
      member("m_sam", SAM, "member", [DEALS]),
      member("m_jas", JAS, "member", [DEALS]),
      member("m_kim", KIM, "member", [DESK]),
      member("m_bot", BOT, "member", [DEALS, DESK]),
    ],
    projects: [
      { _id: DEALS, title: "Deal flow", workspace: `team:${TEAM}`, team_id: TEAM, status: "active", user_id: HOST },
      { _id: DESK, title: "Desk", workspace: `team:${TEAM}`, team_id: TEAM, status: "active", user_id: HOST },
      { _id: LOOSE, title: "Loose ends", workspace: `team:${TEAM}`, team_id: TEAM, status: "active", user_id: HOST },
    ],
    org_roles: [{
      _id: "org_roles_desk", short_id: "or-1", scope_type: "team", team_id: TEAM, host_user_id: HOST, name: "Desk lead", handle: "desk",
      scope: { project_ids: [DESK], plan_ids: [] }, reports_to: { kind: "user", user_id: HOST }, status: "active", created_by: HOST, created_at: NOW, updated_at: NOW,
    }],
    conversations: o.conversations ?? [
      { _id: "conversations_ask", session_id: "sess-ask", user_id: HOST, owner_user_id: HOST, team_id: TEAM, message_count: 1 },
      { _id: "conversations_private", session_id: "sess-private", user_id: HOST, owner_user_id: HOST, team_id: TEAM, is_private: true, message_count: 1 },
      { _id: "conversations_desk", session_id: "sess-desk", user_id: HOST, owner_user_id: HOST, team_id: TEAM, message_count: 1, active_task_id: "tasks_desk" },
      { _id: "conversations_role", session_id: "sess-role", user_id: HOST, team_id: TEAM, message_count: 1, standing_role_id: undefined, org_role_id: "org_roles_desk" },
    ],
    session_owners: [],
    tasks: [
      { _id: "tasks_deals", short_id: "ct-1", user_id: HOST, team_id: TEAM, workspace: `team:${TEAM}`, title: "Close Lloyds", status: "open", project_id: DEALS, task_type: "task", priority: "medium" },
      { _id: "tasks_desk", short_id: "ct-2", user_id: HOST, team_id: TEAM, workspace: `team:${TEAM}`, title: "Desk rota", status: "open", project_id: DESK, task_type: "task", priority: "medium" },
      { _id: "tasks_loose", short_id: "ct-3", user_id: HOST, team_id: TEAM, workspace: `team:${TEAM}`, title: "Odd job", status: "open", project_id: LOOSE, task_type: "task", priority: "medium" },
    ],
    session_decisions: [],
    decision_inbox: [],
    decision_grants: [],
    decision_stacks: [],
    notifications: [],
    entity_subscriptions: [],
    anchors: [],
    docs: [],
    counters: [],
    pending_messages: [],
    ...o.extra,
  };
  const db = makeFakeDb(tables);
  const scheduled: { ms: number; args: any }[] = [];
  const scheduler = { runAfter: async (ms: number, _fn: unknown, args: any) => { scheduled.push({ ms, args }); } };
  return { ctx: { db, scheduler } as any, tables, scheduled };
}

const options = [{ label: "Yes" }, { label: "No" }];
let n = 0;
async function ask(ctx: any, over: Record<string, any> = {}) {
  const r = await askCore(ctx, { userId: HOST }, { session_id: "sess-ask", question: `Question ${++n}?`, options, context_md: "Why.", category: "approach", ...over });
  expect(r.error).toBeUndefined();
  return r;
}
const row = (tables: any, id: string) => tables.session_decisions.find((d: any) => String(d._id) === String(id));
const askedOf = (tables: any, id: string) => row(tables, id).asked_user_ids.map(String);

describe("ask time: the project picks its members", () => {
  test("a task's project goes to its pool, fewest open first, rotating", async () => {
    const { ctx, tables } = seed();
    const first = await ask(ctx, { task: "ct-1" });
    const second = await ask(ctx, { task: "ct-1" });
    const third = await ask(ctx, { task: "ct-1" });
    const owners = [first, second, third].map((r) => askedOf(tables, r.id)[0]);
    expect(new Set(owners.slice(0, 2))).toEqual(new Set([SAM, JAS]));
    expect([SAM, JAS]).toContain(owners[2]);
    expect(row(tables, first.id).holder).toEqual({ kind: "user", id: owners[0] });
    // One each before anyone gets a second.
    expect(owners[0]).not.toBe(owners[1]);
  });

  test("the load is the queue: the one with more waiting on them waits", async () => {
    const { ctx, tables } = seed({ extra: { decision_inbox: [
      { _id: "decision_inbox_q", decision_id: "session_decisions_x", user_id: SAM, status: "pending", created_at: NOW - 10 },
    ] } });
    const r = await ask(ctx, { task: "ct-1" });
    expect(askedOf(tables, r.id)).toEqual([JAS]);
  });

  test("a tie goes to whoever was given one longest ago, open or handled, and nothing is written for it", async () => {
    const { ctx, tables } = seed({ extra: { decision_inbox: [
      { _id: "decision_inbox_s", decision_id: "session_decisions_x", user_id: SAM, status: "done", created_at: NOW - 1_000, status_at: NOW - 900 },
      { _id: "decision_inbox_j", decision_id: "session_decisions_y", user_id: JAS, status: "done", created_at: NOW - 5_000, status_at: NOW - 10 },
    ] } });
    const memberships = JSON.stringify(tables.team_memberships);
    const r = await ask(ctx, { task: "ct-1" });
    expect(askedOf(tables, r.id)).toEqual([JAS]);
    expect(JSON.stringify(tables.team_memberships)).toBe(memberships);
  });

  test("away members, members taking no decisions, and bots are skipped", async () => {
    const { ctx, tables } = seed();
    tables.users.find((u: any) => u._id === SAM).status = "away";
    for (let i = 0; i < 3; i++) {
      const r = await ask(ctx, { task: "ct-1" });
      expect(askedOf(tables, r.id)).toEqual([JAS]);
    }
    tables.team_memberships.find((m: any) => m._id === "m_jas").takes_decisions = false;
    const none = await ask(ctx, { task: "ct-1" });
    // Nobody left but the bot: the chain's people (the session's owner), never the bot.
    expect(askedOf(tables, none.id)).toEqual([HOST]);
  });

  test("a role scope's project, then the session's work, when there is no task", async () => {
    const { ctx, tables } = seed();
    const byRole = await ask(ctx, { session_id: "sess-role" });
    expect(askedOf(tables, byRole.id)).toEqual([KIM]);
    const bySession = await ask(ctx, { session_id: "sess-desk" });
    expect(askedOf(tables, bySession.id)).toEqual([KIM]);
  });

  test("the area owner is told, once, and the asker never", async () => {
    const { ctx, tables } = seed();
    const r = await ask(ctx, { task: "ct-2" });
    const notes = tables.notifications.filter((x: any) => x.type === "decision_assigned");
    expect(notes.map((x: any) => String(x.recipient_user_id))).toEqual([KIM]);
    expect(notes[0].link).toBe(`/decisions/${r.short_id}`);
  });

  test("a re-ask keeps its owner", async () => {
    const { ctx, tables } = seed();
    const first = await ask(ctx, { task: "ct-1", question: "Same?" });
    const owner = askedOf(tables, first.id)[0];
    const again = await askCore(ctx, { userId: HOST }, { session_id: "sess-ask", question: "Same?", options, category: "approach", task: "ct-1" });
    expect(again.updated).toBe(true);
    expect(askedOf(tables, first.id)).toEqual([owner]);
  });
});

describe("an ownership change", () => {
  test("keeps a decision with its area owner", async () => {
    const { ctx, tables } = seed();
    const r = await ask(ctx, { task: "ct-2" });
    expect(askedOf(tables, r.id)).toEqual([KIM]);
    tables.session_owners.push({ _id: "so_new", conversation_id: "conversations_ask", user_id: SAM, added_by: HOST, added_at: NOW });
    await reroutePendingDecisionsForConversation(ctx, "conversations_ask" as any, NOW);
    expect(askedOf(tables, r.id)).toEqual([KIM]);
    expect(row(tables, r.id).holder).toEqual({ kind: "user", id: KIM });
  });

  test("a decision nobody covers still follows the session's new owner", async () => {
    const { ctx, tables } = seed();
    const r = await ask(ctx, { task: "ct-3" });
    tables.session_owners.push({ _id: "so_new", conversation_id: "conversations_ask", user_id: SAM, added_by: HOST, added_at: NOW });
    await reroutePendingDecisionsForConversation(ctx, "conversations_ask" as any, NOW);
    expect(askedOf(tables, r.id)).toEqual([SAM]);
  });
});

describe("ask time: what keeps today's rules", () => {
  test("no member covers the project: the chain's people", async () => {
    const { ctx, tables } = seed();
    const r = await ask(ctx, { task: "ct-3" });
    expect(askedOf(tables, r.id)).toEqual([HOST]);
    expect(tables.notifications.filter((x: any) => x.type === "decision_assigned")).toEqual([]);
  });

  test("--to: the named people, marked addressed", async () => {
    const { ctx, tables } = seed();
    const r = await ask(ctx, { task: "ct-1", to: ["Kim"] });
    expect(askedOf(tables, r.id)).toEqual([KIM]);
    expect(row(tables, r.id).addressed).toBe(true);
  });

  test("a protected category keeps the chain", async () => {
    const { ctx, tables } = seed();
    const r = await ask(ctx, { task: "ct-1", question: "Deploy the migration to production now?" });
    expect(row(tables, r.id).category).toBe("production");
    expect(askedOf(tables, r.id)).toEqual([HOST]);
  });

  test("a private session's question is never shared out", async () => {
    const { ctx, tables } = seed();
    const r = await ask(ctx, { session_id: "sess-private", task: "ct-1" });
    expect(askedOf(tables, r.id)).toEqual([HOST]);
  });
});

describe("the admins' areas card", () => {
  const noAreas = () => {
    const s = seed({ team: { decision_areas: undefined }, memberships: [
      { _id: "m_host", user_id: HOST, team_id: TEAM, role: "admin", joined_at: NOW },
      { _id: "m_sam", user_id: SAM, team_id: TEAM, role: "admin", joined_at: NOW },
      { _id: "m_jas", user_id: JAS, team_id: TEAM, role: "member", joined_at: NOW },
      { _id: "m_bot", user_id: BOT, team_id: TEAM, role: "admin", joined_at: NOW },
    ] });
    // Kim leads Desk's role in this one; Samvit answered a Deals decision before.
    s.tables.org_roles[0].reports_to = { kind: "user", user_id: JAS };
    s.tables.session_decisions.push({ _id: "session_decisions_was", conversation_id: "conversations_ask", session_id: "sess-ask", user_id: HOST, question: "Earlier", options, status: "answered", answered_by: { kind: "user", id: SAM }, task_id: "tasks_deals", created_at: NOW - 100, team_id: TEAM });
    return s;
  };

  test("a workspace with no areas asks its admins once, proposing a split", async () => {
    const { ctx, tables, scheduled } = noAreas();
    const r = await ask(ctx, { task: "ct-1" });
    expect(askedOf(tables, r.id)).toEqual([HOST]);
    // The ask schedules the card; its own write holds only its question.
    expect(scheduled.map((s) => s.args)).toContainEqual({ team_id: TEAM, conversation_id: "conversations_ask" });
    expect(tables.session_decisions.filter((d: any) => d.question === AREAS_CARD_QUESTION)).toEqual([]);
    await askForAreas(ctx, TEAM, tables.conversations[0], NOW);
    await askForAreas(ctx, TEAM, tables.conversations[0], NOW + 1);
    const before = scheduled.length;
    await ask(ctx, { task: "ct-2" });
    expect(scheduled.slice(before).filter((s) => s.args?.conversation_id)).toEqual([]);
    const cards = tables.session_decisions.filter((d: any) => d.question === AREAS_CARD_QUESTION);
    expect(cards.length).toBe(1);
    expect(cards[0].asked_user_ids.map(String).sort()).toEqual([HOST, SAM].sort());
    expect(cards[0].silent).toBe(true);
    const proposal = tables.teams[0].decision_areas.proposal.map((a: any) => [String(a.user_id), a.project_ids.map(String)]);
    expect(proposal).toEqual(expect.arrayContaining([[SAM, [DEALS]], [JAS, [DESK]]]));
  });

  test("a solo team is never asked, and asks hold off for a day after the check", async () => {
    const { ctx, tables, scheduled } = seed({ team: { decision_areas: undefined }, memberships: [
      { _id: "m_host", user_id: HOST, team_id: TEAM, role: "admin", joined_at: NOW },
      { _id: "m_bot", user_id: BOT, team_id: TEAM, role: "admin", joined_at: NOW },
    ] });
    expect(await askForAreas(ctx, TEAM, tables.conversations[0], NOW)).toBeNull();
    expect(tables.teams[0].decision_areas.checked_at).toBe(NOW);
    await ask(ctx, { task: "ct-1" });
    expect(scheduled.filter((s) => s.args?.conversation_id)).toEqual([]);
    tables.teams[0].decision_areas.checked_at = Date.now() - AREAS_RECHECK_MS - 1;
    await ask(ctx, { task: "ct-1" });
    expect(scheduled.filter((s) => s.args?.conversation_id).length).toBe(1);
  });

  test("picking the split applies it", async () => {
    const { ctx, tables } = noAreas();
    const card = await askForAreas(ctx, TEAM, tables.conversations[0], NOW);
    const r = row(tables, card!);
    await finalizeAnswer(ctx, r, { status: "answered", answer_index: 0 }, { kind: "user", id: String(SAM), user_id: SAM }, { deliver: true });
    const focus = (id: string) => (tables.team_memberships.find((m: any) => m._id === id).focus_project_ids ?? []).map(String);
    expect(focus("m_sam")).toEqual([DEALS]);
    expect(focus("m_jas")).toEqual([DESK]);
    expect(tables.teams[0].decision_areas.set_at).toBeDefined();
    // Silent: nothing is sent into the asking session.
    expect(tables.pending_messages).toEqual([]);
  });

  test("an answer in their own words is mapped and applied", async () => {
    const { ctx, tables, scheduled } = noAreas();
    const card = await askForAreas(ctx, TEAM, tables.conversations[0], NOW);
    await finalizeAnswer(ctx, row(tables, card!), { status: "answered", answer_text: "Samvit: deals; Jason: desk" }, { kind: "user", id: String(HOST), user_id: HOST }, { deliver: true });
    expect(scheduled.map((s) => s.args)).toContainEqual({ user_id: HOST, team_id: TEAM, words: "Samvit: deals; Jason: desk" });
  });

  test("leaving areas unset stops the card from coming back", async () => {
    const { ctx, tables } = noAreas();
    const card = await askForAreas(ctx, TEAM, tables.conversations[0], NOW);
    await finalizeAnswer(ctx, row(tables, card!), { status: "answered", answer_index: 1 }, { kind: "user", id: String(HOST), user_id: HOST }, { deliver: true });
    expect(tables.teams[0].decision_areas.declined_at).toBeDefined();
    expect(await askForAreas(ctx, TEAM, tables.conversations[0], NOW + 1)).toBeNull();
  });
});

describe("Share out", () => {
  const backlog = () => {
    const s = seed();
    const open = (id: string, over: any = {}) => ({
      _id: id, conversation_id: "conversations_ask", session_id: "sess-ask", user_id: HOST, question: id, options, status: "pending", category: "approach",
      holder: { kind: "user", id: HOST }, holder_key: `user:${HOST}`, asked_user_ids: [HOST], task_id: "tasks_deals", team_id: TEAM, created_at: NOW - 100, ...over,
    });
    s.tables.session_decisions.push(
      open("session_decisions_a", { created_at: NOW - 400 }),
      open("session_decisions_b", { created_at: NOW - 300 }),
      open("session_decisions_c", { created_at: NOW - 200, task_id: "tasks_desk" }),
      open("session_decisions_loose", { task_id: "tasks_loose" }),
      open("session_decisions_named", { addressed: true }),
      open("session_decisions_prod", { category: "production" }),
    );
    return s;
  };

  test("the preview names who gets what, moves nothing, and apply does exactly that", async () => {
    const { ctx, tables } = backlog();
    const before = JSON.stringify(tables.session_decisions);
    const preview = await shareOutPreviewCore(ctx, HOST, TEAM, NOW);
    if ("error" in preview) throw new Error(preview.error);
    expect(JSON.stringify(tables.session_decisions)).toBe(before);
    expect(preview.moves.map((m) => m.decision_id).sort()).toEqual(["session_decisions_a", "session_decisions_b", "session_decisions_c"]);
    expect(preview.unmatched).toBe(1);
    expect(preview.to.reduce((s, t) => s + t.count, 0)).toBe(3);
    // Deals splits between its two people; Desk goes to Kim.
    const toOf = (id: string) => preview.moves.find((m) => m.decision_id === id)!.to;
    expect(new Set([toOf("session_decisions_a"), toOf("session_decisions_b")])).toEqual(new Set([SAM, JAS]));
    expect(toOf("session_decisions_c")).toBe(KIM);

    const done = await shareOutCore(ctx, HOST, TEAM, preview.moves, NOW);
    expect(done).toEqual({ moved: 3, skipped: 0 });
    for (const m of preview.moves) {
      expect(askedOf(tables, m.decision_id)).toEqual([m.to]);
      expect(row(tables, m.decision_id).holder_key).toBe(`user:${m.to}`);
    }
    for (const kept of ["session_decisions_loose", "session_decisions_named", "session_decisions_prod"]) expect(askedOf(tables, kept)).toEqual([HOST]);
    // One notice per person.
    const notes = tables.notifications.filter((x: any) => x.type === "decision_assigned");
    expect(notes.map((x: any) => String(x.recipient_user_id)).sort()).toEqual([JAS, KIM, SAM].sort());
  });

  test("a decision passed since the preview stays where it was passed", async () => {
    const { ctx, tables } = backlog();
    const preview = await shareOutPreviewCore(ctx, HOST, TEAM, NOW);
    if ("error" in preview) throw new Error(preview.error);
    await passCore(ctx, HOST, "session_decisions_c", { kind: "user", id: String(SAM) });
    const done = await shareOutCore(ctx, HOST, TEAM, preview.moves, NOW);
    if ("error" in done) throw new Error(done.error);
    expect(done.skipped).toBeGreaterThanOrEqual(1);
    expect(askedOf(tables, "session_decisions_c")).toEqual([SAM]);
  });

  test("only an admin shares out", async () => {
    const { ctx } = backlog();
    expect(await shareOutPreviewCore(ctx, SAM, TEAM, NOW)).toEqual({ error: "Only a team admin shares decisions out" });
    expect(await shareOutCore(ctx, SAM, TEAM, [], NOW)).toEqual({ error: "Only a team admin shares decisions out" });
  });
});
