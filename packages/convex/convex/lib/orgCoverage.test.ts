import { describe, expect, test } from "bun:test";
import { computeCoverage, computeUnplaced, withUnplaced, type CoverageInputs, type UnplacedInputs } from "./orgCoverage";

// Coverage (docs/architecture/initiatives-projects-role-page.md I1, I2): pure
// over rows, so the before count the analyzer states, the work outside any
// project and the initiative's own gaps are asserted with plain fixtures.

const role = (id: string, handle: string, project_ids: string[] = [], extra: Record<string, unknown> = {}) =>
  ({ _id: id, handle, status: "active", scope: { project_ids, plan_ids: [] }, reports_to: { kind: "user" }, ...extra });

const base = (over: Partial<CoverageInputs> = {}): CoverageInputs => ({
  projects: [
    { _id: "p_growth", short_id: "pj-1", title: "Growth", status: "active" },
    { _id: "p_platform", short_id: "pj-2", title: "Platform", status: "active", owner_role_id: "r_platform" },
    { _id: "p_brand", short_id: "pj-3", title: "Brand", status: "active" },
    { _id: "p_idle", short_id: "pj-4", title: "Nothing open", status: "active" },
    { _id: "p_paused", short_id: "pj-5", title: "Paused", status: "paused" },
  ],
  plans: [
    { _id: "pl_a", short_id: "pl-1", title: "Pricing page", status: "active", project_id: "p_brand" },
    { _id: "pl_loose", short_id: "pl-2", title: "Loose plan", status: "active" },
    { _id: "pl_idea", short_id: "pl-3", title: "An idea with no tasks", status: "draft" },
    { _id: "pl_closed", short_id: "pl-4", title: "Closed and loose", status: "done" },
  ],
  tasks: [
    { status: "open", project_id: "p_growth", source: "human" },
    { status: "in_progress", project_id: "p_platform", source: "human" },
    { status: "done", project_id: "p_idle", source: "human" },
    { status: "open", project_id: "p_paused", source: "human" },
    { status: "open", plan_id: "pl_loose", source: "meeting" },
    { status: "open", plan_id: "pl_closed", source: "human" },
    { status: "open", source: "human" },
    { status: "dropped", source: "human" },
    // Off the board (isOnProjectBoard): an agent's own task, its suggestion,
    // an unpromoted insight, a dismissed row. None is work to cover, on a
    // project, a plan or loose, so the counts here match the page's.
    { status: "open", project_id: "p_growth", source: "agent" },
    { status: "open", project_id: "p_growth", source: "agent", triage_status: "suggested" },
    { status: "open", project_id: "p_idle", source: "insight" },
    { status: "open", plan_id: "pl_loose", source: "agent", triage_status: "dismissed" },
    { status: "open", source: "agent" },
    // On the board although an agent filed them: promoted, or assigned to someone.
    { status: "open", project_id: "p_platform", source: "agent", promoted: true },
    { status: "open", project_id: "p_platform", source: "agent", assignee: "u_ada" },
  ],
  roles: [role("r_platform", "platform"), role("r_a", "design", ["p_brand"]), role("r_b", "marketing", ["p_brand"]), role("r_root", "head-of-people")],
  areas: [
    { repository: "acme/app", path_prefix: "packages/web", commits_30d: 40, authors: [], sessions_30d: 12, project_id: "p_platform" },
    { repository: "acme/tools", path_prefix: "", commits_30d: 9, authors: [], sessions_30d: 3 },
    { repository: "acme/old", path_prefix: "", commits_30d: 0, authors: [], sessions_30d: 0 },
  ],
  initiatives: [],
  ...over,
});

describe("coverage", () => {
  test("counts the active projects with work and names each lead by the one rule", () => {
    const c = computeCoverage(base());
    // An open task or an open plan is work; a project with neither, or a paused one, is not a seat to fill.
    expect(c.projects.map((p) => p.title)).toEqual(["Growth", "Platform", "Brand"]);
    expect([c.with_lead, c.with_work]).toEqual([1, 3]);
    // The counts are the board's: Growth's agent rows do not count, and
    // Platform's promoted and assigned ones do.
    expect(c.projects[0]).toMatchObject({ open_tasks: 1, open_plans: 0, initiatives: [] });
    expect(c.projects[0].lead).toBeUndefined();
    expect(c.projects[1]).toMatchObject({ lead: "@platform", lead_by: "owner", open_tasks: 3 });
    // Two roles on separate lines list Brand and it names neither: watched, not led.
    expect(c.projects[2]).toMatchObject({ watchers: ["@design", "@marketing"], open_plans: 1 });
    expect(c.projects[2].lead).toBeUndefined();
  });

  test("a paused lead is not a lead: the project counts as without one and names the paused role", () => {
    const c = computeCoverage(base({ roles: [role("r_platform", "platform", [], { status: "paused" }), role("r_root", "head-of-people")] }));
    expect([c.with_lead, c.with_lead_paused, c.with_work]).toEqual([0, 1, 3]);
    expect(c.projects[1]).toMatchObject({ lead_paused: "@platform", lead_by: "owner" });
    expect(c.projects[1].lead).toBeUndefined();
  });

  test("a whole workspace role holds the remainder, which coverage still lists as without a lead", () => {
    const c = computeCoverage(base({ roles: [role("r_root", "head-of-people")] }));
    expect([c.with_lead, c.with_work]).toEqual([0, 3]);
  });

  test("lists the work outside any project: open plans with none, loose tasks, areas that resolved to none", () => {
    const { outside } = computeCoverage(base());
    // A plan with no tasks is an idea, and a closed plan is history: neither is work to cover.
    expect(outside.plans).toEqual([{ short_id: "pl-2", title: "Loose plan", open_tasks: 1 }]);
    expect(outside.open_tasks).toBe(1);
    expect(outside.areas).toEqual([{ repository: "acme/tools", path_prefix: "", commits_30d: 9, sessions_30d: 3 }]);
  });

  test("reads an initiative from the top down: its owner, its health, and which of its projects have no lead", () => {
    const c = computeCoverage(base({
      userNames: { u_ada: "Ada" },
      initiatives: [
        { _id: "i_done", short_id: "in-1", title: "Shipped", status: "completed", health: "on_track", project_ids: ["p_growth"] },
        { _id: "i_plan", short_id: "in-2", title: "Next year", status: "planned", health: "none", owner: { kind: "user", user_id: "u_ada" }, project_ids: [] },
        { _id: "i_launch", short_id: "in-3", title: "Launch", status: "active", health: "at_risk", health_at: 5, target_date: 9, project_ids: ["p_growth", "p_platform", "p_idle", "p_gone"], parent_initiative_id: "i_plan" },
        { _id: "i_retired", short_id: "in-4", title: "Owned by a retired role", status: "active", health: "none", owner: { kind: "role", role_id: "r_old" }, project_ids: [] },
        { _id: "i_led", short_id: "in-5", title: "Driven", status: "active", health: "on_track", owner: { kind: "role", role_id: "r_platform" }, project_ids: ["p_platform"] },
      ],
      roles: [...base().roles, role("r_old", "old", [], { status: "retired" })],
    }));
    // Closed initiatives are left out; active ones come first.
    expect(c.initiatives.map((i) => i.short_id)).toEqual(["in-3", "in-4", "in-5", "in-2"]);
    expect([c.active_initiatives, c.active_without_owner]).toEqual([3, 2]);
    const launch = c.initiatives[0];
    expect(launch).toMatchObject({ health: "at_risk", health_at: 5, target_date: 9, parent: "in-2", projects_without_lead: 1 });
    expect(launch.owner).toBeUndefined();
    // A project the viewer cannot read is dropped; one with no work is listed and asks for no lead.
    expect(launch.projects.map((p) => [p.title, p.has_work, p.lead])).toEqual([["Growth", true, undefined], ["Platform", true, "@platform"], ["Nothing open", false, undefined]]);
    expect(c.initiatives[1].owner).toBeUndefined();
    expect(c.initiatives[2].owner).toEqual({ kind: "role", handle: "@platform" });
    expect(c.initiatives[3].owner).toEqual({ kind: "user", name: "Ada" });
    // A project says which open initiatives it serves, and never a closed one.
    expect(c.projects.find((p) => p.title === "Growth")!.initiatives).toEqual(["in-3"]);
    expect(c.projects.find((p) => p.title === "Platform")!.initiatives).toEqual(["in-3", "in-5"]);
  });

  // The intent record (I5): the review reads why, what done looks like, the
  // next milestone, which way each number moves, and every entry the record
  // already holds (milestones, questions, decisions, sources), so it can say
  // what a goal still lacks and never proposes what is there.
  test("reads a goal's record: why, done when, the next milestone, trends and every entry it holds", () => {
    const score = (value: string, observed_at: number) => ({ value, observed_at, source: "https://x.test/board" });
    const c = computeCoverage(base({
      initiatives: [
        {
          _id: "i_rec", short_id: "in-7", title: "Reach 1k teams", status: "active", health: "on_track", project_ids: [],
          why: "  Teams that run an agent weekly stay.  ", done_when: "A thousand teams ran an agent in one week.",
          metrics: [{ key: "teams", name: "Weekly active teams", target: "1000" }, { key: "churn", name: "Churn", target: "under 5%" }, { key: "nps", name: "NPS", target: "50" }],
          scoreboard: { teams: score("412", 3), churn: score("7%", 3) },
          score_history: { teams: [score("380", 1), score("400", 2), score("412", 3)], churn: [score("6%", 1), score("7%", 3)], nps: [score("41", 1)] },
          milestones: [{ key: "ga", title: "General availability" }, { key: "beta", title: "Private beta open", date: 20 }, { key: "alpha", title: "Alpha", date: 10, done_at: 11 }],
          questions: [{ key: "price", text: "Do we price per seat?", at: 1 }, { key: "who", text: "Who signs?", at: 2, answer: "Ada", answered_at: 3 }],
          decisions: [{ key: "brokers", text: "  Ship to brokers first  ", at: 4 }, { key: "long", text: "x".repeat(900), at: 5 }],
          sources: [{ kind: "call", ref: "cl-42:14", quote: "our goal is a thousand teams" }, { kind: "task", ref: "ct-12" }, { kind: "link", ref: "https://x.test/plan" }, { kind: "note", quote: "a thousand teams" }],
        },
        { _id: "i_bare", short_id: "in-8", title: "Bare", status: "active", health: "none", project_ids: [], milestones: [{ key: "done", title: "Done", done_at: 5 }] },
      ],
    }));
    const [rec, bare] = c.initiatives;
    expect(rec).toMatchObject({
      why: "Teams that run an agent weekly stay.", done_when: "A thousand teams ran an agent in one week.",
      next_milestone: { title: "Private beta open", date: 20 },
      milestones: [{ title: "Alpha", date: 10, done: true }, { title: "Private beta open", date: 20 }, { title: "General availability" }],
      open_questions: ["Do we price per seat?"],
      answered_questions: ["Who signs?"],
      // A long entry is cut to what is enough to recognize it.
      decisions: ["Ship to brokers first", "x".repeat(200)],
      // Each source as the address a change would write for it, a note by its words.
      sources: ["call:cl-42:14", "ct-12", "https://x.test/plan", "a thousand teams"],
    });
    // A direction is read against the target's own: churn going up is away from "under 5%". One report is no trend.
    expect(rec.trends).toEqual({ teams: "up from 380, toward the target", churn: "up from 6, away from the target" });
    // A goal with no record says so with absences and empties, never a guess.
    expect(bare).toMatchObject({ trends: {}, milestones: [{ title: "Done", done: true }], open_questions: [], answered_questions: [], decisions: [], sources: [] });
    expect([bare.why, bare.done_when, bare.next_milestone]).toEqual([undefined, undefined, undefined]);
  });
});

describe("open plans under a goal's projects (ct-95899)", () => {
  test("each project lists its open plans, newest activity first, capped, with progress and driver", () => {
    const plans = [
      ...Array.from({ length: 7 }, (_, i) => ({ _id: `pl_${i}`, short_id: `pl-${i}`, title: `Plan ${i}`, status: i === 6 ? "done" : "active", project_id: "p_brand", updated_at: 100 + i, progress: { total: 4, done: i % 4, in_progress: 0, open: 4 - (i % 4) }, driver: i === 5 ? { short_id: "jx7d", title: "Driver", last_active_at: 9 } : null })),
    ];
    const c = computeCoverage(base({ plans, initiatives: [{ _id: "i1", short_id: "in-1", title: "Grow", status: "active", owner: undefined, health: "on_track", project_ids: ["p_brand"], metrics: [] } as any] }));
    const brand = c.initiatives[0].projects[0];
    expect(brand.open_plans.map((p) => p.short_id)).toEqual(["pl-5", "pl-4", "pl-3", "pl-2", "pl-1"]);
    expect(brand.more_plans).toBe(1);
    expect(brand.open_plans[0]).toEqual({ short_id: "pl-5", title: "Plan 5", status: "active", progress: { done: 1, total: 4 }, last_activity_at: 105, driver: { short_id: "jx7d", title: "Driver", last_active_at: 9 } });
  });
});

describe("unplaced work (ct-95900)", () => {
  const NOW = 1_800_000_000_000;
  const D = 86_400_000;
  const s = (short_id: string) => ({ short_id, title: `Session ${short_id}`, last_active_at: NOW - D });
  const inputs = (over: Partial<UnplacedInputs> = {}): UnplacedInputs => ({
    now: NOW,
    plans: [
      { short_id: "pl-1043", title: "Onboarding conversion", status: "active", created_at: NOW - 5 * D, updated_at: NOW - 3 * D, tasks: { open: 9, done: 7, last_at: NOW - D }, driver: s("jx1") },
      { short_id: "pl-792", title: "WhatsApp channel", status: "draft", created_at: NOW - 40 * D, updated_at: NOW - 20 * D, tasks: { open: 2, done: 3, last_at: NOW - 20 * D }, driver: null },
      { short_id: "pl-5", title: "Old empty draft", status: "draft", created_at: NOW - 90 * D, updated_at: NOW - 60 * D, tasks: { open: 0, done: 0, last_at: null }, driver: null },
      { short_id: "pl-6", title: "Fresh idea", status: "draft", created_at: NOW - 2 * D, updated_at: NOW - 2 * D, tasks: { open: 0, done: 0, last_at: null }, driver: null },
      { short_id: "pl-7", title: "Closed", status: "done", created_at: NOW - D, updated_at: NOW - D, tasks: { open: 1, done: 0, last_at: null }, driver: null },
    ],
    projects: [
      { short_id: "pj-9", title: "Trade budget allocation", status: "active", created_at: NOW - 10 * D, updated_at: NOW - 9 * D, open_tasks: 3, open_plans: 0, lead: "@head-of-growth", has_goal: false, last_at: NOW - 2 * D, driver: null },
      { short_id: "pj-1", title: "Carried", status: "active", created_at: NOW - 10 * D, updated_at: NOW - D, open_tasks: 3, open_plans: 0, lead: null, has_goal: true, last_at: null, driver: null },
      { short_id: "pj-2", title: "No work", status: "active", created_at: NOW - 10 * D, updated_at: NOW - D, open_tasks: 0, open_plans: 0, lead: null, has_goal: false, last_at: null, driver: null },
      { short_id: "pj-3", title: "Paused", status: "paused", created_at: NOW - 10 * D, updated_at: NOW - D, open_tasks: 2, open_plans: 0, lead: null, has_goal: false, last_at: null, driver: null },
    ],
    loose_tasks: [
      { short_id: "ct-1", title: "a", created_at: NOW - 6 * D, updated_at: NOW - 2 * D, session: s("jx1") },
      { short_id: "ct-2", title: "b", created_at: NOW - 2 * D, updated_at: NOW - D, session: s("jx1") },
      { short_id: "ct-3", title: "c", created_at: NOW - D, updated_at: NOW - D, session: null },
      { short_id: "ct-4", title: "old", created_at: NOW - 20 * D, updated_at: NOW - 10 * D, session: null },
    ],
    sessions: [
      { short_id: "jx1", title: "Long, unplaced", started_at: NOW - 9 * D, updated_at: NOW - D, bound: [{ kind: "plan", short_id: "pl-1043", title: "Onboarding", project: null, reaches_goal: false }] },
      { short_id: "jx2", title: "Long, project with no goal", started_at: NOW - 9 * D, updated_at: NOW - D, bound: [{ kind: "task", short_id: "ct-9", title: "t", project: "p9", reaches_goal: false }] },
      { short_id: "jx3", title: "Long, reaches a goal", started_at: NOW - 9 * D, updated_at: NOW - D, bound: [{ kind: "task", short_id: "ct-8", title: "t", project: "p1", reaches_goal: true }, { kind: "plan", short_id: "pl-1", title: "p", project: null, reaches_goal: false }] },
      { short_id: "jx4", title: "Young", started_at: NOW - 2 * D, updated_at: NOW - D, bound: [{ kind: "plan", short_id: "pl-1043", title: "Onboarding", project: null, reaches_goal: false }] },
      { short_id: "jx5", title: "Gone quiet", started_at: NOW - 30 * D, updated_at: NOW - 8 * D, bound: [{ kind: "plan", short_id: "pl-1043", title: "Onboarding", project: null, reaches_goal: false }] },
    ],
    ...over,
  });

  test("lists open plans with no project from their own counts, newest activity first, an old empty draft left out", () => {
    const u = computeUnplaced(inputs());
    expect(u.plans.map((p) => p.short_id)).toEqual(["pl-1043", "pl-6", "pl-792"]);
    expect(u.plans[0]).toEqual({ short_id: "pl-1043", title: "Onboarding conversion", status: "active", open_tasks: 9, done_tasks: 7, created_at: NOW - 5 * D, age_days: 5, last_activity_at: NOW - D, driver: s("jx1") });
  });

  test("lists active projects with open work that no open goal carries", () => {
    const u = computeUnplaced(inputs());
    expect(u.projects).toEqual([{ short_id: "pj-9", title: "Trade budget allocation", open_tasks: 3, open_plans: 0, lead: "@head-of-growth", created_at: NOW - 10 * D, age_days: 10, last_activity_at: NOW - 2 * D, driver: null }]);
  });

  test("groups the week's loose tasks by the session that made them", () => {
    const u = computeUnplaced(inputs());
    expect(u.loose_tasks.total).toBe(3);
    expect(u.loose_tasks.by_session).toEqual([
      { session: s("jx1"), tasks: 2, examples: [{ short_id: "ct-2", title: "b" }, { short_id: "ct-1", title: "a" }], age_days: 6, last_activity_at: NOW - D },
      { session: null, tasks: 1, examples: [{ short_id: "ct-3", title: "c" }], age_days: 1, last_activity_at: NOW - D },
    ]);
  });

  test("lists sessions running a week or more, still moving, whose bound work reaches no goal", () => {
    const u = computeUnplaced(inputs());
    expect(u.sessions.map((x) => [x.short_id, x.reason])).toEqual([["jx1", "no project"], ["jx2", "project with no goal"]]);
    expect(u.sessions[0]).toMatchObject({ age_days: 9, last_activity_at: NOW - D, bound: [{ kind: "plan", short_id: "pl-1043", title: "Onboarding" }] });
    expect(u.truncated).toBe(false);
  });

  test("withUnplaced reads outside.plans from the index counts, not the task sample", () => {
    // The sample holds no task of pl-1043 (it fell outside the capped read): the plan still lists.
    const c = withUnplaced(computeCoverage(base()), computeUnplaced(inputs()));
    expect(c.outside.plans).toEqual([{ short_id: "pl-1043", title: "Onboarding conversion", open_tasks: 9 }, { short_id: "pl-792", title: "WhatsApp channel", open_tasks: 2 }]);
    expect(c.unplaced?.projects[0].title).toBe("Trade budget allocation");
  });
});
