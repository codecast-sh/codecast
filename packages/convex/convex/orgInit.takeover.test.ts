import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { applyAdopt, applyRole, applyScope, previewTakeover, previewTakeovers, takeOverSessions, takeoverPhrase } from "./orgInit";
import { performCreateRole, performHireRole, performRetireRole, performUpdateRole } from "./orgRoles";
import { lineCandidates } from "./orgLine";
import { projectLeadOf } from "@codecast/shared/contracts/orgLead";

// Taking over a scope takes over its sessions (org-roles-run-work.md R1): the
// apply that gives a role a scope files the host's unowned sessions in it
// under the role, and the note says so before and after.

const ME = "u".repeat(31) + "m"; // team admin, the host
const MATE = "u".repeat(31) + "t";
const TEAM = "teams_acme" as any;
const WS = `team:${TEAM}`;
const NOW = 1_800_000_000_000;
const P = "projects_p";

const conv = (n: number, over: Record<string, any> = {}) => ({
  _id: `conversations_s${n}`,
  short_id: `jx7000${n}`,
  user_id: ME,
  team_id: TEAM,
  status: "active",
  agent_type: "claude_code",
  title: `Growth work ${n}`,
  project_path: "/repo/growth",
  message_count: 3,
  last_message_role: "assistant",
  updated_at: NOW - 60_000,
  created_at: 1,
  ...over,
});

function fixtures() {
  return makeFakeDb({
    users: [{ _id: ME, name: "Me", email: "me@x.ai" }, { _id: MATE, name: "Mate", email: "mate@x.ai" }],
    team_memberships: [
      { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "member", joined_at: 1 },
    ],
    teams: [{ _id: TEAM, name: "Acme" }],
    counters: [],
    org_roles: [],
    org_role_history: [],
    anchors: [],
    projects: [
      { _id: P, user_id: ME, team_id: TEAM, workspace: WS, short_id: "pr-1", title: "Growth", status: "active", project_path: "/repo/growth", created_at: 1, updated_at: NOW },
      { _id: "projects_q", user_id: ME, team_id: TEAM, workspace: WS, short_id: "pr-2", title: "Billing", status: "active", project_path: "/repo/billing", created_at: 1, updated_at: NOW },
    ],
    plans: [],
    tasks: [],
    docs: [],
    conversations: [
      conv(1),
      conv(2),
      conv(3, { user_id: MATE }), // a teammate's session on the same path: stays theirs
      conv(4, { project_path: "/repo/billing" }), // the host's, outside the scope: stays
    ],
    session_owners: [],
    session_decisions: [],
    managed_sessions: [],
    messages: [],
    user_presence: [],
    pending_messages: [],
    devices: [],
  });
}

const ctxOf = (db: any) => ({ db }) as any;
const BOUNDARY = { team_id: TEAM };
const OPTS = { provision: false, human_decision: "sd-1" };
const roleOf = (db: any, n: number) => db._tables.conversations.find((c: any) => c._id === `conversations_s${n}`).org_role_id;

describe("a scope change takes over the sessions in it", () => {
  test("the note before accept and the note after apply say the same thing; the rows moved", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    // A role with no projects looks after the whole workspace and takes nothing.
    const role = await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM });
    expect(await takeOverSessions(ctx, ME as any, role._id)).toBeNull();

    const res = await applyScope(ctx, ME as any, BOUNDARY, { kind: "scope", handle: "@growth", add: ["pr-1"] }, OPTS);
    expect(res.status).toBe("applied");
    const note = (res as any).note as string;
    expect(note).toContain("2 sessions now report to @growth and leave your needs input");
    expect(note).toMatch(/\d told now/);
    expect(roleOf(db, 1)).toBe(role._id);
    expect(roleOf(db, 2)).toBe(role._id);
    expect(roleOf(db, 3)).toBeUndefined();
    expect(roleOf(db, 4)).toBeUndefined();
    // Each moved session was told once, through the reparent core's line.
    const told = db._tables.pending_messages.filter((m: any) => String(m.content).includes("You now report to Growth."));
    expect(told.length).toBe(2);
  });

  test("the dry count is the sentence a person reads before accepting, and writes nothing", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const role = await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM, scope: { project_ids: [P as any], plan_ids: [] } });
    const dry = await takeOverSessions(ctx, ME as any, role._id, { dry: true });
    expect(takeoverPhrase("growth", dry, false)).toBe("2 sessions now report to @growth and leave your needs input");
    expect(roleOf(db, 1)).toBeUndefined();
    expect(db._tables.pending_messages.length).toBe(0);
  });

  test("a proposed role has no row yet: the preview reads its scope, with the person applying as the host", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const r = await previewTakeover(ctx, ME as any, BOUNDARY, { handle: "@growth", add: ["pr-1"] });
    expect([...(r?.sessions ?? [])].sort()).toEqual(["jx70001", "jx70002"]);
    // A live role that gains a ref counts only what would newly move.
    const role = await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM, scope: { project_ids: [P as any], plan_ids: [] } });
    await takeOverSessions(ctx, ME as any, role._id);
    const next = await previewTakeover(ctx, ME as any, BOUNDARY, { handle: "@growth", add: ["pr-2"] });
    expect(next?.sessions).toEqual(["jx70004"]);
    expect(db._tables.conversations.find((c: any) => c.short_id === "jx70004").org_role_id).toBeUndefined();
  });

  test("leave_sessions is the person's one edit: the scope lands and the sessions stay", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM });
    const res = await applyScope(ctx, ME as any, BOUNDARY, { kind: "scope", handle: "@growth", add: ["pr-1"], leave_sessions: true }, OPTS);
    expect((res as any).note).not.toContain("now report");
    expect(roleOf(db, 1)).toBeUndefined();
  });

  test("a new role with projects takes over on create", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const res = await applyRole(ctx, ME as any, BOUNDARY, { kind: "role", name: "Growth", handle: "growth", scope: { projects: ["pr-1"] } } as any, undefined, OPTS);
    expect((res as any).note).toContain("2 sessions now report to @growth");
    expect(roleOf(db, 1)).toBeDefined();
  });
});

// Nothing waiting on the person is lost in a takeover (ct-55574).
describe("a takeover and the sessions that wait", () => {
  test("a role whose seat is an adopt in the same proposal takes over nothing until the adopt seats it", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const res = await applyRole(ctx, ME as any, BOUNDARY, { kind: "role", name: "Growth", handle: "growth", scope: { projects: ["pr-1"] } } as any, undefined, { ...OPTS, provision: true, awaiting_adopt: "jx70001" });
    expect((res as any).note).not.toContain("now report");
    // The session to adopt is still nobody's hand, so the adopt can seat it.
    expect(roleOf(db, 1)).toBeUndefined();
    const adopted = await applyAdopt(ctx, ME as any, BOUNDARY, { kind: "adopt", handle: "@growth", conversation: "jx70001" } as any, OPTS as any);
    expect([adopted.status, (adopted as any).error]).toEqual(["applied", undefined]);
    expect((adopted as any).note).toContain("1 session now reports to @growth");
    const seat = db._tables.conversations.find((c: any) => c._id === "conversations_s1");
    expect(String(seat.standing_role_id)).toBe((res as any).role.id);
    expect(roleOf(db, 2)).toBe((res as any).role.id);
  });

  test("done and killed sessions stay where they are; every session that moves has its needs-input check run again", async () => {
    const db = fixtures();
    db._tables.conversations.push(
      conv(5, { thread_state: "Shipped", thread_state_status: "done", thread_state_at: Date.now(), updated_at: Date.now() - 60_000 }),
      conv(6, { inbox_killed_at: NOW }),
    );
    const scheduled: any[] = [];
    const ctx = { db, scheduler: { runAfter: async (...a: any[]) => { scheduled.push(a); } } } as any;
    const role = await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM, scope: { project_ids: [P as any], plan_ids: [] } });
    const dry = await takeOverSessions(ctx, ME as any, role._id, { dry: true });
    expect([...(dry?.sessions ?? [])].sort()).toEqual(["jx70001", "jx70002"]);
    expect(scheduled).toEqual([]);
    const took = await takeOverSessions(ctx, ME as any, role._id);
    expect([...(took?.sessions ?? [])].sort()).toEqual(["jx70001", "jx70002"]);
    expect(roleOf(db, 5)).toBeUndefined();
    expect(roleOf(db, 6)).toBeUndefined();
    // A moved session that waits is heard by its role: the same check a
    // settle runs, which tells the role or, when it cannot be told, the person.
    expect(scheduled.map((a) => [a[0], a[2]]).sort((x, y) => String(x[1].conversation_id).localeCompare(String(y[1].conversation_id)))).toEqual([
      [0, { conversation_id: "conversations_s1" }],
      [0, { conversation_id: "conversations_s2" }],
    ]);
  });
});

// Every door that widens a live role's scope goes through the one role update
// (performUpdateRole), so the takeover and the person's one edit live there:
// the editor in Settings, `cast role scope`, a project's lead, a move.
describe("the role update is the one place a live role takes over", () => {
  const HUMAN = { human_decision: "sd-1" };

  test("a scope that gains a project takes over its sessions, and the answer carries the sentence", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const role = await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM, scope: { project_ids: ["projects_q" as any], plan_ids: [] } });
    const updated = await performUpdateRole(ctx, ME as any, { role_id: String(role._id), scope: { project_ids: ["projects_q" as any, P as any], plan_ids: [] }, ...HUMAN });
    // Three: the two on the gained project, and the one on the project the
    // role already had. The takeover reads the role's whole scope, and a bare
    // performCreateRole (no hire, no apply) had moved nothing for it.
    expect(updated.took_over.phrase).toContain("3 sessions now report to @growth and leave your needs input");
    expect(roleOf(db, 1)).toBe(role._id);
    expect(roleOf(db, 2)).toBe(role._id);
    expect(roleOf(db, 4)).toBe(role._id);
    expect(roleOf(db, 3)).toBeUndefined(); // a teammate's, on the same path
  });

  test("leave_sessions lands the scope and moves nothing", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const role = await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM, scope: { project_ids: ["projects_q" as any], plan_ids: [] } });
    const updated = await performUpdateRole(ctx, ME as any, { role_id: String(role._id), scope: { project_ids: ["projects_q" as any, P as any], plan_ids: [] }, leave_sessions: true, ...HUMAN });
    expect(updated.scope.project_ids.map(String)).toEqual(["projects_q", P]);
    expect(updated.took_over).toBeUndefined();
    expect(roleOf(db, 1)).toBeUndefined();
  });

  test("a scope that only loses a project, or an edit that names no scope, takes nothing", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const role = await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM, scope: { project_ids: [P as any, "projects_q" as any], plan_ids: [] } });
    const narrowed = await performUpdateRole(ctx, ME as any, { role_id: String(role._id), scope: { project_ids: [P as any], plan_ids: [] }, ...HUMAN });
    expect(narrowed.took_over).toBeUndefined();
    const renamed = await performUpdateRole(ctx, ME as any, { role_id: String(role._id), name: "Growth lead" });
    expect(renamed.took_over).toBeUndefined();
    expect(roleOf(db, 1)).toBeUndefined();
  });
});

describe("a hire with projects is a role that gains scope", () => {
  test("the hire takes over, after the seat exists; leave_sessions is the person's one edit on it", async () => {
    const db = fixtures();
    const hired = await performHireRole(ctxOf(db), ME as any, { name: "Growth", handle: "growth", team_id: TEAM, scope: { project_ids: [P as any], plan_ids: [] } });
    expect(hired.took_over.phrase).toContain("2 sessions now report to @growth");
    expect(roleOf(db, 1)).toBe(hired._id);

    const left = fixtures();
    const quiet = await performHireRole(ctxOf(left), ME as any, { name: "Growth", handle: "growth", team_id: TEAM, scope: { project_ids: [P as any], plan_ids: [] } }, { leave_sessions: true });
    expect(quiet.took_over).toBeUndefined();
    expect(roleOf(left, 1)).toBeUndefined();
  });
});

// The read budget (W7 review, finding 7). The backend refuses a function past
// 4,096 reads, every db.get and db.query counting as one. Counted here on the
// fake db at the size the brief names: one project with 860 tasks that other
// people filed and 440 sessions on its path, 100 of them movable.
describe("the read budget of a takeover", () => {
  function unionSized() {
    const tasks = Array.from({ length: 860 }, (_, i) => ({ _id: `tasks_${i}`, short_id: `ct-${i}`, user_id: MATE, team_id: TEAM, workspace: WS, project_id: P, title: `t${i}`, status: "open", created_at: 1, updated_at: Date.now() }));
    const conversations = Array.from({ length: 440 }, (_, i) => conv(i, { _id: `conversations_${i}`, short_id: `jx7${String(i).padStart(4, "0")}`, title: `s${i}`, updated_at: Date.now() - 60_000 - i }));
    const db: any = fixtures();
    db._tables.tasks.push(...tasks);
    db._tables.conversations.length = 0;
    db._tables.conversations.push(...conversations);
    return db;
  }
  function counting(db: any) {
    const reads = { n: 0, by: {} as Record<string, number> };
    const counted = new Proxy(db, { get: (t, k) => (k === "get" || k === "query" ? (...a: any[]) => { reads.n++; if (k === "query") reads.by[a[0]] = (reads.by[a[0]] ?? 0) + 1; return t[k](...a); } : t[k]) });
    return { ctx: { db: counted } as any, reads };
  }

  test("one takeover on a Union sized scope stays far under the 4,096 read limit, dry and applied", async () => {
    const db = unionSized();
    const role = await performCreateRole({ db } as any, ME as any, { name: "Growth", handle: "growth", team_id: TEAM, scope: { project_ids: [P as any], plan_ids: [] } });
    const { ctx, reads } = counting(db);
    await takeOverSessions(ctx, ME as any, role._id, { dry: true });
    const dry = reads.n;
    // The membership set is read once for the whole scope, never once per task
    // (it was 861 of the dry count's 973 reads).
    expect(reads.by.team_memberships).toBeLessThanOrEqual(4);
    const took = await takeOverSessions(ctx, ME as any, role._id);
    const apply = reads.n - dry;
    expect(took?.sessions.length).toBe(100);
    expect(took?.over_cap).toBe(340);
    // About one read a candidate for the dry count (its open question), and
    // under ten a session moved: the role, the admin check, the acting person
    // and the sender are resolved once for the batch. Was 973 and 2,573.
    expect(dry).toBeLessThan(150);
    expect(apply).toBeLessThan(1000);
    // Accept all keeps one takeover change to a transaction (acceptAllChunk),
    // and even two of this size would fit the limit now.
    expect(apply * 2).toBeLessThan(4096);
  });

  test("a page's previews share one scan of the workspace's sessions, however many rows ask", async () => {
    const one = counting(unionSized());
    await previewTakeovers(one.ctx, ME as any, BOUNDARY, [{ handle: "@growth", add: ["pr-1"] }]);
    const many = counting(unionSized());
    const out = await previewTakeovers(many.ctx, ME as any, BOUNDARY, [{ handle: "@growth", add: ["pr-1"] }, { handle: "@billing", add: ["pr-2"] }, { handle: "@ops", add: ["pr-1", "pr-2"] }]);
    expect(out.map((r) => r?.sessions.length ?? 0)).toEqual([100, 0, 100]);
    expect(out[0]?.phrase).toContain("100 sessions now report to @growth");
    expect(many.reads.by.conversations).toBe(one.reads.by.conversations);
    expect(many.reads.by.org_roles).toBe(one.reads.by.org_roles);
  });
});

// Work belongs to the most specific role that covers it (org-staffing.md S26).
// A head of people over the whole workspace plus one lead over Growth: the
// lead's sessions, tasks and project are the lead's, the rest the Head of People's;
// retire the lead and they fall back.
describe("a Head of People plus one lead: ownership by specificity", () => {
  async function headWithWork() {
    const db = fixtures();
    const ctx = ctxOf(db);
    const head = await performCreateRole(ctx, ME as any, { name: "Head of People", handle: "head-of-people", team_id: TEAM });
    // Two of the Head of People's sessions, one in Growth and one in Billing, beside the
    // host's own Growth sessions (s1, s2) and Billing one (s4).
    db._tables.conversations.push(
      conv(5, { org_role_id: head._id }),
      conv(6, { org_role_id: head._id, project_path: "/repo/billing" }),
    );
    const task = (id: string, over: Record<string, any>) => ({ _id: id, short_id: id, title: id, user_id: ME, team_id: TEAM, workspace: WS, status: "open", assignee: String(head._id), created_at: 1, updated_at: NOW, ...over });
    db._tables.tasks.push(task("tasks_growth", { project_id: P }), task("tasks_billing", { project_id: "projects_q" }), task("tasks_loose", {}));
    db._tables.workflows = [];
    db._tables.task_history = [];
    db._tables.entity_subscriptions = [];
    return { db, ctx, head };
  }
  const hireGrowth = (ctx: any) => performHireRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM, scope: { project_ids: [P as any], plan_ids: [] } }, { provision: false });

  test("the lead takes its area from the Head of People and from the person; the Head of People keeps the rest and takes nothing itself", async () => {
    const { db, ctx, head } = await headWithWork();
    // A whole workspace role takes over nothing on its own.
    expect(await takeOverSessions(ctx, ME as any, head._id)).toBeNull();
    const dry = await previewTakeover(ctx, ME as any, BOUNDARY, { handle: "@growth", add: ["pr-1"] });
    expect([...(dry?.sessions ?? [])].sort()).toEqual(["jx70001", "jx70002", "jx70005"]);
    const growth = await hireGrowth(ctx);
    expect([...growth.took_over.sessions].sort()).toEqual(["jx70001", "jx70002", "jx70005"]);
    expect(roleOf(db, 5)).toBe(growth._id);
    expect(roleOf(db, 6)).toBe(head._id);
    expect(roleOf(db, 4)).toBeUndefined();
  });

  test("the project, the line's pick and a retire all follow the rule, and the area falls back", async () => {
    const { db, ctx, head } = await headWithWork();
    const growth = await hireGrowth(ctx);
    const roles = () => db._tables.org_roles;
    const project = (id: string) => db._tables.projects.find((p: any) => p._id === id);
    expect(projectLeadOf(project(P), roles())).toMatchObject({ kind: "lead", role: { _id: growth._id }, by: "scope" });
    expect(projectLeadOf(project("projects_q"), roles())).toMatchObject({ kind: "lead", role: { _id: head._id }, by: "workspace" });
    // The Head of People's line never starts what the lead owns.
    expect((await lineCandidates(ctx, await db.get(head._id))).map((t: any) => t._id).sort()).toEqual(["tasks_billing", "tasks_loose"]);
    // The Head of People's open task in Growth moved to the lead in the same takeover, with a history row.
    const growthTask = () => db._tables.tasks.find((t: any) => t._id === "tasks_growth");
    expect(growthTask().assignee).toBe(String(growth._id));
    expect(db._tables.task_history.filter((h: any) => h.task_id === "tasks_growth")).toEqual([expect.objectContaining({ field: "assignee", old_value: String(head._id), new_value: String(growth._id) })]);
    expect(db._tables.tasks.find((t: any) => t._id === "tasks_billing").assignee).toBe(String(head._id));
    expect((await lineCandidates(ctx, await db.get(growth._id))).map((t: any) => t._id)).toEqual(["tasks_growth"]);
    // The lead's task and sessions fall back to the Head of People, not to the person it reports to.
    await performRetireRole(ctx, ME as any, { role_id: growth._id });
    expect(projectLeadOf(project(P), roles())).toMatchObject({ kind: "lead", role: { _id: head._id }, by: "workspace" });
    expect(db._tables.tasks.find((t: any) => t._id === "tasks_growth").assignee).toBe(String(head._id));
    expect(roleOf(db, 1)).toBe(head._id);
    expect(roleOf(db, 5)).toBe(head._id);
    expect(roleOf(db, 6)).toBe(head._id);
    expect((await lineCandidates(ctx, await db.get(head._id))).map((t: any) => t._id).sort()).toEqual(["tasks_billing", "tasks_growth", "tasks_loose"]);
  });

  test("with no wider role a retired lead's sessions go back to their owner and its tasks up the chain", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const growth = await hireGrowth(ctx);
    expect(roleOf(db, 1)).toBe(growth._id);
    await performRetireRole(ctx, ME as any, { role_id: growth._id });
    expect(roleOf(db, 1)).toBeUndefined();
  });

  test("a lead that reports to the person is not held inside the Head of People's scope, nor is one under the Head of People", async () => {
    const { ctx, head } = await headWithWork();
    const growth = await hireGrowth(ctx);
    expect(growth.reports_to).toEqual({ kind: "user", user_id: ME });
    const widened = await performUpdateRole(ctx, ME as any, { role_id: growth._id, scope: { project_ids: [P as any, "projects_q" as any], plan_ids: [] }, leave_sessions: true, human_decision: "sd-1" }).catch((e: any) => e.message);
    expect(widened.scope?.project_ids ?? widened).toEqual([P, "projects_q"]);
    const billing = await performCreateRole(ctx, ME as any, { name: "Billing", handle: "billing", team_id: TEAM, reports_to: { kind: "role", role_id: head._id }, scope: { project_ids: ["projects_q" as any], plan_ids: [] } });
    expect(billing.scope.project_ids).toEqual(["projects_q"]);
  });
});
