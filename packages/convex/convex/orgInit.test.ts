import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { ANALYSIS_CAPS, computeAnalysisActivity, computeAnalysisInputs, computeAnalysisOrg, computeAnalysisSignals, computeAnalysisWork, mergeAnalysisInputs, performApplyDecision } from "./orgInit";
import { orgProposalBlock } from "@codecast/shared/contracts/orgProposal";

// Org init (docs/architecture/org-init.md O1, O2): the analyzer's inputs are
// bounded and access checked, and applying an answered proposal is idempotent.

const ME = "u".repeat(31) + "m"; // team admin, caller
const MATE = "u".repeat(31) + "t";
const OUTSIDER = "u".repeat(31) + "o";
const TEAM = "teams_acme" as any;
const WS = `team:${TEAM}`;
const NOW = 1_800_000_000_000;
const H = 60 * 60 * 1000;
const D = 24 * H;

const P = "projects_p";
const Q = "projects_q";
const PLAN = "plans_pl1";
const S1 = "conversations_s1";
const STACK = "decision_stacks_1";

function fixtures(extra: Record<string, any[]> = {}) {
  return makeFakeDb({
    users: [
      { _id: ME, name: "Me", email: "me@x.ai" },
      { _id: MATE, name: "Mate", email: "mate@x.ai" },
      { _id: OUTSIDER, name: "Outsider", email: "o@x.ai" },
    ],
    team_memberships: [
      { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "member", joined_at: 1 },
    ],
    teams: [{ _id: TEAM, name: "Acme" }],
    counters: [],
    org_roles: [],
    org_role_history: [],
    role_wakes: [],
    anchors: [],
    inbox_buckets: [{ _id: "inbox_buckets_1", user_id: ME, name: "growth", sort_order: 0 }],
    bucket_assignments: [{ _id: "ba1", user_id: ME, conversation_id: S1, bucket_id: "inbox_buckets_1" }],
    projects: [
      { _id: P, user_id: ME, team_id: TEAM, workspace: WS, short_id: "pr-1", title: "Growth", description: "Bring users in", status: "active", project_path: "/repo/growth", created_at: 1, updated_at: NOW - 10 * H },
      { _id: Q, user_id: ME, team_id: TEAM, workspace: WS, short_id: "pr-2", title: "Billing", status: "active", project_path: "/repo/billing", created_at: 1, updated_at: NOW - 10 * H },
      // Another workspace's project: never in the answer.
      { _id: "projects_x", user_id: OUTSIDER, workspace: `user:${OUTSIDER}`, short_id: "pr-9", title: "Secret", status: "active", created_at: 1, updated_at: NOW },
    ],
    plans: [
      { _id: PLAN, user_id: ME, team_id: TEAM, workspace: WS, project_id: P, short_id: "pl-1", title: "Launch", status: "active", goal: "Ship it", created_at: 1, updated_at: NOW - 3 * H },
    ],
    tasks: [
      { _id: "tasks_t1", user_id: ME, team_id: TEAM, workspace: WS, project_id: P, short_id: "ct-1", title: "Landing page", task_type: "task", status: "in_progress", priority: "high", created_at: 1, updated_at: NOW - H },
      { _id: "tasks_t2", user_id: ME, team_id: TEAM, workspace: WS, plan_id: PLAN, short_id: "ct-2", title: "Wire analytics", task_type: "task", status: "open", priority: "medium", created_at: 1, updated_at: NOW - 5 * H },
      { _id: "tasks_t3", user_id: ME, team_id: TEAM, workspace: WS, short_id: "ct-3", title: "Unfiled", task_type: "task", status: "open", priority: "low", created_at: 1, updated_at: NOW - 2 * H },
    ],
    docs: [
      { _id: "docs_d1", user_id: ME, team_id: TEAM, workspace: WS, project_id: P, title: "Launch notes", content: "# Launch notes", doc_type: "note", created_at: 1, updated_at: NOW - 4 * H },
      { _id: "docs_d2", user_id: ME, team_id: TEAM, workspace: WS, title: "Design", content: "# Design", doc_type: "design", created_at: 1, updated_at: NOW - 4 * H },
    ],
    conversations: [
      { _id: S1, user_id: ME, team_id: TEAM, status: "active", agent_type: "claude", title: "Growth session", short_id: "jx1", session_id: "s1", project_path: "/repo/growth", git_root: "/repo/growth", git_remote_url: "git@github.com:acme/growth.git", updated_at: NOW - 2 * H, created_at: 1, message_count: 3 },
      // A teammate's private row: not the caller's to count.
      { _id: "conversations_s2", user_id: MATE, team_id: TEAM, is_private: true, status: "active", agent_type: "claude", title: "Mate private", short_id: "jx2", project_path: "/repo/billing", updated_at: NOW - H, created_at: 1, message_count: 3 },
    ],
    session_insights: [
      { _id: "si1", conversation_id: S1, team_id: TEAM, actor_user_id: ME, source: "idle", generated_at: NOW - 3 * H, summary: "x", headline: "Landing shipped", outcome_type: "shipped", themes: ["growth", "landing"] },
      { _id: "si2", conversation_id: S1, team_id: TEAM, actor_user_id: ME, source: "idle", generated_at: NOW - 40 * D, summary: "old", outcome_type: "blocked", themes: ["old"] },
    ],
    chat_channels: [{ _id: "chat_channels_1", team_id: TEAM, name: "general", created_at: 1 }],
    chat_messages: [{ _id: "cm1", channel_id: "chat_channels_1", user_id: ME, content: "hi", created_at: NOW - H }],
    session_decisions: [
      { _id: "sd1", conversation_id: S1, session_id: "s1", user_id: ME, short_id: "sd-1", question: "Blue or green?", options: [{ label: "Blue" }, { label: "Green" }], blocking: true, status: "pending", category: "approach", created_at: NOW - 6 * H },
    ],
    decision_stacks: [
      { _id: STACK, short_id: "ds-1", title: "Adopt the org for Acme", team_id: TEAM, owner_user_id: ME, decision_ids: [], policy: {}, status: "open", created_at: NOW - H, updated_at: NOW - H },
    ],
    session_owners: [],
    managed_sessions: [],
    messages: [],
    user_presence: [],
    project_updates: [],
    commits: [],
    artifacts: [],
    conversation_images: [],
    ...extra,
  });
}

const ctxOf = (db: any) => ({ db }) as any;

describe("org.analysisInputs", () => {
  test("reads the workspace inside the window, capped, with private rows and other workspaces left out", async () => {
    const db = fixtures();
    const r = await computeAnalysisInputs(ctxOf(db), ME as any, TEAM, NOW);
    expect(r.workspace).toEqual({ kind: "team", id: TEAM, name: "Acme" });
    expect(r.projects.map((p) => p.title).sort()).toEqual(["Billing", "Growth"]);
    expect(r.projects.find((p) => p.title === "Growth")).toMatchObject({ tasks: { total: 1, open: 1, by_status: { in_progress: 1 } }, plans: 1, description: "Bring users in" });
    expect(r.plans).toEqual([expect.objectContaining({ short_id: "pl-1", progress: { total: 1, done: 0, in_progress: 0, open: 1 } })]);
    expect(r.tasks).toEqual({ total: 3, by_status: { in_progress: 1, open: 2 }, unfiled_open: 1, truncated: false, closed_counted: "inside the window only" });
    expect(r.docs_by_type).toEqual({ note: 1, design: 1 });
    // Sessions: the caller's row counts; the teammate's private row does not.
    expect(r.sessions.total).toBe(1);
    expect(r.members.find((m) => m.is_me)).toMatchObject({ sessions_30d: 1, by_project_path: { "/repo/growth": 1 } });
    expect(r.members.find((m) => m.name === "Mate")).toMatchObject({ sessions_30d: 0 });
    expect(r.git_roots).toEqual([{ git_root: "/repo/growth", remote_url: "git@github.com:acme/growth.git", repo: "acme/growth", sessions: 1 }]);
    expect(r.labels).toEqual([{ name: "growth", count: 1 }]);
    // Insights: the 40 day old row is outside the window.
    expect(r.insights).toMatchObject({ total: 1, outcomes: { shipped: 1 }, themes: [{ name: "growth", count: 1 }, { name: "landing", count: 1 }] });
    expect(r.channels).toEqual([{ id: "chat_channels_1", name: "general", messages_30d: 1, last_at: NOW - H }]);
    expect(r.decisions_open_by_category).toEqual({ approach: 1 });
    expect(r.org).toMatchObject({ roles: [], whole_workspace_roles: 0 });
    expect(r.org.projects_without_role.map((p) => p.title).sort()).toEqual(["Billing", "Growth"]);
    expect(r.window_days).toBe(30);
    expect(r.caps).toBe(ANALYSIS_CAPS);
  });

  test("the three slices merge to the one process read, and the org slice never reads tasks", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const whole = await computeAnalysisInputs(ctx, ME as any, TEAM, NOW);
    const work = await computeAnalysisWork(ctx, ME as any, TEAM);
    const signals = await computeAnalysisSignals(ctx, ME as any, TEAM, NOW);
    const org = await computeAnalysisOrg(ctx, ME as any, TEAM, NOW, JSON.parse(JSON.stringify(work.handoff)));
    const activity = await computeAnalysisActivity(ctx, ME as any, TEAM, NOW);
    expect(mergeAnalysisInputs(ME as any, TEAM, "Acme", work, org, signals, NOW, activity.activity)).toEqual(whole);
    expect(work.handoff.latest_event).toBe(NOW - H);
    expect(Object.keys(whole.truncated).sort()).toEqual(["docs", "insights", "plans", "projects", "tasks"]);
    // The activity block is its own slice (S9): areas, people and stale lists.
    expect(whole.activity).toBeDefined();
    expect(Object.keys(whole.activity.stale).sort()).toEqual(["plans", "projects", "tasks"]);
  });

  test("every list at its cap still answers, and each floor is reported", async () => {
    const many = (n: number, f: (i: number) => any) => Array.from({ length: n }, (_, i) => f(i));
    const db = fixtures({
      projects: many(ANALYSIS_CAPS.projects + 5, (i) => ({ _id: `projects_c${i}`, user_id: ME, team_id: TEAM, workspace: WS, title: `P${i}`, status: "active", created_at: 1, updated_at: NOW - i })),
      plans: many(ANALYSIS_CAPS.plans + 5, (i) => ({ _id: `plans_c${i}`, user_id: ME, team_id: TEAM, workspace: WS, project_id: `projects_c${i % 10}`, short_id: `pl-${i}`, title: `Plan ${i}`, status: "active", created_at: 1, updated_at: NOW - i })),
      tasks: many(ANALYSIS_CAPS.tasks + 5, (i) => ({ _id: `tasks_c${i}`, user_id: ME, team_id: TEAM, workspace: WS, project_id: `projects_c${i % 10}`, plan_id: `plans_c${i % 20}`, short_id: `ct-${i}`, title: `T${i}`, task_type: "task", status: i % 3 ? "open" : "done", priority: "medium", created_at: 1, updated_at: NOW - i })),
      docs: many(ANALYSIS_CAPS.docs + 5, (i) => ({ _id: `docs_c${i}`, user_id: ME, team_id: TEAM, workspace: WS, title: `D${i}`, content: "x".repeat(2000), doc_type: i % 2 ? "note" : "design", created_at: 1, updated_at: NOW - i })),
      session_insights: many(ANALYSIS_CAPS.insights + 5, (i) => ({ _id: `si_c${i}`, conversation_id: S1, team_id: TEAM, actor_user_id: ME, source: "idle", generated_at: NOW - i * 1000, summary: "x", outcome_type: "shipped", themes: ["t"] })),
      chat_channels: many(ANALYSIS_CAPS.channels + 5, (i) => ({ _id: `chat_channels_c${i}`, team_id: TEAM, name: `c${i}`, created_at: 1 })),
      chat_messages: many(ANALYSIS_CAPS.messages_per_channel + 5, (i) => ({ _id: `cm_c${i}`, channel_id: "chat_channels_c0", user_id: ME, content: "hi", created_at: NOW - i * 1000 })),
      session_decisions: many(ANALYSIS_CAPS.decisions + 5, (i) => ({ _id: `sd_c${i}`, conversation_id: S1, session_id: "s1", user_id: ME, short_id: `sd-${i}`, question: "?", options: [{ label: "a" }, { label: "b" }], blocking: true, status: "pending", category: "approach", created_at: NOW - i * 1000 })),
      bucket_assignments: many(ANALYSIS_CAPS.assignments + 5, (i) => ({ _id: `ba_c${i}`, user_id: ME, conversation_id: S1, bucket_id: "inbox_buckets_1" })),
    });
    const r = await computeAnalysisInputs(ctxOf(db), ME as any, TEAM, NOW);
    expect(r.truncated).toEqual({ projects: true, plans: true, tasks: true, docs: true, insights: true });
    expect(r.projects.length).toBe(ANALYSIS_CAPS.projects);
    expect(r.plans.length).toBe(ANALYSIS_CAPS.plans);
    // Tasks are read per status (every open row) plus the window's changes,
    // so the total is not one cap; the floor is reported per slice.
    expect(r.tasks.total).toBeGreaterThanOrEqual(ANALYSIS_CAPS.tasks);
    expect(r.tasks.truncated).toBe(true);
    expect(Object.values(r.docs_by_type).reduce((a, b) => a + b, 0)).toBe(ANALYSIS_CAPS.docs);
    expect(r.insights.total).toBe(ANALYSIS_CAPS.insights);
    expect(r.channels.length).toBe(ANALYSIS_CAPS.channels);
    expect(r.channels.find((c) => c.name === "c0")!.messages_30d).toBe(ANALYSIS_CAPS.messages_per_channel);
    expect(r.decisions_open_by_category.approach).toBe(ANALYSIS_CAPS.decisions);
    expect(r.labels).toEqual([{ name: "growth", count: ANALYSIS_CAPS.assignments }]);
  });

  test("the per list caps hold", async () => {
    const many = Array.from({ length: ANALYSIS_CAPS.projects + 20 }, (_, i) => ({
      _id: `projects_m${i}`, user_id: ME, team_id: TEAM, workspace: WS, title: `P${i}`, status: "active", created_at: 1, updated_at: NOW - i,
    }));
    const db = fixtures({ projects: many });
    const r = await computeAnalysisInputs(ctxOf(db), ME as any, TEAM, NOW);
    expect(r.projects.length).toBe(ANALYSIS_CAPS.projects);
    expect(r.truncated).toMatchObject({ projects: true, tasks: false });
  });

  test("a personal workspace reads only the caller's rows; a non member sees nothing of the team", async () => {
    const db = fixtures();
    const personal = await computeAnalysisInputs(ctxOf(db), OUTSIDER as any, undefined, NOW);
    expect(personal.projects.map((p) => p.title)).toEqual(["Secret"]);
    expect(personal.members.map((m) => m.name)).toEqual(["Outsider"]);
    expect(personal.channels).toEqual([]);
    await expect(computeAnalysisInputs(ctxOf(db), OUTSIDER as any, TEAM, NOW)).rejects.toThrow();
  });

  test("role health: idle when its scope had no event in 14 days, overlaps and wakes at the cap", async () => {
    const db = fixtures({
      org_roles: [
        { _id: "org_roles_1", short_id: "or-1", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Growth lead", handle: "growth", scope: { project_ids: [P], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", caps: { hands_per_day: 6, wakes_per_day: 2, tokens_per_day: 1 }, created_by: ME, created_at: 1, updated_at: 1 },
        { _id: "org_roles_2", short_id: "or-2", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Also growth", handle: "growth2", scope: { project_ids: [P], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", created_by: ME, created_at: 1, updated_at: 1 },
        { _id: "org_roles_3", short_id: "or-3", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Billing lead", handle: "billing", scope: { project_ids: [Q], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", created_by: ME, created_at: 1, updated_at: 1 },
      ],
      role_wakes: [
        { _id: "rw1", role_id: "org_roles_1", short_id: "rw-1", causes: [], status: "delivered", frame_chars: 1, created_at: NOW - H },
        { _id: "rw2", role_id: "org_roles_1", short_id: "rw-2", causes: [], status: "delivered", frame_chars: 1, created_at: NOW - 2 * H },
        { _id: "rw3", role_id: "org_roles_1", short_id: "rw-3", causes: [], status: "held", frame_chars: 0, created_at: NOW - 3 * H },
      ],
    });
    const r = await computeAnalysisInputs(ctxOf(db), ME as any, TEAM, NOW);
    const growth = r.org.roles.find((x) => x.handle === "growth")!;
    expect(growth.idle).toBe(false);
    expect(growth.wakes_7d).toMatchObject({ total: 2, held: 1, days_at_cap: 1 });
    expect(growth.overlaps).toEqual([{ handle: "growth2", projects: 1, plans: 0 }]);
    // Billing owns a project with no task, plan, doc or visible session: the
    // scope feed has no row for it, so the role reads idle.
    const billing = r.org.roles.find((x) => x.handle === "billing")!;
    expect(billing).toMatchObject({ idle: true, last_scope_event_at: null, idle_days: null });
    expect(r.org.projects_without_role).toEqual([]);
  });
});

// A fake stack: one role proposal answered "create", one answered "create with
// changes", one skipped, one still pending.
function proposalDecision(id: string, short: string, proposal: any, answer: { status: "answered" | "pending"; answer_index?: number; answer_text?: string }) {
  return {
    _id: id, conversation_id: S1, session_id: "s1", user_id: ME, short_id: short,
    question: `Create ${proposal.name ?? proposal.handle ?? "projects"}?`,
    context_md: `Why: evidence.\n\n${orgProposalBlock(proposal)}`,
    options: [{ label: "Create as proposed" }, { label: "Create with changes" }, { label: "Skip" }],
    blocking: true, stack_id: STACK, created_at: NOW - H,
    ...(answer.status === "answered" ? { answered_by: { kind: "user", id: ME } } : {}),
    ...answer,
  };
}

describe("cast org apply", () => {
  test("an explicit personal stack never inherits the asking session's team", async () => {
    const db = fixtures({
      decision_stacks: [{ _id: STACK, short_id: "ds-1", title: "Personal CMO", scope_user_id: ME, owner_user_id: ME, decision_ids: [], policy: {}, status: "open", created_at: NOW, updated_at: NOW }],
      projects: [{ _id: P, user_id: ME, workspace: `user:${ME}`, short_id: "pr-1", title: "Personal product", status: "active", created_at: 1, updated_at: NOW }],
      session_decisions: [proposalDecision("sd_personal", "sd-90", { kind: "role", name: "Personal CMO", handle: "personal-cmo", scope: { projects: ["pr-1"] } }, { status: "answered", answer_index: 0 })],
    });
    const result = await performApplyDecision(ctxOf(db), ME as any, "sd-90", { provision: false });
    expect(result.status).toBe("applied");
    const roles = await db.query("org_roles").collect();
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({ scope_type: "user", scope_user_id: ME, scope: { project_ids: [P], plan_ids: [] } });
    expect(roles[0].team_id).toBeUndefined();
    expect((await db.get(S1 as any)).team_id).toBe(TEAM);
    expect((await performApplyDecision(ctxOf(db), ME as any, "sd-90", { provision: false })).status).toBe("skipped");
  });

  test("creates the accepted roles with scope, parent and charter, folds change text in, skips the rest, and is idempotent", async () => {
    const db = fixtures({
      session_decisions: [
        proposalDecision("sd_a", "sd-10", { kind: "role", name: "Head of Growth", handle: "growth", scope: { projects: ["pr-1"] }, charter: "Owns growth.", caps: { wakes_per_day: 12 } }, { status: "answered", answer_index: 0 }),
        proposalDecision("sd_b", "sd-11", { kind: "role", name: "Landing lead", handle: "landing", scope: { plans: ["pl-1"] }, reports_to: "@growth" }, { status: "answered", answer_index: 1, answer_text: "Report weekly, not daily." }),
        proposalDecision("sd_c", "sd-12", { kind: "role", name: "Billing lead", handle: "billing", scope: { projects: ["Billing"] } }, { status: "answered", answer_index: 2 }),
        proposalDecision("sd_d", "sd-13", { kind: "role", name: "Ops", handle: "ops" }, { status: "pending" }),
      ],
    });
    const ctx = ctxOf(db);
    const a = await performApplyDecision(ctx, ME as any, "sd-10", { provision: false });
    expect(a).toMatchObject({ status: "applied", role: { handle: "growth", short_id: "or-1" } });
    const growth = await db.get("org_roles_1" as any) ?? (await db.query("org_roles").withIndex("by_short_id", (q: any) => q.eq("short_id", "or-1")).first());
    expect(growth).toMatchObject({ name: "Head of Growth", scope: { project_ids: [P], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, charter: "Owns growth.", caps: { hands_per_day: 6, wakes_per_day: 12, tokens_per_day: 400_000 } });

    const b = await performApplyDecision(ctx, ME as any, "sd-11", { provision: false });
    expect(b).toMatchObject({ status: "applied", role: { handle: "landing" } });
    const landing = await db.query("org_roles").withIndex("by_short_id", (q: any) => q.eq("short_id", "or-2")).first();
    expect(landing.reports_to).toEqual({ kind: "role", role_id: growth._id });
    expect(landing.scope).toEqual({ project_ids: [], plan_ids: [PLAN] });
    expect(landing.charter).toContain("Report weekly, not daily.");

    expect(await performApplyDecision(ctx, ME as any, "sd-12", { provision: false })).toMatchObject({ status: "skipped" });
    expect(await performApplyDecision(ctx, ME as any, "sd-13", { provision: false })).toMatchObject({ status: "unanswered" });
    expect((await db.get("sd_a" as any)).applied_at).toBeGreaterThan(0);
    expect((await db.get("sd_c" as any)).applied_at).toBeGreaterThan(0);
    expect((await db.get("sd_d" as any)).applied_at).toBeUndefined();

    // Second run: nothing created twice.
    expect(await performApplyDecision(ctx, ME as any, "sd-10", { provision: false })).toMatchObject({ status: "skipped", note: expect.stringContaining("already applied") });
    const roles = await db.query("org_roles").withIndex("by_team", (q: any) => q.eq("team_id", TEAM)).collect();
    expect(roles.map((r: any) => r.handle).sort()).toEqual(["growth", "landing"]);
  });

  test("a handle the person already gave a role by hand is refused, never adopted", async () => {
    const db = fixtures({
      org_roles: [
        { _id: "org_roles_hand", short_id: "or-3", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Growth (mine)", handle: "growth", scope: { project_ids: [Q], plan_ids: [] }, reports_to: { kind: "user", user_id: MATE }, charter: "My own words.", status: "active", created_by: ME, created_at: 1, updated_at: 1 },
      ],
      session_decisions: [
        proposalDecision("sd_a", "sd-40", { kind: "role", name: "Head of Growth", handle: "growth", scope: { projects: ["pr-1"] }, charter: "Owns growth.", caps: { wakes_per_day: 12 } }, { status: "answered", answer_index: 0 }),
      ],
    });
    const ctx = ctxOf(db);
    const r = await performApplyDecision(ctx, ME as any, "sd-40", { provision: false });
    // Read the message once: bun's toMatchObject with an asymmetric matcher
    // writes the matcher back into the received object.
    const message = r.status === "error" ? r.error : "";
    expect(r.status).toBe("error");
    expect(message).toContain("@growth is already or-3 (Growth (mine))");
    expect(message).toContain("pick another handle, or skip");
    // The hand made role is untouched: scope, parent, charter and caps.
    const hand = await db.get("org_roles_hand" as any);
    expect(hand).toMatchObject({ scope: { project_ids: [Q], plan_ids: [] }, reports_to: { kind: "user", user_id: MATE }, charter: "My own words." });
    expect(hand.caps).toBeUndefined();
    // Not stamped: answering with a new handle makes the same decision apply.
    expect((await db.get("sd_a" as any)).applied_at).toBeUndefined();
    const roles = await db.query("org_roles").withIndex("by_team", (q: any) => q.eq("team_id", TEAM)).collect();
    expect(roles.length).toBe(1);
  });

  test("an answer that is not a person's (a delegated role, a policy default) does not apply", async () => {
    const db = fixtures({
      session_decisions: [
        { ...proposalDecision("sd_r", "sd-50", { kind: "role", name: "X", handle: "xx" }, { status: "answered", answer_index: 0 }), answered_by: { kind: "role", id: "org_roles_9" } },
        { ...proposalDecision("sd_p", "sd-51", { kind: "role", name: "Y", handle: "yy" }, { status: "answered", answer_index: 0 }), answered_by: { kind: "policy", id: "stack:x" } },
      ],
    });
    const ctx = ctxOf(db);
    expect(await performApplyDecision(ctx, ME as any, "sd-50", { provision: false })).toMatchObject({ status: "error", error: expect.stringContaining("only when a person answered it (answered by role)") });
    expect(await performApplyDecision(ctx, ME as any, "sd-51", { provision: false })).toMatchObject({ status: "error", error: expect.stringContaining("answered by policy") });
    expect(await db.query("org_roles").withIndex("by_team", (q: any) => q.eq("team_id", TEAM)).collect()).toEqual([]);
  });

  test("a decision without a proposal block, or applied by a plain member, is refused as a value", async () => {
    const db = fixtures({
      session_decisions: [
        { _id: "sd_p", conversation_id: S1, session_id: "s1", user_id: ME, short_id: "sd-20", question: "Plain?", context_md: "no block", options: [{ label: "a" }, { label: "b" }, { label: "c" }], blocking: true, status: "answered", answer_index: 0, stack_id: STACK, created_at: NOW },
        proposalDecision("sd_q", "sd-21", { kind: "role", name: "X", handle: "xx" }, { status: "answered", answer_index: 0 }),
      ],
    });
    const ctx = ctxOf(db);
    expect(await performApplyDecision(ctx, ME as any, "sd-20")).toMatchObject({ status: "error", error: expect.stringContaining("no org proposal") });
    expect(await performApplyDecision(ctx, MATE as any, "sd-21")).toMatchObject({ status: "error", error: expect.stringContaining("owner or a team admin") });
    expect(await performApplyDecision(ctx, ME as any, "sd-99")).toMatchObject({ status: "error" });
  });

  test("update mode proposals: projects, move and retire", async () => {
    const db = fixtures({
      org_roles: [
        { _id: "org_roles_1", short_id: "or-1", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Growth lead", handle: "growth", scope: { project_ids: [P], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", created_by: ME, created_at: 1, updated_at: 1 },
        { _id: "org_roles_2", short_id: "or-2", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Old", handle: "old", scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", created_by: ME, created_at: 1, updated_at: 1 },
      ],
      session_decisions: [
        proposalDecision("sd_a", "sd-30", { kind: "projects", changes: [{ op: "create", title: "Platform", description: "Shared infra", project_path: "/repo/platform" }] }, { status: "answered", answer_index: 0 }),
        proposalDecision("sd_b", "sd-31", { kind: "move", handle: "growth", scope_add: ["pr-2"], reports_to: "Mate" }, { status: "answered", answer_index: 0 }),
        proposalDecision("sd_c", "sd-32", { kind: "retire", handle: "@old" }, { status: "answered", answer_index: 0 }),
      ],
    });
    const ctx = ctxOf(db);
    expect(await performApplyDecision(ctx, ME as any, "sd-30")).toMatchObject({ status: "applied", note: expect.stringContaining('created project "Platform"') });
    const platform = (await db.query("projects").withIndex("by_workspace", (q: any) => q.eq("workspace", WS)).collect()).find((p: any) => p.title === "Platform");
    expect(platform).toMatchObject({ team_id: TEAM, workspace: WS, status: "active", project_path: "/repo/platform" });
    // Re-applying after the stamp is a skip; an unstamped identical create finds the project and does not twin it.
    await db.patch("sd_a" as any, { applied_at: undefined, applied_note: undefined });
    expect(await performApplyDecision(ctx, ME as any, "sd-30")).toMatchObject({ status: "applied", note: expect.stringContaining("already exists") });

    expect(await performApplyDecision(ctx, ME as any, "sd-31")).toMatchObject({ status: "applied" });
    const growth = await db.get("org_roles_1" as any);
    expect(growth.scope.project_ids.map(String).sort()).toEqual([P, Q].sort());
    expect(growth.reports_to).toEqual({ kind: "user", user_id: MATE });

    expect(await performApplyDecision(ctx, ME as any, "sd-32")).toMatchObject({ status: "applied", note: expect.stringContaining("retired @old") });
    expect((await db.get("org_roles_2" as any)).status).toBe("retired");
  });
});
