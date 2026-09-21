// The bodies of the `cast org` staffing verbs and the analyzer prompt they
// build (docs/architecture/org-staffing.md S8; org-init.md O1, O2). orgInit.ts
// registers the verbs and loads this module inside each action, so the
// prompt, the capacity model and the proposal contract stay off the CLI boot
// graph (bench/bootGraph.guard.test.ts).
import * as fs from "fs";
import * as path from "path";
import { spawn } from "./proc.js";
import { fmt } from "./colors.js";
import { renderCapacityModel } from "@codecast/shared/contracts/orgCapacity";
import {
  ORG_CHANGE_KINDS, describeOrgChange, extractOrgProposal, orgChangeDependencies, orgChangeError, orgReviseOpError, orderOrgChanges, parseOrgProposalSpec,
  type OrgChange, type OrgProposalMode, type OrgReviseOp, type OrgSpecChange,
} from "@codecast/shared/contracts/orgProposal";
import { formatRelative } from "@codecast/shared/time";
import { formatDuration, parseDuration } from "./stackCommand.js";
import { CHIEF_OF_STAFF_HANDLE, ORG_ADOPT_RULE, ORG_ASKS_RULE, ORG_ASK_RULES, ORG_COVERAGE_RULE, ORG_INITIATIVES_RULE, ORG_LETTER_RULE, ORG_GROUNDING_RULES, ORG_INIT_HONESTY_RULES, ORG_INIT_LABEL, ORG_TENURE_RULE, ORG_UNNAMED_ROLES_RULE, ORG_ASKED_FOR_RULES, type OrgInitDeps, type OrgInitMode, type OrgInitSummary } from "./orgInit.js";

// ── The prompt (S8, S9, S10) ─────────────────────────────────────────────────
//
// Principle level: the company model, what to read, grounding in activity
// before records, the capacity model and how to reason with it, standing
// versus program tenure, how to design or review, how to write, what never to
// invent, and the one offer. The one prescriptive part is the spec shape,
// because `cast org propose` has to parse it.

/** The company model (S1), the words every surface and every prompt uses. */
export const COMPANY_MODEL = `A company is a workspace. Its executives are people: they own the budget, answer decisions and hire roles. A manager is a role: a standing agent with a scope, a charter, a brief and a daily budget of hands, wakes and tokens. A contributor is a hand: a session doing one piece of work, transient, reporting to a role or a person. An initiative is a goal the company is trying to reach, carried by the projects added to it and driven by one owner, a person or a role. A business line is a project, a lasting area of work with a charter; a program is a plan, a bounded effort under a project with a goal and success criteria. Staffing is which roles exist, what each owns, who each reports to and what each may spend. A proposal moves scope, people and budget together: staffing is budgeting.`;

/** The change kinds a proposal may carry and what each field means. */
function changeKindsReference(): string {
  return [
    `- plan_status: { plan: ref, status: "done" | "abandoned" | "active", reason }. A record brought in line with what happened: done when its evidence says the work landed, abandoned when nobody has worked it and nothing waits on it, active when a plan marked done still has sessions on it. The reason cites the evidence.`,
    `- task_status: { task: ref, status: "done" | "dropped" | "open" | "backlog", reason }. The same for a task: done when the commits or the sessions that carried it are finished, dropped when it was never picked up and its plan moved on, open or backlog when it was marked in progress and never worked but is still real work. Closing a plan drops its open tasks in the same accept (re-asserting done on a plan already marked done sweeps the rows still open under it the same way), so a task change under a plan change is only for a task whose evidence differs.`,
    `- project_status: { project: ref, status: "paused" | "done" | "active", reason }. The same for a business line: paused when its path had no commits and no sessions for the window, done when its goal is met, active when a paused one has work again.`,
    `- role: { name, handle, tenure: { kind: "standing" } | { kind: "program", ends: { plan: ref } | { project: ref } | { date: unix ms }, then: "retire" | "review" }, seat?: { existing: a session's short id, title, started_at, helpers }, scope?: { projects?: [ref], plans?: [ref] }, reports_to?: "@handle" | "me" | a member's name, charter?, trust?: "understand", caps?: { hands_per_day, wakes_per_day, tokens_per_day }, evidence?: [string] }. A new seat, with its tenure: standing, or a program with what ends it and what happens then. With \`seat\`, the role is a session that already runs: the four fields are copied from its row in \`sessions.long_running\`, accepting makes that session the role's standing session, and the change needs no adopt. Scope refs are a project's short id (pr-N), id or a title that matches one project; a plan's pl-N.`,
    `- projects: { changes: [{ op: "create", title, description?, project_path?, horizon?: "ongoing" | "bounded" } | { op: "merge", from, into }] }. Business lines the chart needs and does not have, or two that are one thing; a bounded line ends with its work and a program role can end with it.`,
    `- file: { plan: ref, project: ref }. A plan filed under a project, so the role that owns the project sees it; the smallest change there is, and the one that answers an unfiled_plan flag.`,
    `- move: { handle, reports_to?, scope_add?: [ref], scope_remove?: [ref], reason? }. A role under a different parent, or with a different scope, in one change.`,
    `- scope: { handle, add?: [ref], remove?: [ref] }. Only the scope.`,
    `- budget: { handle, caps: { hands_per_day?, wakes_per_day?, tokens_per_day? } }. Only the budget; say what it comes from.`,
    `- trust: { handle, trust: "understand" | "decide" | "direct" }. Propose it only with evidence the role has earned it; a person unlocks it.`,
    `- authority: { handle, authority: [{ id, kind: "spend" | "publish" | "write" | "connect", label, scope?, limit?: { usd_per_month?, usd_per_day?, per_day? }, expires?: "90d" }] }. What a person allows the role to do outside codecast, with explicit destinations, limits and review boundaries. Never infer an external grant from its trust level.`,
    `- hire: { handle, template, version, digest, instance, project: ref, config?: { input: value }, update_policy?: "manual" | "canary" | "stable" }. Hire a template on one project, paired with the role change for the same handle. Copy the version and SHA-256 digest from the verified template release; config holds input answers, never secret values.`,
    `- upgrade: { instance, template, to, digest }. Move an existing instance to a verified release of its template; copy the target version and SHA-256 digest from that release. The host applies the upgrade after acceptance.`,
    `- routine: { handle, title, prompt, every: "7d" | "1d" | ... }. Work the role should do on a cadence.`,
    `- project_meta: { project: ref, goal?, success_metrics?: [string], priority?: "p0".."p3", owner?: "@handle", non_goals?: [string], risks?: [string] }. A charter for a business line; only fields you can ground in the project's own tasks and docs.`,
    `- retire: { handle, reason? }. Last in the order; say where its work goes.`,
    `- adopt: { handle, conversation }. Only for the session this run is in: it becomes the named role's standing session. Any other session that already works as a role is a role change with a seat, never an adopt.`,
  ].join("\n");
}

const specExample = (mode: OrgInitMode, workspace: string) => JSON.stringify({
  title: orgProposalTitle(mode, workspace),
  summary_md: "The decision you ask for, then the evidence.",
  mode,
  changes: [
    {
      change: { kind: "role", name: "Head of Growth", handle: "growth", tenure: { kind: "standing" }, scope: { projects: ["pr-12"] }, reports_to: "me", charter: "One paragraph: what the seat owns, what it reports, what it raises." },
      rationale: "Why this change, in the reader's words; for a role, why standing or why a program.",
      evidence: [{ label: "14 sessions on ~/src/growth in 30 days", href: "https://codecast.sh/org?scope=pr-12" }],
      expected_effect: "What should be different at the next review, and how you will know.",
      risk: "What could go wrong, and what you would watch.",
    },
  ],
  asks: [
    { title: "What the person is agreeing to, readable on its own", why: "One sentence of why.", effect: "One line of what changes for them when they accept.", seqs: [1] },
  ],
}, null, 2);

export function orgProposalTitle(mode: OrgInitMode, workspace: string): string {
  return mode === "init" ? `Staffing for ${workspace}` : `Company review: ${workspace}`;
}

export type PromptFacts = {
  mode: OrgInitMode;
  workspace: string;
  teamFlag?: string;
  summary: OrgInitSummary;
  /** The session the analyzer runs in, when known: the adopt change names it. */
  session?: string;
  /** A proposal of this kind still open: the review reads, it does not repost. */
  open?: { short_id: string; title: string; decided: number; total: number; url: string };
};

export function buildOrgAnalyzerPrompt(opts: PromptFacts): string {
  const { mode, workspace, summary } = opts;
  const team = opts.teamFlag ? ` --team ${JSON.stringify(opts.teamFlag)}` : "";
  const roots = summary.git_roots.length ? summary.git_roots.map((r) => `  - ${r}`).join("\n") : "  (no git roots seen on recent sessions)";

  const purpose = mode === "init"
    ? `# Propose the organization for ${workspace}

You are designing the first staffing of this company: which roles own its work, what each owns, who each reports to, and what each may spend. The executives decide; you propose. Every change you post is a ghost on the org page until a person accepts, edits or skips it, and nothing is applied by you.`
    : `# Review the company: ${workspace}

You are reviewing how work flows through this company against the capacity model, and proposing the smallest changes that remove a bottleneck. The executives decide; you propose. Every change you post is a ghost on the org page until a person accepts, edits or skips it, and nothing is applied by you.`;

  const model = `## The company model

${COMPANY_MODEL}`;

  const glance = `## The company at a glance

${summary.projects} projects, ${summary.plans} plans, ${summary.tasks_open} open tasks, ${summary.members} members, ${summary.sessions_30d} sessions in 30 days, ${summary.roles} existing roles${summary.chief_of_staff ? ", a chief of staff" : ", no chief of staff"}. ${coverageGlance(summary.coverage)}${staleGlance(summary.stale)}`;

  const read = `## What to read, before you form a view

1. \`cast org inputs${team} --json\`, from the top of the tree down. Its \`coverage\` block first: the open initiatives with their owners, health and projects, every project with work and its lead, and the work that sits outside any project. Then its \`activity\` block: where the commits and sessions of the last 30 days are, by repository and top level path, who works where, and the plans, tasks and projects the evidence says are stale, each with its reason. Then \`sessions.long_running\`: the sessions older than a week that still run, each with what it has done and what it spent in the last week (\`use_7d\`: input plus output tokens and model calls a day, the days the figure covers, and \`counted: false\` when its messages carry no usage, which is not zero use). Then the rest, whole: projects with task counts, plans with progress, members with their sessions by path, git roots, insight themes, channels, existing roles and anchors, open decisions.
2. \`cast org health${team} --json\`: per role, per person and for the company, the load, spend and flow signals the capacity model needs, and the flags it raises. Every flag names its evidence; the stale flags (\`stale_plan\`, \`stale_task\`, \`stale_project\`) and \`program_ended\` are the ones you answer before any other.
3. Each git root's layout: \`ls\` the root and the package names one level down. Beyond that, the one other reading outside codecast is the main branch's log for a flagged record its own page does not settle: \`git -C <root> log origin/main --since=90.days --oneline --grep=<its id, or two or three distinctive words of its title>\`, because work often lands in a commit that never names the record. A hit is evidence only when the commit is on main and its message or its diff plainly concerns that record, and the row's evidence then names the commit and its date; a commit that merely touches the same files settles nothing. Read only, and do not walk the tree.
${roots}
4. The project charters (\`cast project show <ref>${team}\`: goal, metrics, priority, owner, non goals, risks) and the roles' briefs (\`cast brief @handle${team}\`), where they exist. A charter that is missing is itself a finding. \`cast role wakes @handle${team}\` shows what woke a role and how big each frame was, which is where a cap hit explains itself.`;

  const grounding = `## Ground in what is happening, not in what was filed

${ORG_GROUNDING_RULES.activity_first} ${ORG_GROUNDING_RULES.done_is_sync} ${ORG_GROUNDING_RULES.untouched_is_not_a_seat} ${ORG_GROUNDING_RULES.records_first}

How to read the evidence. Paths and projects are not the same thing: when several projects file under one path, that path's commits and sessions belong to none of them alone, so who works in such a project, and how busy it is, is read from the tasks filed under it and the sessions bound to it, and the path's numbers are never credited to one of them. The activity block says which paths had commits and sessions and who made them; a plan whose tasks are all closed, whose bound sessions are all done, or whose area had no activity for three weeks is stale, and the block names which. A task in progress whose sessions finished two weeks ago, or whose commits landed while it stayed open, is finished or dropped, not in flight. A project whose path had no commits and no sessions for the window is paused, not unowned. Every stale record becomes one status change with its evidence in the reason, and the loads you size for a seat exclude it: the model measures work that is happening, and a seat sized on records that are behind it is a seat nobody needs. Bring the records in line first, then size: a seat's load is what will reach it once the stale rows are closed and the loose plans filed, and its ledger after those changes is context. Closing a plan closes its still open tasks in the same accept (they are dropped and the applied note lists them), so propose one change per plan and name a task on its own only when its evidence differs from its plan's: done because its commit landed, or open or backlog because it was filed in bulk as in progress and never picked up. The activity block says a record is stale; it does not say what became of the work, and two readers who stop there will guess differently. Before you set a task done, open, backlog or dropped, read the row (\`cast task show ct-N${team}\`: its comments, its plan, the commit that names it) and write the status the row itself shows: done when a commit, a closing comment or a finished sibling shows the work landed; open or backlog when it is still real work nobody started; dropped when nothing under it happened and nothing waits on it. A finished session is not evidence that the work landed; a plan already marked done is not either, and its close drops what it left open. The row's newest word wins over the flag: a comment, a plan comment or a session on the row from the last week means the work is alive, whatever an older commit says, and a row that is alive gets no status change. A commit that names a row is a landing only when it is on the main branch and the row's latest comment does not say more is coming; a commit on a branch, an open pull request, and a commit that cites the row as the place a decision would land are not landings. A row whose page names parts is done only when each part shows as finished: a part left to a person (a write nobody has run, an approval nobody has given) keeps the row open however much code landed, and what you could not find out is doubt, which never closes a row; say it as a finding instead. A task a person owns is often worked outside any session, so no session on it is not evidence it was never started. Every status change carries as evidence the comment, commit or session it rests on, with its date, and names the date of the newest word on the row you read (its latest comment, session or commit), so a person can check it in one click; a change you cannot point at that way is a guess, and a guess gets no status change. A plan the activity block lists as marked done and still worked has a task in progress written in the last week: read it, and when that work is real the plan goes back to active and nothing under it closes; when the task is a leftover whose work shipped, the task is the change and the plan stays done. A plan closes as done when the tasks that finished under it carried its goal, which its decisions, its done tasks or its own page show, and as abandoned when nothing under it finished; the reason names which. A row you did not read gets no status change. A weekly average hides its days: read \`spend.wakes_by_day\` and \`spend.last_wake_at\` before you call one burst a daily rate. A seat flagged \`bypassed\` is neither idle nor loaded: work closes in its scope and none of it passes through the seat; name it to the person as a finding and ask whether the work should route through the seat or the seat should be sized as a reader, and do not split, merge or retire on its first sighting. The activity block's \`commits\` says how many commits carried a file list; the areas can only show a seam for those, so report the rest as could not verify, never as work on the root. Where the record and the activity disagree and you cannot tell which is right, say so as a finding and size without the record.`;

  const unnamed = `## Sessions that already are roles

${ORG_UNNAMED_ROLES_RULE}

## Two roles people asked for

${ORG_ASKED_FOR_RULES.agent_quality}

${ORG_ASKED_FOR_RULES.goal_tracker}`;

  const coverage = `## Initiatives, and a lead for every piece of work

${ORG_INITIATIVES_RULE}

${ORG_COVERAGE_RULE}`;

  const capacity = `## The capacity model

${renderCapacityModel()}

What a scope is made of. A role's scope is projects plus plans, and everything filed under a project follows the project: its tasks, its plans, their tasks. A scope change adds or removes refs a role names; it cannot take one plan out of a project the role owns. Work moves between roles by moving the plan: a file change puts a plan under another project, and the role that owns that project sees it from then on. When a seam inside one project should become its own seat, file its plans under the project the new role owns, in the same proposal, ahead of the role; naming the same plans in two roles' scopes leaves both watching the work and the overlap flag says so.`;

  const tenure = `## Standing and program roles

${ORG_TENURE_RULE} A business line that the activity shows people returning to month after month is standing; a seat that exists for one plan, one migration or one dated push is a program that ends with it, and the rationale names the plan, the project or the date. A program role's end is a health signal: when its plan is done, its project done or its date past, health raises \`program_ended\`, and the review that sees it proposes the retirement, or a review of the seat when the role's tenure says so.`;

  const design = mode === "init" ? `## How to design from scratch

Start from the initiatives, then the business lines the activity shows, and their goals, not from the people, the tools or the project list as filed. For each line, ask what would have to be true in a month for it to be going well; that is the charter you propose when the project has none. Name one owner per line and say whether the seat is standing or a program, then check the span of the person the owners report to. Allocate budget from the company total health reports. Explain every role with evidence a person can click: counts, session titles, commits, short ids. Where a line has no evidence of work, propose an intake draft instead of a role that owns nothing. A complete chart is one where every project with work has a lead, never one where every idea has a role: roles with plain scopes that each wrap one project beat a clever structure, and for a company whose work is one project, one role, or none, is a valid answer, and the summary should say why.` : `## How to review

Read the stale flags and the activity first, and turn each stale record into its status change before you read anything as a bottleneck; a seat sized against records the activity has passed is the wrong seat. Then the flags and the evidence behind each: the chatter graph (who sends to whom, against what they ship), decision latency, review stalls, unowned projects, unfiled plans and tasks, idle roles, roles at their caps, program roles whose end has come. For each bottleneck, propose the smallest change that removes it, and say what you expect to change by the next review and how you will know. A project with work and no lead, and work outside any project, are gaps the review closes whether or not a flag names them; the coverage rule says how. A project in \`company.watched_without_lead\` is listed by two or more roles on separate lines and names none of them as its lead, so every surface shows it as "two roles watch this": propose one \`projects\` change that names its owner, the role whose hands and commits are in it, and say in the rationale why that one and not the other. A plan with open work and no project is a file change, not a finding: its goal and title say which business line it belongs to, and the role that owns that project sees it once filed. When a role you propose needs plans that are unfiled today, propose their file changes first in the same proposal, so the scope is real the moment the role is accepted. Respect the stability rules as \`cast org health\` reports them: a role moved inside the cooldown (\`last_move_at\`) is left alone; a split waits for the second breach unless the flow is structurally too big: \`overload_ratio\` is the busiest volume axis of the load (items a day, decisions a day, live hands) divided by the model's line, and at or above the split_on_first_breach_ratio the overloaded flag says "split now" and the split goes in this proposal; below it, the flag says which breach this is (\`breaches\` counts the consecutive earlier reviews that flagged the role), a first breach on record is not a split, and you propose what does not split and let the next review decide. A \`wide_ledger\` flag on its own is never a split: a seat with a quiet load and a large ledger has a records or filing problem, and the sync and file changes are its answer. A split names the seam its own work shows, files the plans of each side first, and shows each resulting seat's load against the model with its ledger as context, so the reader sees that every seat's flow fits and the parent's load falls under the line; a retirement waits for the idle window. A quiet role in a quiet company is not a problem to fix; a chart that changes every week never settles. When nothing needs to change, post a proposal with no changes only if the summary carries a finding worth reading; otherwise say so in your state and end.`;

  const write = `## How to write

The output is one proposal, posted with \`cast org propose${team} --spec proposal.json\` (or \`--spec -\` with the JSON on stdin). It prints op-N and the page link. A review that replaces an open proposal you posted earlier says so: run \`cast org proposals${team}\` first, and when one of the open ones is yours, add \`--supersedes op-N\` to the post. The person then sees which proposal is live and withdraws the older one; a proposal somebody else wrote is theirs, and naming it is refused. The spec:

\`\`\`json
${specExample(mode, workspace)}
\`\`\`

Every change carries its own rationale, evidence a person can click (a label, and a link where one exists: \`cast link <id>\` prints the link for a session, a task, a plan or a project; a role's page is \`/org/or-N\`), the effect you expect and the risk you see. Order the changes so the status changes that bring records in line come first, as their own group, then a project before the role that owns it and a parent before its child; a retirement goes last. The page groups the status changes under "Bring records in line" at the top, and the person decides them before the seats that rest on them. Every role change carries its tenure, and its rationale says why standing or why a program and what ends it. A proposal names each subject once: one status per plan or task, one project_meta carrying every field you set for a project, one row per role for each kind. Build the spec so no two of your lists can name the same subject; two rows that agree about one subject are folded into one at the post and named, and two that disagree are refused.

${ORG_ASKS_RULE}

${ORG_LETTER_RULE}

The summary is the ask. ${ORG_ASK_RULES.reader} ${ORG_ASK_RULES.decision_first} ${ORG_ASK_RULES.invented_words} ${ORG_ASK_RULES.numbers_mean_something} ${ORG_ASK_RULES.cost_in_plain_words} ${ORG_ASK_RULES.readable_once} The ask stays under two hundred words, in short paragraphs; a seat's sizing against the model, its evidence and its caps live in the change, not here. After the ask come the evidence, one line per finding, then what you could not verify and the findings that are not changes, as a short list; each line is written for the same reader, so the ask stays on top and nothing below it asks them to learn a word.

The change kinds:

${changeKindsReference()}`;

  const honesty = `## What not to invent, and what to escalate

- ${ORG_INIT_HONESTY_RULES.empty_yields_intake}
- ${ORG_INIT_HONESTY_RULES.unreadable_is_unverified}
- ${ORG_INIT_HONESTY_RULES.no_manufactured_work}
- Do not name people as owners of anything the inputs do not show them working on, and do not propose roles for people who are not members.
- Never invent a metric a project's own tasks and docs cannot ground; a charter with a goal and no metrics is honest.
- Escalate, in the summary and as a decision to the person you report to, anything that changes what they spend or who does what: a budget past the defaults, a trust stage above understand, a retirement, a move of a person's direct report.`;

  const adopt = `## The offer

${ORG_ADOPT_RULE}${opts.session ? ` This session is \`${opts.session}\`; that is the adopt change's conversation only when the workspace has no anchor.` : " This run is not inside a session it can name, so with no anchor to adopt, skip the offer and say so."} A chief of staff never rises above trust understand: it proposes and never applies.`;

  const standing = opts.open ? `## A proposal is still open

${opts.open.short_id} "${opts.open.title}" waits on a person: ${opts.open.decided} of ${opts.open.total} changes decided, at ${opts.open.url}. Do not post a second proposal while it is open, and do not withdraw it: a person decides or withdraws it. Read the flags and the briefs, and compare them with what ${opts.open.short_id} claimed. If nothing material changed, say so in one line in your brief and end the turn. If something did (a flag cleared, a new blocker, a change of ${opts.open.short_id} that is now wrong), send that to the person you report to in one short message with the evidence, and end the turn.` : "";

  const end = `## When you are done

End your turn with \`cast state --status done\` naming op-N and the page link. The person decides on the org page; that page is the only door, and nothing you run applies a change.`;

  return [purpose, model, glance, standing, read, grounding, unnamed, coverage, capacity, tenure, design, write, honesty, adopt, end].filter(Boolean).join("\n\n") + "\n";
}

/** Where coverage stands before the proposal (I2), in the words the prompt and
 *  \`cast org inputs\` both print, so the letter's before count has one source. */
export function coverageLine(c: OrgInitSummary["coverage"]): string {
  if (!c) return "";
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const initiatives = c.initiatives_active ? `${plural(c.initiatives_active, "active initiative")}${c.initiatives_without_owner ? `, ${c.initiatives_without_owner} with no owner` : ""}` : "no active initiatives";
  const outside = [c.outside_plans ? plural(c.outside_plans, "plan") : "", c.outside_areas ? `${plural(c.outside_areas, "area")} of commits and sessions in ${c.outside_repositories} ${c.outside_repositories === 1 ? "repository" : "repositories"}` : ""].filter(Boolean).join(" and ");
  return `${initiatives}; ${c.with_lead} of ${plural(c.with_work, "project")} with work ${c.with_lead === 1 ? "has" : "have"} a lead${outside ? `; outside any project: ${outside}` : ""}`;
}

function coverageGlance(c: OrgInitSummary["coverage"]): string {
  const line = coverageLine(c);
  return line ? `Coverage today: ${line}. ` : "";
}

/** The glance's last sentence: how many records the activity block says are behind. */
function staleGlance(stale: OrgInitSummary["stale"] | undefined): string {
  const n = (stale?.plans ?? 0) + (stale?.tasks ?? 0) + (stale?.projects ?? 0);
  if (!n) return "The activity block marks no record as stale.";
  const parts = [[stale!.plans, "plan"], [stale!.tasks, "task"], [stale!.projects, "project"]] as const;
  return `The activity block marks ${parts.filter(([k]) => k > 0).map(([k, w]) => `${k} ${w}${k === 1 ? "" : "s"}`).join(", ")} as stale: those are sync changes, and they come first.`;
}

// ── Guards and helpers ───────────────────────────────────────────────────────

/** An open analyzer proposal for the workspace, from the rows
 *  /cli/org/proposals returns (already scoped to the boundary). Init and
 *  review block each other: two analyzers proposing the same chart would post
 *  duplicate ghosts, and accepting both is safe only by accident of the
 *  handle clash. A person's own request does not block. */
export function findOpenOrgProposal(
  proposals: Array<{ short_id: string; title: string; mode?: OrgProposalMode; status?: string; decided?: number; total?: number; changes?: any[]; counts?: { decided?: number; total?: number } }> | null | undefined,
): { short_id: string; title: string; decided: number; total: number } | null {
  const hit = (proposals ?? []).find((p) => (p.status ?? "open") === "open" && (p.mode === "init" || p.mode === "review"));
  if (!hit) return null;
  return { short_id: hit.short_id, title: hit.title, ...decidedCount(hit) };
}

/** Stacks (ds-N) keep the older apply order; one sort for both. */
export function orderForApply<T extends { context_md?: string | null }>(decisions: T[]): T[] {
  return orderOrgChanges(decisions, (d) => extractOrgProposal(d.context_md));
}

export function summarizeInputs(inputs: any): OrgInitSummary {
  const roles: any[] = inputs?.org?.roles ?? [];
  return {
    projects: inputs?.projects?.length ?? 0,
    plans: inputs?.plans?.length ?? 0,
    tasks_open: Object.entries(inputs?.tasks?.by_status ?? {}).filter(([k]) => k !== "done" && k !== "dropped").reduce((n, [, v]) => n + Number(v), 0),
    members: inputs?.members?.length ?? 0,
    sessions_30d: inputs?.sessions?.total ?? 0,
    roles: roles.length,
    git_roots: (inputs?.git_roots ?? []).map((g: any) => g.git_root).filter(Boolean),
    chief_of_staff: roles.some((r) => r?.handle === CHIEF_OF_STAFF_HANDLE),
    stale: {
      plans: inputs?.activity?.stale?.plans?.length ?? 0,
      tasks: inputs?.activity?.stale?.tasks?.length ?? 0,
      projects: inputs?.activity?.stale?.projects?.length ?? 0,
    },
    ...(inputs?.coverage ? { coverage: {
      initiatives_active: inputs.coverage.active_initiatives ?? 0,
      initiatives_without_owner: inputs.coverage.active_without_owner ?? 0,
      with_work: inputs.coverage.with_work ?? 0,
      with_lead: inputs.coverage.with_lead ?? 0,
      outside_plans: inputs.coverage.outside?.plans?.length ?? 0,
      outside_areas: inputs.coverage.outside?.areas?.length ?? 0,
      outside_repositories: new Set((inputs.coverage.outside?.areas ?? []).map((a: any) => a.repository)).size,
    } } : {}),
  };
}

export function proposalUrl(deps: OrgInitDeps, shortId: string): string {
  return `${deps.webUrl().replace(/\/$/, "")}/org?proposal=${shortId}`;
}

// The `cast` this process is: a script under bun (execPath + the script), or
// the compiled binary (execPath alone takes subcommands).
function selfCommand(): string[] {
  const script = process.argv[1];
  return script && /\.(ts|js)$/.test(script) && fs.existsSync(script) ? [process.execPath, script] : [process.execPath];
}

function spawnAnalyzer(prompt: string, label: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const [bin, ...pre] = selfCommand();
    const child = spawn(bin, [...pre, "spawn", "--label", label, "-"], { stdio: ["pipe", "inherit", "inherit"], env: process.env });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function fail(message: string): never {
  console.error(fmt.error(message));
  process.exit(1);
}

async function membership(deps: OrgInitDeps, options: any): Promise<{ ws: any; args: { team_id?: string } }> {
  const ws = await deps.readWorkspace(options.team);
  return { ws, args: deps.workspaceArgs(ws) };
}

// ── inputs ───────────────────────────────────────────────────────────────────

export async function showInputs(deps: OrgInitDeps, options: any): Promise<void> {
  const { ws, args } = await membership(deps, options);
  const inputs = await deps.cliPost("/cli/org/analysis-inputs", args);
  if (!inputs) fail(`You are not a member of ${deps.workspaceLabel(ws)}.`);
  if (options.json) { console.log(JSON.stringify(inputs, null, 2)); return; }
  const s = summarizeInputs(inputs);
  console.log(`${fmt.highlight(inputs.workspace.name || deps.workspaceLabel(ws))} ${fmt.muted(`· ${inputs.window_days} days`)}`);
  console.log(`  ${s.projects} projects · ${s.plans} plans · ${s.tasks_open} open tasks (${inputs.tasks.unfiled_open} unfiled) · ${s.members} members · ${s.sessions_30d} sessions${inputs.sessions.truncated ? " (truncated)" : ""} · ${s.roles} roles`);
  for (const p of inputs.projects) console.log(`  ${fmt.muted("project")} ${p.short_id ?? ""} ${p.title} ${fmt.muted(`· ${p.tasks.open} open of ${p.tasks.total} tasks · ${p.plans} plans`)}`);
  // Roots group by repo for the eye; the prompt still lists every path,
  // because a worktree is what the analyzer has to read.
  const byRepo = new Map<string, { sessions: number; roots: number }>();
  for (const g of inputs.git_roots) { const k = g.repo ?? g.git_root; const cur = byRepo.get(k) ?? { sessions: 0, roots: 0 }; cur.sessions += g.sessions; cur.roots++; byRepo.set(k, cur); }
  for (const [repo, v] of byRepo) console.log(`  ${fmt.muted("repo")} ${repo} ${fmt.muted(`· ${v.sessions} sessions${v.roots > 1 ? ` across ${v.roots} checkouts` : ""}`)}`);
  for (const r of inputs.org.roles) console.log(`  ${fmt.muted("role")} @${r.handle} ${r.name} ${fmt.muted(`· ${r.idle ? "idle" : `${r.idle_days}d since a scope event`} · ${r.wakes_7d.total} wakes/7d${r.wakes_7d.days_at_cap ? ` (${r.wakes_7d.days_at_cap} days at cap)` : ""}${r.overlaps.length ? ` · overlaps ${r.overlaps.map((o: any) => `@${o.handle}`).join(", ")}` : ""}`)}`);
  if (inputs.org.projects_without_role.length) console.log(`  ${fmt.muted("no role:")} ${inputs.org.projects_without_role.map((p: any) => p.title).join(", ")}`);
  // Who answers for the work (I1, I2): the initiatives, then the before count.
  for (const i of inputs.coverage?.initiatives ?? []) console.log(`  ${fmt.muted("initiative")} ${i.short_id} ${i.title} ${fmt.muted(`· ${i.status} · ${String(i.health).replace(/_/g, " ")} · ${i.owner ? (i.owner.handle ?? i.owner.name) : "no owner"}${i.projects_without_lead ? ` · ${i.projects_without_lead} of its projects with no lead` : ""}`)}`);
  if (s.coverage) console.log(`  ${fmt.muted("coverage:")} ${coverageLine(s.coverage)}`);
  // Where the work is (S9): the busiest areas and the records behind them.
  for (const a of (inputs.activity?.areas ?? []).slice(0, 8)) console.log(`  ${fmt.muted("area")} ${a.repository ? `${a.repository}${a.path_prefix ? "/" : ""}` : ""}${a.path_prefix || fmt.muted(" (commits with no file list: could not verify)")} ${fmt.muted(`· ${a.commits_30d} commits · ${a.sessions_30d} sessions${a.authors?.length ? ` · ${a.authors.slice(0, 3).map((x: any) => x.name).join(", ")}` : ""}`)}`);
  if (s.stale.plans + s.stale.tasks + s.stale.projects) console.log(`  ${fmt.muted("stale:")} ${s.stale.plans} plans · ${s.stale.tasks} tasks · ${s.stale.projects} projects ${fmt.muted("(records behind the activity; a review proposes their status changes first)")}`);
  console.log(fmt.muted("  --json for the full payload"));
}

// ── init / update / review ───────────────────────────────────────────────────

export async function runAnalyzer(deps: OrgInitDeps, mode: OrgInitMode, options: { team?: string; spawn?: boolean }): Promise<void> {
  const { ws, args } = await membership(deps, options);
  const inputs = await deps.cliPost("/cli/org/analysis-inputs", args);
  if (!inputs) fail(`You are not a member of ${deps.workspaceLabel(ws)}.`);
  const workspace = inputs.workspace.name || deps.workspaceLabel(ws);
  // One proposal at a time per company. An analyzer parked on a usage limit
  // after posting looks dead from the queue; it is not, and a second run
  // would post a second set of ghosts. Printing the prompt is guarded the
  // same way, because the agent that reads it posts too.
  const listed = await deps.cliPost("/cli/org/proposals", { ...args, status: "open" });
  const open = findOpenOrgProposal(listed?.proposals);
  // Init refuses: two first charts would post duplicate ghosts. A review
  // with last week's proposal still open is the routine's ordinary Monday: the
  // prompt tells the reviewer to read what changed and add nothing until the
  // person has decided. Withdrawing is the person's act, never a hint here.
  if (open && mode === "init") {
    fail(
      `${open.short_id} "${open.title}" is still open (${open.decided} of ${open.total} decided), so a second proposal is not started.\n` +
      `Decide it on the org page (${proposalUrl(deps, open.short_id)}) before running this again.`,
    );
  }
  const prompt = buildOrgAnalyzerPrompt({ mode, workspace, teamFlag: options.team, summary: summarizeInputs(inputs), session: deps.callingSession(), open: open ? { ...open, url: proposalUrl(deps, open.short_id) } : undefined });
  if (!options.spawn) { process.stdout.write(prompt); return; }
  const code = await spawnAnalyzer(prompt, ORG_INIT_LABEL);
  if (code !== 0) process.exit(code);
}

// ── propose / proposals ──────────────────────────────────────────────────────

function readSpecText(spec: string): string {
  if (spec === "-") return fs.readFileSync(0, "utf8");
  if (!fs.existsSync(spec)) fail(`No such file: ${spec}`);
  return fs.readFileSync(spec, "utf8");
}

export async function propose(deps: OrgInitDeps, options: any): Promise<void> {
  const text = readSpecText(options.spec);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e: any) { fail(`The spec is not JSON: ${e?.message ?? e}`); }
  const parsed = parseOrgProposalSpec(raw);
  if (!parsed.spec) fail(`The spec has ${parsed.errors.length} fault${parsed.errors.length === 1 ? "" : "s"}:\n${parsed.errors.map((e) => `  - ${e}`).join("\n")}\nChange kinds: ${ORG_CHANGE_KINDS.join(", ")}.`);
  for (const n of parsed.notes ?? []) console.log(`  ${fmt.muted(`folded ${n}`)}`);
  if (options.supersedes && !/^op-\d+$/.test(options.supersedes)) fail(`--supersedes wants a proposal id like op-12 (got ${options.supersedes})`);
  const { ws, args } = await membership(deps, options);
  const result = await deps.cliPost("/cli/org/propose", { ...args, ...parsed.spec, from_session: deps.callingSession(), ...(options.supersedes ? { supersedes: options.supersedes } : {}) });
  if (!result || result.error) fail(result?.error ?? `You are not a member of ${deps.workspaceLabel(ws)}.`);
  if (options.json) { console.log(JSON.stringify({ ...result, url: proposalUrl(deps, result.short_id) }, null, 2)); return; }
  const n = result.changes?.length ?? parsed.spec.changes.length;
  console.log(`${fmt.success("✓")} ${fmt.highlight(result.short_id)} ${parsed.spec.title} ${fmt.muted(`· ${n} change${n === 1 ? "" : "s"} · ${parsed.spec.mode}`)}`);
  for (const a of parsed.spec.asks ?? []) console.log(`  ${fmt.muted(`ask: ${a.title} (${a.seqs.length} change${a.seqs.length === 1 ? "" : "s"})`)}`);
  console.log(`  ${fmt.accent(proposalUrl(deps, result.short_id))}`);
}

// ── revise (S18) ─────────────────────────────────────────────────────────────

/** JSON from a flag value: inline text when it parses, else a file ('-' is stdin). */
function readJsonArg(value: string, flag: string): unknown {
  const text = value === "-" || fs.existsSync(value) ? readSpecText(value) : value;
  try { return JSON.parse(text); } catch (e: any) { fail(`${flag} is not JSON (inline text or a file): ${e?.message ?? e}`); }
}

const seqOf = (raw: string, flag: string): number => {
  const n = Number(String(raw).replace(/^#/, ""));
  if (!Number.isInteger(n) || n < 1) fail(`${flag} wants a change number like 3 (got ${raw})`);
  return n;
};

/** The ops the flags describe, in the order remove, amend, add. Pure over
 *  `readJson`, so the test drives it; `--ops` hands the list over as is,
 *  with `--note` filled in where an op has none. */
export function buildReviseOps(options: any, readJson: (value: string, flag: string) => unknown = readJsonArg): OrgReviseOp[] {
  const note = options.note ? { note: String(options.note) } : {};
  let ops: OrgReviseOp[] = [];
  if (options.ops) {
    const raw = readJson(options.ops, "--ops");
    if (!Array.isArray(raw)) fail("--ops wants a JSON list of ops");
    ops = raw.map((o: any) => (o && typeof o === "object" && options.note && o.note === undefined ? { ...o, ...note } : o));
  } else {
    for (const r of options.remove ?? []) ops.push({ op: "remove", seq: seqOf(r, "--remove"), ...note });
    if (options.amend !== undefined) {
      if (options.edits === undefined && !options.rationale) fail("--amend wants --edits (a JSON patch over the change's keys), --rationale <text>, or both");
      ops.push({ op: "amend", seq: seqOf(options.amend, "--amend"), ...(options.edits !== undefined ? { edits: readJson(options.edits, "--edits") as Record<string, unknown> } : {}), ...(options.rationale ? { rationale: String(options.rationale) } : {}), ...note });
    } else if (options.edits !== undefined || options.rationale) fail("--edits and --rationale go with --amend <seq>");
    for (const file of options.add ?? []) {
      const raw = readJson(file, "--add");
      for (const c of Array.isArray(raw) ? raw : [raw]) ops.push({ op: "add", change: c as OrgSpecChange, ...note });
    }
  }
  if (!ops.length) fail("Nothing to do: give --remove <seq>, --amend <seq> with --edits or --rationale, --add <file>, or --ops <file>");
  const faults = ops.map((o, i) => { const f = orgReviseOpError(o); return f ? `  - ops[${i}]: ${f}` : null; }).filter(Boolean);
  if (faults.length) fail(`The revise is not valid:\n${faults.join("\n")}`);
  return ops;
}

export async function revise(deps: OrgInitDeps, ref: string, options: any): Promise<void> {
  if (!/^op-\d+$/.test(ref)) fail(`Usage: cast org revise op-N [--remove <seq>] [--amend <seq> --edits <json> | --rationale <text>] [--add <file>] [--note <text>]; got ${ref}`);
  const ops = buildReviseOps(options);
  const from_session = deps.callingSession();
  if (!from_session) fail("cast org revise runs inside the session that posted the proposal (or the standing session of the role that did); at a plain shell, decide it on the org page instead");
  const r = await deps.cliPost("/cli/org/proposal/revise", { proposal: ref, ops, from_session });
  if (!r || r.error) fail(r?.error ?? `Could not revise ${ref}.`);
  if (options.json) { console.log(JSON.stringify({ ...r, url: proposalUrl(deps, ref) }, null, 2)); return; }
  const { decided, total } = decidedCount(r);
  console.log(`${fmt.success("✓")} ${fmt.highlight(ref)} revised ${fmt.muted(`· ${decided} of ${total} decided`)}`);
  for (const j of r.revisions ?? []) console.log(`  ${revisionLine(j)}`);
  console.log(`${fmt.muted("The person decides what is left on the org page:")} ${fmt.accent(proposalUrl(deps, ref))}`);
}

/** One journal entry as a line: what happened to which change, and the note. */
function revisionLine(j: any): string {
  const what = j.op === "removed" ? fmt.error("removed") : j.op === "added" ? fmt.success("added") : fmt.accent("amended");
  const detail = j.op === "amended" && j.was && j.was !== j.line ? `${j.line} ${fmt.muted(`(was: ${j.was})`)}` : j.line;
  return `${what} ${fmt.muted(`#${j.seq}`)} ${detail}${j.note ? ` ${fmt.muted(`· ${j.note}`)}` : ""}`;
}

/** The list carries `counts`, the get carries the change rows; one reading. */
function decidedCount(p: any): { decided: number; total: number } {
  if (p.counts && typeof p.counts.total === "number") return { decided: p.counts.decided ?? 0, total: p.counts.total };
  const changes: any[] = p.changes ?? [];
  return { decided: p.decided ?? changes.filter((c) => c.status && c.status !== "proposed").length, total: p.total ?? changes.length };
}

export async function listProposals(deps: OrgInitDeps, options: any): Promise<void> {
  const { ws, args } = await membership(deps, options);
  if (options.withdraw) {
    if (!/^op-\d+$/.test(options.withdraw)) fail(`--withdraw wants a proposal id like op-12 (got ${options.withdraw})`);
    const r = await deps.cliPost("/cli/org/proposal/withdraw", { proposal: options.withdraw, from_session: deps.callingSession() });
    if (r?.error) fail(r.error);
    if (options.json) { console.log(JSON.stringify(r, null, 2)); return; }
    console.log(`${fmt.success("✓")} withdrew ${options.withdraw}`);
    return;
  }
  const listed = await deps.cliPost("/cli/org/proposals", options.all ? args : { ...args, status: "open" });
  if (!listed) fail(`You are not a member of ${deps.workspaceLabel(ws)}.`);
  if (options.json) { console.log(JSON.stringify(listed, null, 2)); return; }
  const rows: any[] = listed.proposals ?? [];
  if (!rows.length) { console.log(fmt.muted(options.all ? "No proposals." : "No open proposals. cast org review proposes one; --all lists resolved ones.")); return; }
  const now = Date.now();
  for (const p of rows) {
    const { decided, total } = decidedCount(p);
    // Who posted it decides who may supersede or withdraw it, so the line
    // carries the author's short id and name, not just its kind.
    const a = p.author ?? {};
    const who = a.kind === "user" ? "a person" : a.kind === "role" ? `@${a.handle ?? a.name ?? "role"}` : "session";
    const author = `${who}${a.kind !== "user" && a.short_id ? ` ${a.short_id}` : ""}${a.kind === "session" && a.title ? ` "${a.title}"` : a.kind === "user" && a.name ? ` ${a.name}` : ""}`;
    console.log(`  ${fmt.highlight(p.short_id)} ${p.title} ${fmt.muted(`· ${p.status ?? "open"} · ${p.mode ?? ""} · ${decided}/${total} decided · ${author} · ${formatRelative(p.created_at ?? now, now)}`)}`);
  }
}

// ── apply ────────────────────────────────────────────────────────────────────

export async function apply(deps: OrgInitDeps, ref: string, options: any): Promise<void> {
  if (/^ds-\d+$/.test(ref)) return applyStack(deps, ref, options);
  if (!/^op-\d+$/.test(ref)) fail(`Usage: cast org apply op-N (or ds-N for a template stack); got ${ref}`);
  return showProposal(deps, ref, options);
}

/** A proposal is decided on the org page and nowhere else (S4): the server
 *  refuses a decide from any token or session. The shell prints what the page
 *  will show, the counts, and the link. */
export async function showProposal(deps: OrgInitDeps, ref: string, options: any): Promise<void> {
  const shown = await deps.cliPost("/cli/org/proposal", { proposal: ref });
  if (!shown || shown.error) fail(shown?.error ?? `No proposal ${ref}.`);
  const p = shown.proposal ?? shown;
  const changes: any[] = orderOrgChanges(shown.changes ?? p.changes ?? [], (c: any) => c.change as OrgChange);
  const url = proposalUrl(deps, ref);
  if (options.json) { console.log(JSON.stringify({ ...p, changes, url }, null, 2)); return; }
  const { decided, total } = decidedCount({ changes });
  console.log(`${fmt.highlight(p.short_id ?? ref)} ${p.title ?? ""} ${fmt.muted(`· ${p.status ?? "open"} · ${decided} of ${total} decided`)}`);
  if (p.summary_md) for (const line of String(p.summary_md).split("\n")) console.log(`  ${fmt.muted(line)}`);
  // Rows print in APPLY order, not by seq: a role before its adopt, the adopt
  // before its routine, a record sync before a seat. A row that seats or needs
  // another says so on its own line.
  const depends = orgChangeDependencies(changes.map((c: any) => ({ seq: c.seq, change: c.change as OrgChange })));
  console.log(fmt.muted("  in apply order (a row that seats or depends on another says so):"));
  for (const row of changes) {
    console.log(`  ${statusTag(row.status)} ${fmt.muted(`#${row.seq}`)} ${describeOrgChange(row.change as OrgChange)}${row.applied_note ? ` ${fmt.muted(row.applied_note)}` : ""}`);
    const dep = row.depends ?? depends[row.seq];
    if (dep) console.log(`      ${fmt.muted(dep)}`);
  }
  if (p.revisions?.length) {
    console.log(fmt.muted("  revised by its author, in order:"));
    for (const j of p.revisions) console.log(`    ${revisionLine(j)}`);
  }
  console.log(`${fmt.muted("Decide it on the org page:")} ${fmt.accent(url)}`);
}

function statusTag(status?: string): string {
  return status === "applied" ? fmt.success("applied") : status === "failed" ? fmt.error("failed") : status === "accepted" ? fmt.success("accepted") : status === "skipped" ? fmt.muted("skipped") : status === "removed" ? fmt.muted("removed") : fmt.muted(status ?? "proposed");
}

/** Template stacks (ds-N) keep the decision stack path. */
export async function applyStack(deps: OrgInitDeps, stackRef: string, options: any): Promise<void> {
  const shown = await deps.cliPost("/cli/stack/show", { stack: stackRef });
  if (shown?.error) fail(shown.error);
  const decisions: any[] = orderForApply(shown.decisions ?? []);
  const results: any[] = [];
  for (const d of decisions) {
    const ref = d.short_id ?? d._id;
    const r = await deps.cliPost("/cli/org/apply-decision", { decision: ref, provision: options.provision !== false });
    results.push({ ...r, question: d.question });
    if (options.json) continue;
    const tag = r.status === "applied" ? fmt.success("applied") : r.status === "error" ? fmt.error("error") : fmt.muted(r.status);
    console.log(`  ${tag} ${fmt.muted(ref)} ${d.question}`);
    if (r.note) console.log(`      ${fmt.muted(r.note)}`);
    if (r.error) console.log(`      ${fmt.error(r.error)}`);
  }
  if (options.json) { console.log(JSON.stringify({ stack: shown.stack, results }, null, 2)); return; }
  const applied = results.filter((r) => r.status === "applied").length;
  const pending = results.filter((r) => r.status === "unanswered").length;
  const errors = results.filter((r) => r.status === "error").length;
  console.log(`${fmt.success(`${applied} applied`)}${pending ? `, ${pending} unanswered` : ""}${errors ? `, ${fmt.error(`${errors} failed`)}` : ""} of ${results.length} in ${shown.stack?.short_id ?? stackRef}${pending || errors ? fmt.muted(` — rerun cast org apply ${shown.stack?.short_id ?? stackRef} after ${pending ? "the rest are answered" : ""}${pending && errors ? " and " : ""}${errors ? "the failed ones are answered again with changes" : ""}`) : ""}`);
}

// ── staff ────────────────────────────────────────────────────────────────────

export async function staff(deps: OrgInitDeps, options: any): Promise<void> {
  const { ws, args } = await membership(deps, options);
  const session = deps.callingSession();
  if (options.adopt && !session) fail("--adopt makes THIS session the chief of staff's standing session, so it runs inside a session. At a shell, run it without --adopt to provision one.");
  let every_ms: number;
  try { every_ms = parseDuration(String(options.every ?? "7d")); } catch (e: any) { fail(`--every: ${e?.message ?? e}`); }
  // A provisioned standing session needs a project path, like every other
  // provisioning verb; an adopted session keeps its own.
  const project_path = options.adopt ? undefined : options.dir ? path.resolve(String(options.dir).replace(/^~/, process.env.HOME || "~")) : deps.realCwd();
  if (options.seat && options.seat !== "existing" && options.seat !== "fresh") fail("--seat takes existing or fresh");
  const r = await deps.cliPost("/cli/org/staff", { ...args, every_ms, seat: options.seat, ...(options.adopt ? { adopt_conversation_id: session } : { project_path }), from_session: session });
  if (!r || r.error) fail(r?.error ?? `You are not a member of ${deps.workspaceLabel(ws)}.`);
  if (options.json) { console.log(JSON.stringify(r, null, 2)); return; }
  const role = r.role ?? {};
  console.log(`${fmt.success("✓")} ${r.already_existed ? "already staffed" : r.adopted ? "adopted" : "hired"} ${fmt.highlight(role.name ?? "Chief of Staff")} ${fmt.muted(`@${role.handle ?? CHIEF_OF_STAFF_HANDLE}${role.short_id ? ` · ${role.short_id}` : ""}`)}`);
  if (r.standing?.short_id) console.log(`  ${fmt.muted("standing session:")} ${r.standing.short_id}${r.adopted ? fmt.muted(r.seated === "existing" && !options.adopt ? " (the workspace's standing agent, seated; nothing restarted)" : " (this session)") : ""}`);
  if (r.previous_standing?.short_id) console.log(`  ${fmt.muted("previous standing agent retired; its thread is kept:")} ${r.previous_standing.short_id}`);
  if (r.routine?.short_id) console.log(`  ${fmt.muted("company review:")} every ${formatDuration(every_ms)} ${fmt.muted(`(${r.routine.short_id})`)}`);
  if (!r.already_existed) console.log(`  ${fmt.muted("first review: running now; cast org proposals lists it when posted")}`);
}

// ── health ───────────────────────────────────────────────────────────────────

const SEVERITY_TAG: Record<string, (s: string) => string> = { blocker: fmt.error, warn: fmt.warning, info: fmt.muted };
function flagLine(f: any, indent: string): string {
  const tag = (SEVERITY_TAG[f.severity] ?? fmt.muted)(String(f.severity ?? "info").padEnd(7));
  return `${indent}${tag} ${f.code}${f.detail ? ` ${fmt.muted(String(f.detail))}` : ""}`;
}
const k = (n?: number | null) => n == null ? "?" : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);

export async function health(deps: OrgInitDeps, options: any): Promise<void> {
  const { ws, args } = await membership(deps, options);
  const h = await deps.cliPost("/cli/org/health", args);
  if (!h) fail(`You are not a member of ${deps.workspaceLabel(ws)}.`);
  if (options.json) { console.log(JSON.stringify(h, null, 2)); return; }
  const now = Date.now();
  const roles: any[] = h.roles ?? [];
  const people: any[] = h.people ?? [];
  const company = h.company ?? {};
  const flags = (xs: any[] | undefined) => xs ?? [];
  const total = roles.reduce((n, r) => n + flags(r.flags).length, 0) + people.reduce((n, p) => n + flags(p.flags).length, 0) + flags(company.flags).length;
  console.log(`${fmt.highlight(h.workspace?.name ?? deps.workspaceLabel(ws))} ${fmt.muted(`· ${roles.length} roles · ${people.length} people · ${total} flag${total === 1 ? "" : "s"}${h.generated_at ? ` · ${formatRelative(h.generated_at, now)}` : ""}`)}`);
  for (const r of roles) {
    const l = r.load ?? {}; const s = r.spend ?? {}; const f = r.flow ?? {};
    console.log(`  ${fmt.accent(`@${r.handle}`)}${r.short_id ? ` ${fmt.muted(r.short_id)}` : ""}${r.idle_days != null ? ` ${fmt.muted(`· ${r.idle_days}d since a scope event`)}` : ""}`);
    const g = r.ledger ?? {};
    const d1 = (n: any) => (typeof n === "number" ? String(Math.round(n * 10) / 10) : "0");
    console.log(`    ${fmt.muted("load")}  ${d1(l.items_per_day)} items/day · ${d1(l.decisions_per_day)} decisions/day · ${l.live_hands ?? 0} hands · ${l.open_stalls ?? 0} stalls · ${l.cap_hit_days ?? 0} cap hit days · ${l.direct_reports ?? 0} reports${r.overload_ratio != null ? ` · ${d1(r.overload_ratio)}× the model` : ""}`);
    console.log(`    ${fmt.muted("ledger")} ${g.open_tasks ?? 0} open · ${g.in_flight ?? 0} in flight · ${g.active_plans ?? 0} active plans${r.counted?.note ? fmt.muted(` · counted ${r.counted.note}`) : ""}`);
    console.log(`    ${fmt.muted("spend")} ${s.wakes_today ?? 0}/${s.wakes_cap ?? "?"} wakes today (${d1(s.wakes_7d_avg)}/d over 7d) · ${k(s.tokens_today)}/${k(s.tokens_cap)} tokens${s.cap_hits_7d ? ` · ${s.cap_hits_7d} cap hits/7d` : ""}`);
    console.log(`    ${fmt.muted("flow")}  ${f.decisions_7d ?? 0} decisions/7d${f.median_recommend_min != null ? ` · ${d1(f.median_recommend_min)}m to recommend` : ""} · ${f.escalations_7d ?? 0} escalated · ${f.done_7d ?? 0} done/7d · ${f.review_stalls ?? 0} review stalls${f.sends_7d ? ` · sends ${(f.sends_7d.to ?? []).reduce((n: number, x: any) => n + (x.n ?? 0), 0)} out / ${(f.sends_7d.from ?? []).reduce((n: number, x: any) => n + (x.n ?? 0), 0)} in` : ""}`);
    for (const fl of flags(r.flags)) console.log(flagLine(fl, "    "));
  }
  for (const p of people) {
    const dw = p.decisions_waiting ?? {};
    console.log(`  ${fmt.accent(p.name ?? p.user_id)} ${fmt.muted(`· ${p.direct_roles ?? 0} direct roles · ${dw.n ?? 0} decisions waiting${dw.oldest_min ? ` (oldest ${dw.oldest_min}m)` : ""}`)}`);
    for (const fl of flags(p.flags)) console.log(flagLine(fl, "    "));
  }
  const unowned: any[] = company.unowned_projects ?? [];
  const watched: any[] = company.watched_without_lead ?? [];
  const noGoal: any[] = company.plans_without_goal ?? [];
  const noCharter: any[] = company.projects_without_charter ?? [];
  const unfiledPlans: any[] = company.unfiled_plans ?? [];
  console.log(`  ${fmt.accent("company")} ${fmt.muted(`· ${unowned.length} unowned project${unowned.length === 1 ? "" : "s"}${unowned.length ? ` (${unowned.map((x) => x.title ?? x.id).join(", ")})` : ""}${watched.length ? ` · ${watched.length} watched by two roles with no lead (${watched.map((x) => `${x.title ?? x.id}: ${(x.roles ?? []).map((h: string) => `@${h}`).join(", ")}`).join("; ")})` : ""} · ${company.unfiled_tasks ?? 0} unfiled tasks · ${unfiledPlans.length} unfiled plan${unfiledPlans.length === 1 ? "" : "s"} with open work · ${noCharter.length} without a charter · ${noGoal.length} plan${noGoal.length === 1 ? "" : "s"} without a goal`)}`);
  // Warnings and blockers print one per line; info flags (a charter missing on
  // each of forty plans) collapse to one line per code with a few examples,
  // and --json keeps every row.
  const info = flags(company.flags).filter((f) => f.severity === "info");
  for (const fl of flags(company.flags).filter((f) => f.severity !== "info")) console.log(flagLine(fl, "    "));
  const byCode = new Map<string, any[]>();
  for (const fl of info) byCode.set(fl.code, [...(byCode.get(fl.code) ?? []), fl]);
  for (const [code, rows] of byCode) {
    const shown = rows.slice(0, 3).map((f) => String(f.detail ?? "")).filter(Boolean);
    console.log(`    ${fmt.muted("info   ")} ${code} ${fmt.muted(`× ${rows.length}: ${shown.join("; ")}${rows.length > shown.length ? `; +${rows.length - shown.length} more (--json)` : ""}`)}`);
  }
  if (!total) console.log(fmt.muted("  no flags"));
}
