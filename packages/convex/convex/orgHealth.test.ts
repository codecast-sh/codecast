import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { HEALTH_CAPS, computeOrgHealth, roleActivity } from "./orgHealth";

// org.health (docs/architecture/org-staffing.md S3): the flow signals per
// role, per person and for the company, read from the same scan org.tree uses
// plus bounded reads of wakes, decisions, tasks, the send ledger, chat
// mentions and the role history; and the flags the shared capacity model
// raises on them. Two roles: one overloaded on every axis, one idle.

const ME = "u".repeat(31) + "m";
const MATE = "u".repeat(31) + "t";
const TEAM = "teams_acme" as any;
const WS = `team:${TEAM}`;
const NOW = 1_800_000_000_000;
const H = 60 * 60 * 1000;
const D = 24 * H;
const P = "projects_growth";
const Q = "projects_billing";
const R = "projects_orphan";
const GROWTH = "org_roles_growth";
const BILLING = "org_roles_billing";
const S_GROWTH = "conversations_standing_growth";
const S_BILLING = "conversations_standing_billing";

const conv = (id: string, over: Record<string, any> = {}) => ({
  _id: id, user_id: ME, team_id: TEAM, status: "active", agent_type: "claude_code", title: id, short_id: id.slice(-7), session_id: `sess_${id}`,
  project_path: "/repo/growth", updated_at: NOW - H, created_at: NOW - 10 * D, message_count: 2, ...over,
});
const task = (id: string, over: Record<string, any> = {}) => ({
  _id: id, user_id: ME, team_id: TEAM, workspace: WS, project_id: P, short_id: id, title: id, task_type: "task", status: "open", priority: "medium", created_at: 1, updated_at: NOW - 2 * H, ...over,
});

function fixtures(extra: Record<string, any[]> = {}) {
  const growthTasks = [
    // 27 open: 9 in flight (3 of them stale in review), 18 open; plus 2 done this week and 1 done long ago.
    ...Array.from({ length: 6 }, (_, i) => task(`ct-p${i}`, { status: "in_progress", execution_status: i === 0 ? "blocked" : undefined })),
    ...Array.from({ length: 3 }, (_, i) => task(`ct-r${i}`, { status: "in_review", updated_at: NOW - 30 * H })),
    ...Array.from({ length: 18 }, (_, i) => task(`ct-o${i}`)),
    task("ct-d1", { status: "done", execution_status: "done", updated_at: NOW - D }),
    task("ct-d2", { status: "done", execution_status: "done_with_concerns", updated_at: NOW - 2 * D }),
    task("ct-old", { status: "done", updated_at: NOW - 20 * D }),
  ];
  return makeFakeDb({
    users: [{ _id: ME, name: "Me", email: "me@x.ai" }, { _id: MATE, name: "Mate", email: "mate@x.ai" }],
    team_memberships: [
      { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "member", joined_at: 1 },
    ],
    teams: [{ _id: TEAM, name: "Acme" }],
    org_roles: [
      { _id: GROWTH, short_id: "or-1", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Growth lead", handle: "growth", scope: { project_ids: [P], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", anchor_id: "anchors_growth", caps: { hands_per_day: 6, wakes_per_day: 4, tokens_per_day: 400_000 }, counters: { day: new Date(NOW).toISOString().slice(0, 10), hands: 2, wakes: 4, tokens: 1000 }, created_by: ME, created_at: NOW - 30 * D, updated_at: 1 },
      { _id: BILLING, short_id: "or-2", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Billing lead", handle: "billing", scope: { project_ids: [Q], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", anchor_id: "anchors_billing", charter: "Owns billing.", created_by: ME, created_at: NOW - 40 * D, updated_at: 1 },
    ],
    org_role_history: [
      { _id: "h1", role_id: GROWTH, user_id: ME, actor_type: "user", action: "scope", created_at: NOW - 3 * D },
      { _id: "h0", role_id: GROWTH, user_id: ME, actor_type: "user", action: "scope", created_at: NOW - 20 * D },
    ],
    anchors: [
      { _id: "anchors_growth", name: "Growth lead", scope_type: "team", team_id: TEAM, host_user_id: ME, bot_user_id: MATE, org_role_id: GROWTH, conversation_id: S_GROWTH, status: "active" },
      { _id: "anchors_billing", name: "Billing lead", scope_type: "team", team_id: TEAM, host_user_id: ME, bot_user_id: MATE, org_role_id: BILLING, conversation_id: S_BILLING, status: "active" },
    ],
    // Four wakes today (the cap) and one held yesterday: two cap hit days. One dropped frame.
    role_wakes: [
      ...Array.from({ length: 4 }, (_, i) => ({ _id: `rw${i}`, role_id: GROWTH, short_id: `rw-${i}`, causes: [], status: "delivered", frame_chars: 1, created_at: NOW - i * 1000 })),
      { _id: "rw_held", role_id: GROWTH, short_id: "rw-9", causes: [], status: "held", frame_chars: 0, created_at: NOW - D },
      { _id: "rw_drop", role_id: GROWTH, short_id: "rw-8", causes: [], status: "dropped", frame_chars: 0, created_at: NOW - 2 * D },
      { _id: "rw_old", role_id: GROWTH, short_id: "rw-7", causes: [], status: "delivered", frame_chars: 1, created_at: NOW - 10 * D },
    ],
    projects: [
      { _id: P, user_id: ME, team_id: TEAM, workspace: WS, short_id: "pr-1", title: "Growth", goal: "Bring users in", status: "active", project_path: "/repo/growth", created_at: 1, updated_at: NOW - 10 * H },
      { _id: Q, user_id: ME, team_id: TEAM, workspace: WS, short_id: "pr-2", title: "Billing", status: "active", project_path: "/repo/billing", created_at: 1, updated_at: NOW - 30 * D },
      { _id: R, user_id: ME, team_id: TEAM, workspace: WS, short_id: "pr-3", title: "Orphan", status: "active", created_at: 1, updated_at: NOW - 10 * H },
    ],
    plans: [
      { _id: "plans_launch", user_id: ME, team_id: TEAM, workspace: WS, project_id: P, short_id: "pl-1", title: "Launch", status: "active", created_at: 1, updated_at: NOW - 3 * H },
      { _id: "plans_done", user_id: ME, team_id: TEAM, workspace: WS, project_id: P, short_id: "pl-2", title: "Old", status: "done", goal: "x", created_at: 1, updated_at: NOW - 3 * H },
      // Two plans under no project: one with open work (flagged), one with none.
      { _id: "plans_loose", user_id: ME, team_id: TEAM, workspace: WS, short_id: "pl-3", title: "Loose", status: "active", goal: "g", created_at: 1, updated_at: NOW - 3 * H },
      { _id: "plans_empty", user_id: ME, team_id: TEAM, workspace: WS, short_id: "pl-4", title: "Empty", status: "active", goal: "g", created_at: 1, updated_at: NOW - 3 * H },
    ],
    tasks: [
      ...growthTasks,
      task("ct-unfiled", { project_id: undefined }),
      // Mined suggestions awaiting triage are not filed work: not ledger, not unfiled, not stale.
      task("ct-suggested", { source: "insight", triage_status: "suggested", status: "in_progress", updated_at: NOW - 20 * D }),
      task("ct-suggested-unfiled", { project_id: undefined, source: "insight", triage_status: "suggested", updated_at: NOW - 20 * D }),
      task("ct-loose1", { project_id: undefined, plan_id: "plans_loose" }),
      task("ct-loose2", { project_id: undefined, plan_id: "plans_loose", status: "done" }),
    ],
    docs: [],
    conversations: [
      conv(S_GROWTH, { standing_role_id: GROWTH, anchor_id: "anchors_growth", persistent: true }),
      conv(S_BILLING, { standing_role_id: BILLING, anchor_id: "anchors_billing", persistent: true, project_path: "/repo/elsewhere" }),
      // Seven hands under growth, pinned dormant, one of them settled done.
      ...Array.from({ length: 7 }, (_, i) => conv(`conversations_hand${i}`, { org_role_id: GROWTH, thread_state: "Working the landing page", thread_state_status: i === 6 ? "done" : "dormant", thread_state_at: NOW - H })),
    ],
    // Three decisions on growth's ladder: recommended at 4, 12 and 20 minutes (median 12); one escalated.
    session_decisions: [
      { _id: "sd1", conversation_id: "conversations_hand0", session_id: "s", user_id: ME, short_id: "sd-1", question: "A?", options: [{ label: "x" }, { label: "y" }], blocking: true, status: "answered", created_at: NOW - 2 * D, hops: [{ role_id: GROWTH, recommendation: 0, at: NOW - 2 * D + 4 * 60_000 }] },
      { _id: "sd2", conversation_id: "conversations_hand0", session_id: "s", user_id: ME, short_id: "sd-2", question: "B?", options: [{ label: "x" }, { label: "y" }], blocking: true, status: "pending", created_at: NOW - D, hops: [{ role_id: GROWTH, recommendation: 1, at: NOW - D + 12 * 60_000 }] },
      { _id: "sd3", conversation_id: "conversations_hand0", session_id: "s", user_id: ME, short_id: "sd-3", question: "C?", options: [{ label: "x" }, { label: "y" }], blocking: true, status: "pending", created_at: NOW - 3 * H, hops: [{ role_id: GROWTH, recommendation: 0, at: NOW - 3 * H + 20 * 60_000 }, { role_id: BILLING, note: "escalated: not mine", at: NOW - 2 * H }] },
      // Growth never answered this one and it is 30 minutes old: the wait counts.
      { _id: "sd_silent", conversation_id: "conversations_hand0", session_id: "s", user_id: ME, short_id: "sd-5", question: "E?", options: [{ label: "x" }, { label: "y" }], blocking: true, status: "pending", created_at: NOW - 30 * 60_000, hops: [{ role_id: GROWTH, at: NOW - 30 * 60_000 }] },
      // Too young to count against the deadline.
      { _id: "sd_fresh", conversation_id: "conversations_hand0", session_id: "s", user_id: ME, short_id: "sd-6", question: "F?", options: [{ label: "x" }, { label: "y" }], blocking: true, status: "pending", created_at: NOW - 2 * 60_000, hops: [{ role_id: GROWTH, at: NOW - 2 * 60_000 }] },
      // A teammate's decision (a member's account) counts; a stranger's would not be read.
      { _id: "sd_mate", conversation_id: "conversations_hand0", session_id: "s", user_id: MATE, short_id: "sd-7", question: "G?", options: [{ label: "x" }, { label: "y" }], blocking: true, status: "answered", created_at: NOW - 3 * D, resolved_at: NOW - 3 * D + 40 * 60_000, hops: [{ role_id: GROWTH, at: NOW - 3 * D }] },
      { _id: "sd_old", conversation_id: "conversations_hand0", session_id: "s", user_id: ME, short_id: "sd-4", question: "D?", options: [{ label: "x" }, { label: "y" }], blocking: true, status: "answered", created_at: NOW - 20 * D, hops: [{ role_id: GROWTH, recommendation: 0, at: NOW - 20 * D + 99 * 60_000 }] },
    ],
    decision_inbox: [
      { _id: "di1", decision_id: "sd2", user_id: ME, status: "pending", created_at: NOW - D },
      { _id: "di2", decision_id: "sd3", user_id: ME, status: "pending", created_at: NOW - 3 * H },
      { _id: "di3", decision_id: "sd1", user_id: ME, status: "done", created_at: NOW - 2 * D },
    ],
    // Six sends from billing's standing session to growth's this week, one older; one from a hand (not a role to role send).
    pending_messages: [
      ...Array.from({ length: 6 }, (_, i) => ({ _id: `pm${i}`, conversation_id: S_GROWTH, from_user_id: ME, owner_user_id: ME, from_conversation_id: S_BILLING, content: `<session-message from="billing">hi ${i}</session-message>`, status: "delivered", created_at: NOW - i * H })),
      { _id: "pm_old", conversation_id: S_GROWTH, from_user_id: ME, owner_user_id: ME, from_conversation_id: S_BILLING, content: "old", status: "delivered", created_at: NOW - 10 * D },
      { _id: "pm_hand", conversation_id: S_GROWTH, from_user_id: ME, owner_user_id: ME, from_conversation_id: "conversations_hand0", content: "from a hand", status: "delivered", created_at: NOW - H },
    ],
    chat_channels: [{ _id: "chat_channels_1", team_id: TEAM, name: "general", created_at: 1 }],
    chat_messages: [
      { _id: "cm1", team_id: TEAM, channel_id: "chat_channels_1", user_id: ME, content: "@growth look", mentions: [{ kind: "role", role_id: GROWTH, short_id: "or-1", handle: "growth" }], created_at: NOW - H },
      { _id: "cm2", team_id: TEAM, channel_id: "chat_channels_1", user_id: ME, content: "@growth again", mentions: [{ kind: "role", role_id: GROWTH, short_id: "or-1", handle: "growth" }, MATE], created_at: NOW - 2 * H },
      { _id: "cm_old", team_id: TEAM, channel_id: "chat_channels_1", user_id: ME, content: "@growth old", mentions: [{ kind: "role", role_id: GROWTH, short_id: "or-1", handle: "growth" }], created_at: NOW - 10 * D },
    ],
    // What reached growth's frames this week: five outbox rows over four work
    // items (one task moved twice), one still waiting; one row from last month.
    role_wake_outbox: [
      ...["ct-p0", "ct-p1", "ct-r0"].map((id, i) => ({ _id: `wo${i}`, role_id: GROWTH, kind: "fold", cause: "task moved", ref: { table: "tasks", id }, created_at: NOW - (i + 1) * H, due_at: NOW, flushed_at: NOW - i * H })),
      { _id: "wo_again", role_id: GROWTH, kind: "passive", cause: "task moved", ref: { table: "tasks", id: "ct-p0" }, created_at: NOW - 3 * H, due_at: NOW, flushed_at: NOW - 2 * H },
      { _id: "wo_wait", role_id: GROWTH, kind: "passive", cause: "plan moved", ref: { table: "plans", id: "plans_launch" }, created_at: NOW - H, due_at: NOW },
      { _id: "wo_old", role_id: GROWTH, kind: "fold", cause: "old", ref: { table: "tasks", id: "ct-old" }, created_at: NOW - 20 * D, due_at: NOW - 20 * D, flushed_at: NOW - 20 * D },
    ],
    session_owners: [], managed_sessions: [], messages: [], user_presence: [], project_updates: [], commits: [], artifacts: [], conversation_images: [], counters: [],
    ...extra,
  });
}

const ctxOf = (db: any) => ({ db }) as any;
const codes = (flags: { code: string }[]) => flags.map((f) => f.code).sort();

describe("org.health", () => {
  test("a role flagged at the previous review reads as the second breach", async () => {
    const db = fixtures();
    await db.patch(GROWTH as any, { overload_streak: 1 });
    const r = await computeOrgHealth(ctxOf(db), ME as any, TEAM, NOW);
    const growth = r.roles.find((x) => x.handle === "growth")!;
    expect(growth.breaches).toBe(1);
    expect(growth.flags.find((f) => f.code === "overloaded")!.detail).toContain("flagged at 1 earlier review in a row, so this is breach 2");
  });

  test("an overloaded role and an idle one, each with its signals and flags", async () => {
    const r = await computeOrgHealth(ctxOf(fixtures()), ME as any, TEAM, NOW);
    expect(r.workspace).toEqual({ kind: "team", id: TEAM });
    const growth = r.roles.find((x) => x.handle === "growth")!;
    // The ledger is what the scope holds; the load is what reached the seat
    // this week: 4 distinct work items in its frames (its wake outbox; the
    // scope's churn of 31 changed rows is flow, not load), 6 decisions, 6 live
    // hands against its own cap of 6, 4 stalls (3 in review past the window,
    // 1 hand blocked on a task still open), 2 cap hit days.
    expect(growth.ledger).toEqual({ open_tasks: 27, in_flight: 9, active_plans: 1 });
    expect(growth.load).toEqual({ items_per_day: 4 / 7, decisions_per_day: 6 / 7, live_hands: 6, hands_cap: 6, direct_reports: 0, open_stalls: 4, cap_hit_days: 2 });
    expect(growth.spend.wakes_by_day).toEqual(expect.any(Object));
    expect(Object.values(growth.spend.wakes_by_day as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(4);
    // 27 open rows plus the two closes of the week; the close 20 days ago is
    // outside the window and not read at all.
    expect(growth.counted).toMatchObject({ rule: "scope", projects: 1, plans: 2, tasks: 29, complete: true });
    expect(growth.counted.note).toContain("by the scope rule");
    // Volume axes only: hands sit exactly at the line, so the ratio is 1 and
    // the stalls and cap hits breach without making a structural split.
    expect(growth.overload_ratio).toBeCloseTo(1);
    expect(growth.spend).toMatchObject({ wakes_today: 4, wakes_cap: 4, tokens_today: 1000, tokens_7d_avg: null, cap_hits_7d: 2 });
    // Delivered wakes only: the dropped frame spent nothing against the cap.
    expect(growth.spend.wakes_7d_avg).toBeCloseTo(4 / 7);
    // Samples: 4, 12, 20 (recommended), 30 (silent past the deadline), 40 (never answered before the person did); the 2 minute one is too young.
    expect(growth.flow).toMatchObject({
      decisions_7d: 6, items_reached_7d: 4, items_changed_7d: 31, hands_window: 7, median_recommend_min: 20, escalations_7d: 0, frames_dropped_7d: 1, done_7d: 2,
      handoffs_7d: { done: 2, blocked: 1, needs_context: 0 }, review_stalls: 3, mentions_7d: 2,
    });
    expect(growth.flow.sends_7d).toEqual({ to: [], from: [{ role_id: BILLING, handle: "billing", n: 6 }] });
    expect(growth.last_move_at).toBe(NOW - 3 * D);
    expect(growth.idle_days).toBe(0);
    expect(codes(growth.flags)).toEqual(["cap_hit", "chatter", "no_charter", "overloaded", "review_stall", "slow_to_recommend", "wide_ledger"]);
    expect(growth.flags.find((f) => f.code === "overloaded")).toMatchObject({ severity: "blocker" });
    expect(growth.flags.find((f) => f.code === "overloaded")!.detail).toContain("4 open stalls (model: 3), 2 cap hit days this week (model: 1)");
    expect(growth.flags.find((f) => f.code === "wide_ledger")!.detail).toContain("27 open tasks (frame lists: 25), 9 tasks in flight (frame lists: 8)");
    // The stability clock: no review has flagged this role yet, so the flag
    // says so and the row carries breaches 0 with overloaded_now for the
    // review that will record it.
    expect(growth.breaches).toBe(0);
    expect(growth.overloaded_now).toBe(true);
    expect(growth.flags.find((f) => f.code === "overloaded")!.detail).toContain("first breach on record");
    // The company's budget today: the caps of every active role, summed once.
    // Growth carries its own caps (6, 4, 400k); billing has none and takes the
    // defaults (6, 40, 400k). Both are active.
    expect(r.company.caps_total).toEqual({ hands_per_day: 12, wakes_per_day: 44, tokens_per_day: 800_000 });

    const billing = r.roles.find((x) => x.handle === "billing")!;
    expect(billing.ledger).toEqual({ open_tasks: 0, in_flight: 0, active_plans: 0 });
    expect(billing.load).toEqual({ items_per_day: 0, decisions_per_day: 1 / 7, live_hands: 0, hands_cap: 6, direct_reports: 0, open_stalls: 0, cap_hit_days: 0 });
    expect(billing.flow).toMatchObject({ decisions_7d: 1, median_recommend_min: null, escalations_7d: 1, done_7d: 0 });
    expect(billing.flow.sends_7d).toEqual({ to: [{ role_id: GROWTH, handle: "growth", n: 6 }], from: [] });
    expect(billing.idle_days).toBeNull();
    expect(billing.last_move_at).toBeNull();
    expect(codes(billing.flags)).toEqual(["chatter", "idle"]);
    expect(billing.flags.find((f) => f.code === "idle")?.detail).toContain("since the role was created 40 days ago");

    const me = r.people.find((p) => p.name === "Me")!;
    expect(me).toMatchObject({ direct_roles: 2, decisions_waiting: { n: 2, oldest_min: 24 * 60 }, flags: [] });
    expect(r.people.find((p) => p.name === "Mate")).toMatchObject({ direct_roles: 0, decisions_waiting: { n: 0, oldest_min: null } });

    expect(r.company.unowned_projects).toEqual([{ id: R, title: "Orphan" }]);
    expect(r.company.unfiled_tasks).toBe(1);
    expect(r.company.plans_without_goal).toEqual([{ id: "plans_launch", title: "Launch" }]);
    expect(r.company.projects_without_charter.map((p) => p.title).sort()).toEqual(["Billing", "Orphan"]);
    expect(r.company.unfiled_plans).toEqual([{ id: "plans_loose", title: "Loose", short_id: "pl-3", open_tasks: 1 }]);
    // Billing was last touched exactly 30 days ago and has no task, plan or
    // session on it (S9): the company reads it as a stale project.
    expect(r.company.stale.projects).toEqual([{ id: Q, title: "Billing", reason: "no activity 30d" }]);
    expect(codes(r.company.flags)).toEqual(["no_charter", "no_charter", "no_charter", "stale_project", "unfiled_plan", "unowned", "unowned"]);
    expect(r.truncated).toEqual({ sessions: false, tasks: false, plans: false, projects: false, decisions: false });
    expect(r.generated_at).toBe(NOW);
  });

  test("an owner role on a project counts as ownership; a whole workspace role holds the remainder and owns nothing", async () => {
    const owned = await computeOrgHealth(ctxOf(fixtures({
      projects: [{ _id: R, user_id: ME, team_id: TEAM, workspace: WS, short_id: "pr-3", title: "Orphan", status: "active", owner_role_id: BILLING, created_at: 1, updated_at: NOW }],
    })), ME as any, TEAM, NOW);
    expect(owned.company.unowned_projects).toEqual([]);
    const db = fixtures();
    await db.insert("org_roles", { short_id: "or-9", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Chief of Staff", handle: "chief-of-staff", scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", charter: "x", created_by: ME, created_at: NOW - 30 * D, updated_at: 1 });
    const whole = await computeOrgHealth(ctxOf(db), ME as any, TEAM, NOW);
    // Hiring the chief of staff does not turn the unowned signal off.
    expect(whole.company.unowned_projects).toEqual([{ id: R, title: "Orphan" }]);
    const cos = whole.roles.find((x) => x.handle === "chief-of-staff")!;
    // Its ledger is what no narrower role covers: the unfiled task, the loose plan's open task, the two projectless plans; its idle clock is the newest event anywhere.
    expect(cos.ledger).toEqual({ open_tasks: 2, in_flight: 0, active_plans: 2 });
    expect(cos.load).toMatchObject({ items_per_day: 0, decisions_per_day: 0, live_hands: 0, open_stalls: 0, cap_hit_days: 0 });
    expect(cos.flow.items_changed_7d).toBe(5);
    expect(cos.counted).toMatchObject({ rule: "remainder", projects: 1, plans: 2, tasks: 3, complete: true });
    expect(cos.idle_days).toBe(0);
    expect(cos.flags).toEqual([]);
    // Growth's own numbers are untouched by the root seat.
    expect(whole.roles.find((x) => x.handle === "growth")!.ledger.open_tasks).toBe(27);
  });

  test("a non member sees nothing of the team; a personal workspace reads the caller's roles", async () => {
    const db = fixtures();
    await expect(computeOrgHealth(ctxOf(db), "u".repeat(31) + "o" as any, TEAM, NOW)).rejects.toThrow();
    const personal = await computeOrgHealth(ctxOf(db), ME as any, undefined, NOW);
    expect(personal.roles).toEqual([]);
    expect(personal.people.map((p) => p.name)).toEqual(["Me"]);
  });

  test("a program role whose plan is done raises program_ended (S10)", async () => {
    // Billing becomes a program role ending with a done plan; growth stays standing.
    const db = fixtures({
      org_roles: [
        { _id: GROWTH, short_id: "or-1", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Growth lead", handle: "growth", scope: { project_ids: [P], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", anchor_id: "anchors_growth", caps: { hands_per_day: 6, wakes_per_day: 4, tokens_per_day: 400_000 }, counters: { day: new Date(NOW).toISOString().slice(0, 10), hands: 2, wakes: 4, tokens: 1000 }, created_by: ME, created_at: NOW - 30 * D, updated_at: 1 },
        { _id: BILLING, short_id: "or-2", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Billing lead", handle: "billing", scope: { project_ids: [Q], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", anchor_id: "anchors_billing", charter: "Owns billing.", tenure: { kind: "program", ends: { plan: "plans_done" }, then: "retire" }, created_by: ME, created_at: NOW - 40 * D, updated_at: 1 },
      ],
    });
    const r = await computeOrgHealth(ctxOf(db), ME as any, TEAM, NOW);
    const billing = r.roles.find((x) => x.handle === "billing")!;
    const ended = billing.flags.find((f) => f.code === "program_ended");
    expect(ended).toMatchObject({ severity: "warn" });
    expect(ended!.detail).toContain("its plan pl-2 is done");
    // Growth is standing; no program_ended.
    expect(r.roles.find((x) => x.handle === "growth")!.flags.some((f) => f.code === "program_ended")).toBe(false);
  });

  test("roleActivity reads the wake log the way the analyzer inputs do", async () => {
    const db = fixtures();
    const growth = await db.get(GROWTH as any);
    const a = await roleActivity(ctxOf(db), ME as any, growth, NOW, { wholeWorkspaceLatest: null });
    expect(a.wakes_7d).toMatchObject({ total: 4, delivered: 4, dropped: 1, held: 1, days_at_cap: 1, cap_hit_days: 2 });
    expect(a).toMatchObject({ idle: false, age_days: 30 });
    // A whole workspace role reads the clock it is handed; with no event anywhere its age decides.
    const cos = { _id: "x", scope: { project_ids: [], plan_ids: [] }, created_at: NOW - 20 * D };
    expect(await roleActivity(ctxOf(db), ME as any, cos, NOW, { wholeWorkspaceLatest: NOW - D })).toMatchObject({ idle_days: 1, idle: false });
    expect(await roleActivity(ctxOf(db), ME as any, cos, NOW, { wholeWorkspaceLatest: null })).toMatchObject({ idle_days: null, age_days: 20, idle: true });
    expect(HEALTH_CAPS.tasks).toBe(2000);
  });
});

// readWorkTasks (S3): every open row by status, the week's changes by the
// updated index, mined suggestions left out, a floor reported per slice. A
// newest-N read of the table would drop the old open rows the stale detector
// exists for, so the reader never takes that shape.
describe("readWorkTasks", () => {
  test("reads every open row whatever its age, adds the recent closes, leaves suggestions out, and reports a floor per slice", async () => {
    const { readWorkTasks } = await import("./orgHealth");
    const db = fixtures({
      tasks: [
        task("ct-old-open", { status: "open", updated_at: NOW - 200 * D, created_at: 1 }),
        task("ct-old-prog", { status: "in_progress", updated_at: NOW - 60 * D, created_at: 1 }),
        task("ct-backlog", { status: "backlog", updated_at: NOW - 90 * D }),
        task("ct-done-recent", { status: "done", updated_at: NOW - 2 * D }),
        task("ct-done-old", { status: "done", updated_at: NOW - 40 * D }),
        task("ct-dropped-recent", { status: "dropped", updated_at: NOW - D }),
        task("ct-sugg", { status: "open", source: "insight", triage_status: "suggested", updated_at: NOW - D }),
        task("ct-dismissed", { status: "open", triage_status: "dismissed", updated_at: NOW - D }),
      ],
    });
    const r = await readWorkTasks(ctxOf(db), ME as any, TEAM, { perStatus: 100, updatedSince: NOW - 7 * D, recentCap: 100 });
    expect(r.tasks.map((t) => t.short_id).sort()).toEqual(["ct-backlog", "ct-done-recent", "ct-dropped-recent", "ct-old-open", "ct-old-prog"]);
    expect(r.any_truncated).toBe(false);
    // A slice at its cap is a floor, named per status.
    const capped = await readWorkTasks(ctxOf(db), ME as any, TEAM, { perStatus: 2, updatedSince: NOW - 7 * D, recentCap: 100 });
    expect(capped.truncated).toMatchObject({ open: true, in_progress: false, backlog: false, in_review: false, recent: false });
    expect(capped.any_truncated).toBe(true);
  });
});

// A stall is a hand stuck on a task still open, however old; a seat the work
// passes by is named bypassed (S2).
describe("org.health stalls and the bypassed seat", () => {
  test("a hand blocked eight days ago on an open task still counts; a closed task's leftover blocked does not", async () => {
    const db = fixtures({ tasks: [
      task("ct-stuck", { status: "in_progress", execution_status: "blocked", updated_at: NOW - 8 * D }),
      task("ct-ctx", { status: "open", execution_status: "needs_context", updated_at: NOW - 30 * D }),
      task("ct-closed", { status: "done", execution_status: "blocked", updated_at: NOW - D }),
    ] });
    const growth = (await computeOrgHealth(ctxOf(db), ME as any, TEAM, NOW)).roles.find((x) => x.handle === "growth")!;
    expect(growth.load.open_stalls).toBe(2);
  });

  test("a scope that closes work with no hand under the seat and no decision routed to it raises bypassed", async () => {
    const db = fixtures({
      tasks: Array.from({ length: 12 }, (_, i) => task(`ct-b${i}`, { status: "done", updated_at: NOW - D })),
      conversations: [conv(S_GROWTH, { standing_role_id: GROWTH, anchor_id: "anchors_growth", persistent: true }), conv(S_BILLING, { standing_role_id: BILLING, anchor_id: "anchors_billing", persistent: true, project_path: "/repo/elsewhere" })],
      session_decisions: [], decision_inbox: [],
    });
    const growth = (await computeOrgHealth(ctxOf(db), ME as any, TEAM, NOW)).roles.find((x) => x.handle === "growth")!;
    expect(growth.flow).toMatchObject({ done_7d: 12, hands_window: 0, decisions_7d: 0 });
    expect(codes(growth.flags)).toContain("bypassed");
    expect(codes(growth.flags)).not.toContain("idle");
  });
});

describe("org.health idle clock on a narrow scope", () => {
  test("a scope whose last task closed nine days ago reads nine idle days, not never active", async () => {
    const db = fixtures({ tasks: [task("ct-closed9", { status: "done", updated_at: NOW - 9 * D })], plans: [], conversations: [conv(S_GROWTH, { standing_role_id: GROWTH, anchor_id: "anchors_growth", persistent: true, updated_at: NOW - 12 * D, project_path: "/repo/elsewhere" })] });
    const growth = (await computeOrgHealth(ctxOf(db), ME as any, TEAM, NOW)).roles.find((x) => x.handle === "growth")!;
    expect(growth.idle_days).toBe(9);
    expect(codes(growth.flags)).not.toContain("idle");
  });
});
