// A typed proposal and health payload matching org-staffing.md S3 and S4,
// against the ids ORG_FIXTURE uses. The pane's tests pin their grouping and
// counts on it, and the DEV preview (`/org?preview=1`) paints it so the pane
// can be designed before the backend answers.
import type { OrgHealth, OrgProposalRow } from "./orgStaffingTypes";

const T0 = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const ME = "fixture-user-me";
const SAM = "fixture-user-sam";
const GROWTH = "fixture-role-growth";

export const ORG_STAFFING_FIXTURE_PROPOSAL: OrgProposalRow = {
  _id: "fixture-proposal-7",
  short_id: "op-7",
  team_id: "fixture-team",
  author: { kind: "role", id: "fixture-role-chief", name: "Chief of Staff", short_id: "or-9" },
  title: "Split growth, own the platform work, budget the reviews",
  summary_md: "Growth is past its in-flight limit and the platform project has no owner. Two hires, one move and one budget change remove both bottlenecks.",
  mode: "review",
  status: "open",
  created_at: T0 - 2 * 3_600_000,
  changes: [
    {
      _id: "fixture-change-1", proposal_id: "fixture-proposal-7", seq: 1, status: "proposed",
      change: { kind: "role", name: "Head of Platform", handle: "platform", reports_to: "me", scope: { projects: ["Platform"] }, charter: "Owns the sync layer, the daemon and every release of the CLI." },
      rationale: "The Platform project has 14 open tasks and no owner role; its sessions report straight to you and three of them asked for a decision this week.",
      evidence: [{ label: "14 open tasks in Platform", href: "/tasks?project=Platform" }, { label: "3 decisions waiting", href: "/decisions" }],
      expected_effect: "Platform decisions get a recommendation within the hop deadline.",
      risk: "A new role reads the whole project on its first wake; the first brief will be long.",
    },
    {
      _id: "fixture-change-2", proposal_id: "fixture-proposal-7", seq: 2, status: "proposed",
      change: { kind: "role", name: "Content Lead", handle: "content", reports_to: "@growth", scope: { plans: ["pl-88"] }, charter: "Owns the SEO plan and the weekly post." },
      rationale: "Growth carries 11 tasks in flight against a limit of 8; the SEO plan is half of them and has its own cadence.",
      evidence: [{ label: "11 in flight under @growth", href: "/org/or-1?tab=tasks" }],
      expected_effect: "Growth drops below the in-flight limit without dropping the SEO work.",
    },
    {
      _id: "fixture-change-3", proposal_id: "fixture-proposal-7", seq: 3, status: "accepted",
      change: { kind: "projects", changes: [{ op: "create", title: "Platform", description: "The sync layer, the daemon, the CLI." }] },
      rationale: "Twenty two of your direct sessions touch ~/src/platform and none of them file under a project.",
      evidence: [{ label: "22 sessions in ~/src/platform", href: "/feed?project=platform" }],
    },
    {
      _id: "fixture-change-4", proposal_id: "fixture-proposal-7", seq: 4, status: "proposed",
      change: { kind: "budget", handle: "growth", caps: { tokens_per_day: 800_000 } },
      rationale: "Growth hit its token cap on four of the last seven days; the afternoon flush held its wakes each time.",
      evidence: [{ label: "4 cap hits in 7 days", href: "/org/or-1?tab=settings" }],
      risk: "Doubles the role's daily spend ceiling.",
    },
    {
      _id: "fixture-change-5", proposal_id: "fixture-proposal-7", seq: 5, status: "skipped",
      change: { kind: "routine", handle: "growth", title: "Weekly growth review", prompt: "Review the week's growth numbers and post the digest.", every: "7d" },
      rationale: "The review runs by hand every Monday; a routine makes it land without a nudge.",
      evidence: [],
      decided_at: T0 - 3_600_000,
    },
    {
      _id: "fixture-change-6", proposal_id: "fixture-proposal-7", seq: 6, status: "proposed",
      change: { kind: "project_meta", project: "Growth", goal: "Double organic signups by December", success_metrics: ["organic signups per week", "AI citation count"], priority: "p1", owner: "@growth" },
      rationale: "The Growth project has no goal on record; the role directs its hands toward the task list instead.",
      evidence: [{ label: "Growth project", href: "/projects/fixture-project-growth" }],
    },
  ],
};

export const ORG_STAFFING_FIXTURE_HEALTH: OrgHealth = {
  roles: [
    {
      role_id: GROWTH, short_id: "or-1", handle: "growth",
      load: { open_tasks: 19, in_flight: 11, active_plans: 2, live_hands: 4, direct_reports: 0 },
      spend: { wakes_today: 22, wakes_7d_avg: 27, wakes_cap: 40, tokens_today: 390_000, tokens_7d_avg: 372_000, tokens_cap: 400_000, cap_hits_7d: 4 },
      flow: { decisions_7d: 9, median_recommend_min: 3, escalations_7d: 2, frames_dropped_7d: 1, done_7d: 12, handoffs_7d: { done: 10, blocked: 1, needs_context: 1 }, review_stalls: 1, sends_7d: { to: [], from: [] } },
      last_move_at: T0 - 86_400_000 * 12, idle_days: 0,
      flags: [
        { code: "overloaded", severity: "warn", detail: "11 tasks in flight against a limit of 8" },
        { code: "cap_hit", severity: "warn", detail: "hit the token cap on 4 of the last 7 days" },
        { code: "review_stall", severity: "info", detail: "one task in review for 26 hours" },
      ],
    },
  ],
  people: [
    { user_id: ME, direct_roles: 1, decisions_waiting: { n: 3, oldest_min: 140 }, flags: [] },
    { user_id: SAM, direct_roles: 0, decisions_waiting: { n: 0, oldest_min: 0 }, flags: [] },
  ],
  company: {
    unowned_projects: [{ id: "fixture-project-platform", title: "Platform" }],
    unfiled_tasks: 7,
    plans_without_goal: [],
    projects_without_charter: [{ id: "fixture-project-growth", title: "Growth" }],
    flags: [
      { code: "unowned", severity: "blocker", detail: "Platform has no owner role" },
      { code: "no_charter", severity: "warn", detail: "Growth has no goal on record" },
    ],
  },
  generated_at: T0,
};
