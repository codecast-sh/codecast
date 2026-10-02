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
  author: { kind: "role", id: "fixture-role-head", name: "Head of People", short_id: "or-9" },
  thread: { conversation_id: "fixture-head-conv", short_id: "jx7ch1f" },
  title: "Split growth, own the platform work, budget the reviews",
  summary_md: "Growth is past its in-flight limit and the platform project has no owner. Two hires, one move and one budget change remove both bottlenecks.",
  mode: "review",
  status: "open",
  created_at: T0 - 2 * 3_600_000,
  changes: [
    {
      _id: "fixture-change-1", proposal_id: "fixture-proposal-7", seq: 1, status: "proposed",
      change: { kind: "role", name: "Head of Platform", handle: "platform", reports_to: "me", scope: { projects: ["Platform"] }, charter: "Owns the sync layer, the daemon and every release of the CLI.", tenure: { kind: "standing" } },
      rationale: "The Platform project has 14 open tasks and no owner role; its sessions report straight to you and three of them asked for a decision this week.",
      evidence: [{ label: "14 open tasks in Platform", href: "/tasks?project=Platform" }, { label: "3 decisions waiting", href: "/decisions" }],
      expected_effect: "Platform decisions get a recommendation within the hop deadline.",
      risk: "A new role reads the whole project on its first wake; the first brief will be long.",
    },
    {
      _id: "fixture-change-2", proposal_id: "fixture-proposal-7", seq: 2, status: "proposed",
      change: { kind: "role", name: "Content Lead", handle: "content", reports_to: "@growth", scope: { plans: ["pl-88"] }, charter: "Owns the SEO plan and the weekly post.", tenure: { kind: "program", ends: { plan: "pl-88" }, then: "review" } },
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
    {
      _id: "fixture-change-7", proposal_id: "fixture-proposal-7", seq: 7, status: "proposed",
      change: { kind: "plan_status", plan: "pl-61", status: "done", title: "Onboarding emails", reason: "Every task closed 19 days ago; the two bound sessions ended with done handoffs." },
      rationale: "The plan reads as active on the board and counts against Growth's load, but nothing under it has moved since August.",
      evidence: [{ label: "pl-61", href: "/plans/pl-61" }, { label: "last handoff", href: "/tasks/ct-4102" }],
      expected_effect: "Growth's active plan count drops to one, which is what its sessions say.",
    },
    {
      _id: "fixture-change-8", proposal_id: "fixture-proposal-7", seq: 8, status: "proposed",
      change: { kind: "task_status", task: "ct-4102", status: "done", title: "Fix the auth race on sign-in", reason: "Three commits landed on the branch it names; the session that held it declared done 14 days ago." },
      rationale: "An open task whose work shipped keeps a seat looking busier than it is.",
      evidence: [{ label: "ct-4102", href: "/tasks/ct-4102" }],
    },
  ],
};

/** The head of people's proposal after a conversation (S18): the author
 *  removed one change on the person's word, amended another and added a
 *  third, and the thread bound to it is the Head of People's standing session. The
 *  pane's revise rows and the strip pin on this. */
export const ORG_STAFFING_FIXTURE_REVISED_PROPOSAL: OrgProposalRow = {
  _id: "fixture-proposal-9",
  short_id: "op-9",
  team_id: "fixture-team",
  author: { kind: "role", id: "fixture-role-head", name: "Head of People", short_id: "or-9" },
  thread: { conversation_id: "fixture-head-conv", short_id: "jx7ch1f" },
  title: "Own the platform work, budget the reviews",
  summary_md: "The platform project has no owner and growth runs out of budget most afternoons. One hire and one budget change fix both.",
  mode: "review",
  status: "open",
  created_at: T0 - 3 * 3_600_000,
  changes: [
    {
      _id: "fixture-change-91", proposal_id: "fixture-proposal-9", seq: 1, status: "proposed",
      change: { kind: "role", name: "Head of Platform", handle: "platform", reports_to: "me", scope: { projects: ["Platform"] }, charter: "Owns the sync layer, the daemon and every release of the CLI.", tenure: { kind: "standing" } },
      rationale: "The Platform project has 14 open tasks and no owner role; its sessions report straight to you.",
      evidence: [{ label: "14 open tasks in Platform", href: "/tasks?project=Platform" }],
    },
    {
      _id: "fixture-change-92", proposal_id: "fixture-proposal-9", seq: 2, status: "removed",
      change: { kind: "role", name: "Content Lead", handle: "content", reports_to: "@growth", scope: { plans: ["pl-88"] }, charter: "Owns the SEO plan and the weekly post.", tenure: { kind: "program", ends: { plan: "pl-88" }, then: "review" } },
      rationale: "Growth carries 11 tasks in flight against a limit of 8; the SEO plan is half of them.",
      evidence: [{ label: "11 in flight under @growth", href: "/org/or-1?tab=tasks" }],
      revision: { kind: "removed", note: "You said the SEO plan is winding down, so a seat for it would outlive the work.", at: T0 - 40 * 60_000 },
    },
    {
      _id: "fixture-change-93", proposal_id: "fixture-proposal-9", seq: 3, status: "proposed",
      change: { kind: "budget", handle: "growth", caps: { tokens_per_day: 800_000 } },
      rationale: "Growth hit its token cap on four of the last seven days; the afternoon flush held its wakes each time.",
      evidence: [{ label: "4 cap hits in 7 days", href: "/org/or-1?tab=settings" }],
      risk: "Doubles the role's daily spend ceiling.",
      revision: { kind: "amended", note: "Raised to what four afternoons a week of held wakes need, per your note.", at: T0 - 30 * 60_000, before: { kind: "budget", handle: "growth", caps: { tokens_per_day: 600_000 } } },
    },
    {
      _id: "fixture-change-94", proposal_id: "fixture-proposal-9", seq: 4, status: "applied",
      change: { kind: "projects", changes: [{ op: "create", title: "Platform", description: "The sync layer, the daemon, the CLI." }] },
      rationale: "Twenty two of your direct sessions touch ~/src/platform and none of them file under a project.",
      evidence: [],
      decided_at: T0 - 2 * 3_600_000, applied_at: T0 - 2 * 3_600_000,
    },
    {
      _id: "fixture-change-95", proposal_id: "fixture-proposal-9", seq: 5, status: "proposed",
      change: { kind: "routine", handle: "platform", title: "Release check", prompt: "Read the release workflow runs since yesterday and post what failed.", every: "1d" },
      rationale: "Two of the last five CLI releases failed on the finalize step and nobody saw it for a day.",
      evidence: [{ label: "2 failed releases", href: "/releases" }],
      revision: { kind: "added", note: "You asked who watches the releases; this is the answer.", at: T0 - 20 * 60_000 },
    },
  ],
};

/** A second fixture proposal written by a session, not a role (S15): the
 *  author pill's other shape, and a proposal the pane's picker can switch to. */
export const ORG_STAFFING_FIXTURE_SESSION_PROPOSAL: OrgProposalRow = {
  _id: "fixture-proposal-8",
  short_id: "op-8",
  team_id: "fixture-team",
  author: { kind: "session", id: "fixture-conv-review", name: "Org review, September", short_id: "jx7rev1" },
  title: "Retire the ops seat",
  summary_md: "Ops has had no wake in 30 days and its two plans are done.",
  mode: "review",
  status: "open",
  created_at: T0 - 26 * 3_600_000,
  changes: [
    {
      _id: "fixture-change-9", proposal_id: "fixture-proposal-8", seq: 1, status: "proposed",
      change: { kind: "retire", handle: "ops", reason: "idle 30 days" },
      rationale: "No wake, no hand, no decision in 30 days; both plans in scope are done.",
      evidence: [{ label: "@ops health", href: "/org/or-4?tab=health" }],
    },
    // The company's goals (initiatives-projects-role-page.md "I1, revised"):
    // a goal set with its projects and owner, a project added to one, an
    // owner named for one; the pane folds the three into the goals ask.
    {
      _id: "fixture-change-10", proposal_id: "fixture-proposal-8", seq: 2, status: "proposed",
      change: { kind: "initiative", title: "Win the private network", description: "Three brokers trade through us every week and Quiet is onboarded.", projects: ["Growth", "pr-77"], owner: "@growth" },
      rationale: "Growth and Broker outreach both name the private network as their Q3 goal; the initiatives page holds no goal for it.",
      evidence: [{ label: "Growth charter", href: "/projects/Growth" }],
      expected_effect: "One page says what winning the private network looks like, with both projects under it.",
    },
    {
      _id: "fixture-change-11", proposal_id: "fixture-proposal-8", seq: 3, status: "proposed",
      change: { kind: "initiative_projects", initiative: "in-3", title: "Every project has a lead", projects: ["Growth"] },
      rationale: "The Growth project's lead work serves the goal and the goal does not list it.",
      evidence: [],
    },
    {
      _id: "fixture-change-12", proposal_id: "fixture-proposal-8", seq: 4, status: "proposed",
      change: { kind: "initiative_owner", initiative: "in-3", title: "Every project has a lead", owner: "Ashot Petrosian" },
      rationale: "The goal is active and nobody drives it; Ashot set it and answers for the leads.",
      evidence: [],
    },
  ],
};

/** A week by UTC day, oldest first and today last, the way org.health keys its series. */
const week = (xs: number[]): Record<string, number> => Object.fromEntries(xs.map((n, i) => [new Date(T0 - (xs.length - 1 - i) * 86_400_000).toISOString().slice(0, 10), n]));

export const ORG_STAFFING_FIXTURE_HEALTH: OrgHealth = {
  roles: [
    {
      role_id: GROWTH, short_id: "or-1", handle: "growth",
      load: { items_per_day: 9, decisions_per_day: 1.3, live_hands: 4, direct_reports: 0, open_stalls: 3, cap_hit_days: 4 },
      ledger: { open_tasks: 19, in_flight: 11, active_plans: 2 },
      counted: { rule: "scope", projects: 1, plans: 3, tasks: 31, complete: true, note: "1 projects and 3 plans in scope and every task filed under either: 31 tasks, read by index" },
      spend: { wakes_today: 22, wakes_7d_avg: 31, wakes_cap: 40, tokens_today: 390_000, tokens_7d_avg: 372_000, tokens_cap: 400_000, cap_hits_7d: 4, wakes_by_day: week([41, 40, 12, 18, 44, 40, 22]) },
      flow: { decisions_7d: 9, median_recommend_min: 3, done_7d: 12, done_by_day: week([2, 3, 0, 1, 3, 2, 1]), decisions_by_day: week([1, 2, 1, 0, 2, 2, 1]), handoffs_7d: { done: 10, blocked: 1, needs_context: 1 }, review_stalls: 1, sends_7d: { to: [], from: [{ role_id: "fixture-role-head", n: 3 }] } },
      last_move_at: T0 - 86_400_000 * 12, idle_days: 0,
      flags: [
        { code: "overloaded", severity: "warn", detail: "@growth has more reaching it than one role can answer: 4 days at its daily limit this week" },
        { code: "cap_hit", severity: "warn", detail: "@growth reached its daily limit and waited on 4 days this week" },
        { code: "review_stall", severity: "info", detail: "1 task in @growth's area has sat in review for more than a day" },
      ],
      // The area as the panel reads it (S29): stuck, with the role's own
      // line, the two sessions waiting under it, its goal and its check.
      area: {
        status: "stuck",
        status_line: "Stuck: 1 session under it waiting unanswered, 1 task stuck in review.",
        signals: [
          { code: "waiting_sessions", severity: "warn", text: "1 session under it has waited more than a day with no answer from it." },
          { code: "review_stall", severity: "warn", text: "1 task has sat in review for more than a day with nobody owning the verdict." },
          { code: "overloaded", severity: "warn", text: "More reaches it than one role can answer: 4 days at its daily limit this week." },
        ],
        standing: { project: "Growth", text: "Two landing pages shipped this week; the pricing page waits on a decision about the plans.", written_on: "2026-09-29", written_at: Date.parse("2026-09-29T00:00:00Z") },
        standing_lines: [
          { project: "Growth", text: "Two landing pages shipped this week; the pricing page waits on a decision about the plans.", written_on: "2026-09-29", written_at: Date.parse("2026-09-29T00:00:00Z") },
          { project: "SEO and AI citations", text: "Citations up a third since the schema change; no new pages.", written_on: "2026-09-22", written_at: Date.parse("2026-09-22T00:00:00Z") },
        ],
        waiting: [
          { id: "fixture-growth-2", short_id: "jx7gr02", title: "Pricing page copy", why: "blocked", since: T0 - 30 * 3_600_000, state: "Which plan names go on the page?" },
          { id: "fixture-growth-3", short_id: "jx7gr03", title: "Ads audit", why: "waiting", since: T0 - 2 * 3_600_000, state: null },
        ],
        goals: [
          { project: { id: "fixture-project-growth", title: "Growth", short_id: "pr-4" }, goal: "Double signups from organic search by December", open: 19, in_progress: 11, done_7d: 12 },
        ],
        checked_at: T0 - 5 * 3_600_000,
        check: { trigger_id: "fixture-trigger-growth-check", short_id: "tr-41", title: "Check Head of Growth's area", status: "scheduled", run_at: T0 + 19 * 3_600_000, last_run_at: T0 - 5 * 3_600_000, last_run_summary: "Two pages shipped; nothing needed the founder.", interval_ms: 86_400_000 },
        standing_conversation_id: "fixture-growth-conv",
        standing_short_id: "jx7gr0w",
      },
    },
    {
      role_id: "fixture-role-head", short_id: "or-9", handle: "head-of-people",
      load: { items_per_day: 2, decisions_per_day: 0.3, live_hands: 0, direct_reports: 0, open_stalls: 0, cap_hit_days: 0 },
      ledger: { open_tasks: 41, in_flight: 6, active_plans: 5 },
      spend: { wakes_today: 3, wakes_7d_avg: 4, wakes_cap: 40, tokens_today: 90_000, tokens_7d_avg: 110_000, tokens_cap: 400_000, cap_hits_7d: 0, wakes_by_day: week([4, 5, 3, 6, 4, 3, 3]) },
      flow: { decisions_7d: 2, median_recommend_min: 4, done_7d: 9, done_by_day: week([1, 2, 1, 1, 2, 1, 1]), decisions_by_day: week([0, 1, 0, 0, 1, 0, 0]), handoffs_7d: { done: 3, blocked: 0, needs_context: 0 }, review_stalls: 0, sends_7d: { to: [{ role_id: GROWTH, n: 3 }], from: [] } },
      last_move_at: null, idle_days: 0,
      flags: [],
      area: {
        status: "on_track",
        status_line: "On track.",
        signals: [],
        standing: { project: "Company", text: "Growth is carrying the quarter and is the one area with more on it than one role can follow; Platform has work and nobody looking after it. I proposed a Platform lead and splitting content out of Growth.", written_on: "2026-09-28", written_at: Date.parse("2026-09-28T00:00:00Z") },
        standing_lines: [
          { project: "Company", text: "Growth is carrying the quarter and is the one area with more on it than one role can follow; Platform has work and nobody looking after it. I proposed a Platform lead and splitting content out of Growth.", written_on: "2026-09-28", written_at: Date.parse("2026-09-28T00:00:00Z") },
        ],
        waiting: [],
        goals: [],
        checked_at: T0 - 26 * 3_600_000,
        check: { trigger_id: "fixture-trigger-company-review", short_id: "tr-12", title: "Company review", status: "scheduled", run_at: T0 + 5 * 86_400_000, last_run_at: T0 - 2 * 86_400_000, last_run_summary: "Proposed a Platform lead and a content split; three records closed.", interval_ms: 7 * 86_400_000 },
        standing_conversation_id: "fixture-head-conv",
        standing_short_id: "jx7ch1f",
      },
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

/**
 * The analyzer's first real review at scale (op-6 on 2026-09-16): 129
 * changes, 111 of them records to bring in line. The pane renders a records
 * group that size as one card (staffingModel.SYNC_CARD_THRESHOLD); three of
 * the plan changes carry the tasks they close, so those tasks nest under the
 * plan row instead of standing alone. Built, not typed out, so the shape is
 * exact and the counts are pinned by the tests.
 */
export const ORG_STAFFING_FIXTURE_BIG_PROPOSAL: OrgProposalRow = (() => {
  const id = "fixture-proposal-big";
  const changes: OrgProposalRow["changes"] = [];
  let seq = 0;
  const push = (change: OrgProposalRow["changes"][number]["change"], rationale: string, evidence: { label: string; href?: string }[] = []) => {
    seq += 1;
    changes.push({ _id: `fixture-big-${seq}`, proposal_id: id, seq, status: "proposed", change, rationale, evidence });
  };
  // Eight plans. The first three carry the tasks they close (the cascade);
  // their tasks are the first 4, 3 and 2 of the task rows below.
  const carried: Record<number, string[]> = { 1: ["ct-9001", "ct-9002", "ct-9003", "ct-9004"], 2: ["ct-9005", "ct-9006", "ct-9007"], 3: ["ct-9008", "ct-9009"] };
  const planReasons = [
    "Agent Organization v2 was a product proposal; the organization shipped through pl-622 (33 of 33 done). pl-544 sits at 5 of 20 with 15 open tasks nobody touched since September.",
    "The implementation roadmap: 0 of 16 done, 15 blocked, no session, last touched Sep 4. The same work landed as pl-622 and pl-679.",
    "Every task closed; the two bound sessions ended with done handoffs 19 days ago.",
    "Superseded by pl-689; no session for 30 days.",
    "Its 6 tasks are done on main (commits 1a2b3c4 to 9f8e7d6); the plan was never closed.",
    "No activity for 26 days; the owner's session declared done.",
    "Every task closed 12 days ago.",
    "No session and no commit naming it for 40 days.",
  ];
  for (let i = 1; i <= 8; i++) {
    const tasks = carried[i];
    push({ kind: "plan_status", plan: `pl-${500 + i}`, status: i === 2 || i === 4 ? "abandoned" : "done", title: `Plan ${i} of the roadmap`, reason: planReasons[i - 1], ...(tasks ? { tasks } : {}) } as any, `Plan ${i}: the board says active, the evidence says finished.`, [{ label: `pl-${500 + i}`, href: `/plans/pl-${500 + i}` }]);
  }
  // 103 tasks: the first nine are the ones the plans above carry.
  const taskReasons = [
    "Marked in progress since Aug 30 with its session done; the feature is on main: commit 602617b42 (Aug 30). Health flags it stale.",
    "In progress with no session for 26 days under pl-293, a plan already marked done; a task under a finished plan is finished.",
    "In progress with no session and no commit naming it for 26 days (created May 24).",
    "Its session ended with a done handoff 14 days ago; nobody closed the row.",
  ];
  for (let i = 1; i <= 103; i++) {
    push({ kind: "task_status", task: `ct-${9000 + i}`, status: i % 9 === 0 ? "dropped" : "done", title: `Task ${i} the tree already finished`, reason: taskReasons[i % taskReasons.length] }, `Task ${i}: open on the board, finished in the tree.`);
  }
  // 18 staffing changes, as the real review had them.
  for (let i = 1; i <= 10; i++) push({ kind: "file", plan: `pl-${600 + i}`, project: "Product" }, `pl-${600 + i} is product work with no project.`);
  for (let i = 1; i <= 4; i++) push({ kind: "project_meta", project: ["Product", "Infrastructure", "Growth", "Calls & Presence"][i - 1], goal: "A goal the charter was missing.", priority: "p1" }, "The project has no goal on record.");
  push({ kind: "role", name: "Calls lead", handle: "calls", reports_to: "me", tenure: { kind: "standing" } }, "The calls stack outlives any plan.", []);
  push({ kind: "scope", handle: "product", add: ["Calls & Presence"] }, "Product should read the calls project too.");
  push({ kind: "routine", handle: "product", title: "Weekly in-flight sweep", prompt: "Sweep the in-flight tasks.", every: "7d" }, "In-flight tasks go stale between reviews.");
  push({ kind: "adopt", handle: "head-of-people", conversation: "jx7fmm9" }, "This session becomes the head of people.");
  return {
    _id: id,
    short_id: "op-6",
    team_id: "fixture-team",
    author: { kind: "session", id: "fixture-conv-analyzer", name: "Staffing analyzer prompt update", short_id: "jx7fmm9" },
    title: "Company review: Codecast",
    summary_md: "The ask: bring 111 records in line, then one seat, one project, ten filings and four charters.",
    mode: "review",
    status: "open",
    created_at: T0 - 3_600_000,
    changes,
  };
})();
