// The fixture world for the record and charter cards (org-staffing.md S7, S9):
// ORG_FIXTURE plus three projects, two plans and an @escalations role, and
// four proposals over them. Built with a push loop so the counts are exact
// and the tests pin them; everything here is synthetic. The record proposal
// reads by group (orgRecordGroups): three projects, two plans, the rest loose.
import { orgRecordGroups, type OrgChange, type OrgChangeStatus, type OrgCharterEdit, type OrgPlanStatusChange, type OrgRoleProposal, type OrgTaskStatusChange } from "@codecast/shared/contracts/orgProposal";
import { ORG_FIXTURE } from "./orgFixture";
import { EMPTY_COUNTS, type OrgRole, type OrgTree } from "./orgTypes";
import type { OrgProposalChange, OrgProposalRow } from "./orgStaffingTypes";
import type { SubjectLive } from "./proposalSubjects";

const T0 = ORG_FIXTURE.generated_at;
const MIN = 60_000;
const growth = ORG_FIXTURE.roles[0];

// ---------------------------------------------------------------- the world

/** Two sentences the op-902 goal replaces by three. */
const MATCHING_GOAL = "Every inbound lead reaches a ranked shortlist within a day. The funnel reads the same on the sheet and in the digest.";

export const ORG_RECORDS_FIXTURE_PROJECTS = [
  { _id: "fixture-project-matching", short_id: "pr-901", title: "Matching Engine & Funnel", status: "active", goal: MATCHING_GOAL },
  { _id: "fixture-project-callers", short_id: "pr-902", title: "Callers & Call Management", status: "active" },
  { _id: "fixture-project-infra", short_id: "pr-903", title: "Infrastructure", status: "active" },
] satisfies SubjectLive["projects"];

/** Neither plan is filed under a project: the record proposal groups both as plans. */
export const ORG_RECORDS_FIXTURE_PLANS = [
  { _id: "fixture-plan-pitches", short_id: "pl-911", title: "Counterparty pitches", status: "active" },
  { _id: "fixture-plan-networks", short_id: "pl-912", title: "Networks", status: "done" },
] satisfies SubjectLive["plans"];

/** Seven sentences, 620 characters: the charter op-902 edits in place. */
export const ESCALATIONS_CHARTER_SENTENCES = [
  "Owns every escalation a session raises to a person: a blocked handoff, a decision past its deadline, a failed apply, a complaint from a caller.",
  "Reads the escalation queue every morning and again after the afternoon flush, and answers each one within the hop deadline.",
  "Decides alone when the fix is a retry, a reassignment or a note to the owner; brings a person in when money, a caller or a deletion is involved.",
  "Keeps a ledger of what escalated, who answered and how long it took.",
  "Writes a weekly digest of the patterns: which roles escalate most and which asks wait longest.",
  "Reports to the Head of Platform on anything that names the sync layer.",
  "Never closes an escalation a person opened without their word.",
];
export const ESCALATIONS_CHARTER = ESCALATIONS_CHARTER_SENTENCES.join(" ");

const ESCALATIONS: OrgRole = {
  ...growth,
  _id: "fixture-role-escalations",
  short_id: "or-12",
  name: "Escalations lead",
  handle: "escalations",
  scope: { project_ids: ORG_RECORDS_FIXTURE_PROJECTS.map((p) => p._id), plan_ids: ORG_RECORDS_FIXTURE_PLANS.map((p) => p._id) },
  scope_names: {
    projects: ORG_RECORDS_FIXTURE_PROJECTS.map(({ _id, title, short_id }) => ({ id: _id, title, short_id })),
    plans: ORG_RECORDS_FIXTURE_PLANS.map(({ _id, title, short_id }) => ({ id: _id, title, short_id })),
  },
  charter: ESCALATIONS_CHARTER,
  created_at: T0 - 86_400_000 * 40,
  updated_at: T0 - 86_400_000 * 2,
  counts: EMPTY_COUNTS,
  sessions: [],
  total: 0,
  standing: { ...growth.standing!, conversation_id: "fixture-escalations-conv", short_id: "jx7esc1", state: "dormant", state_status: "dormant", state_line: "Queue empty since the morning read", state_at: T0 - 50 * MIN },
};

/** ORG_FIXTURE with the @escalations role, whose area names the projects and plans the proposals touch. */
export const ORG_RECORDS_FIXTURE_TREE: OrgTree = { ...ORG_FIXTURE, roles: [...ORG_FIXTURE.roles, ESCALATIONS] };

// ---------------------------------------------------------------- builders

const AUTHOR: OrgProposalRow["author"] = { kind: "role", id: "fixture-role-head", name: "Head of People", short_id: "or-9" };
const THREAD = { conversation_id: "fixture-head-conv", short_id: "jx7ch1f" };

function proposal(n: number, title: string, summary_md: string, changes: OrgProposalChange[], extra: Partial<OrgProposalRow> = {}): OrgProposalRow {
  return { _id: `fixture-proposal-${n}`, short_id: `op-${n}`, team_id: "fixture-team", author: AUTHOR, thread: THREAD, title, summary_md, mode: "review", status: "open", created_at: T0 - 50 * MIN, changes, ...extra };
}

function rows(proposalId: string) {
  const changes: OrgProposalChange[] = [];
  const push = (change: OrgChange, rationale: string, more: Partial<OrgProposalChange> = {}): OrgProposalChange => {
    const seq = changes.length + 1;
    const row: OrgProposalChange = { _id: `${proposalId}-${seq}`, proposal_id: proposalId, seq, status: "proposed", change, rationale, evidence: [], ...more };
    changes.push(row);
    return row;
  };
  return { changes, push };
}

// ---------------------------------------------------------------- op-901: 64 records

/** Twelve task phrases; three run past 180 characters, the way real titles do. */
export const RECORD_TASK_PHRASES = [
  "Rank the matching queue by counterparty fit",
  "Dedupe inbound leads against the funnel table",
  "Caller sheet: show the last three calls on the row",
  "Retry a dropped call once before it files as missed",
  "Move the nightly rebuild to the warm pool",
  "Alert when the queue depth passes 200 for ten minutes",
  "Funnel stage rename: rename every stage key in the matching table, the caller sheet and the weekly digest, migrate the stored rows in place, and keep the old keys readable for one release so the dashboards hold",
  "Write the pitch template for the counterparty call",
  "Call recording retention: keep ninety days of audio and a year of transcripts, delete on request within a day, and write the retention rule where a caller can read it before the first call",
  "Network map: one page per network with its members",
  "Warm pool runbook: how a node joins, how it drains, what the alert thresholds are and who is paged at each one, with the commands pasted in rather than linked, so the on-call acts from the page",
  "Backfill short ids on the network rows",
];

/** Six reasons, one of 220 characters; chosen by what the change does, so a done row never reads as a reopen. */
export const RECORD_REASONS = {
  done: [
    "Marked in progress since the first week of September with its session done; the change is on main.",
    "No session and no commit naming it for 31 days.",
    "Its session ended with a done handoff; nobody closed the row.",
    "The plan it sat under closed three weeks ago and its own session declared done on the last day of that plan; the two commits it names are on main, the dashboard it describes is live, and the health sweep has flagged it twice.",
  ],
  reopened: "Reopened by a commit on Friday that names it; the board still says done.",
  closed: "Nobody has touched it since it was filed; the work it describes moved to another row.",
};
const reasonFor = (status: string, i: number): string =>
  status === "done" ? RECORD_REASONS.done[i % RECORD_REASONS.done.length] : status === "open" || status === "active" ? RECORD_REASONS.reopened : RECORD_REASONS.closed;

const RECORD_ROWS: OrgProposalChange[] = (() => {
  const { changes, push } = rows("fixture-records");
  let n = 0;
  const tasks = (count: number, status: OrgTaskStatusChange["status"], where: { project?: string; plan?: string }) => {
    for (let i = 0; i < count; i++) {
      n += 1;
      push({ kind: "task_status", task: `ct-${9100 + n}`, status, title: `Task ${n}: ${RECORD_TASK_PHRASES[(n - 1) % RECORD_TASK_PHRASES.length]}`, reason: reasonFor(status, n), ...where }, `Task ${n}: the board and the tree disagree.`);
    }
  };
  const plan = (ref: string, title: string, status: OrgPlanStatusChange["status"], project?: string) =>
    push({ kind: "plan_status", plan: ref, status, title, reason: reasonFor(status, 0), ...(project ? { project } : {}) }, `${ref}: the board says ${status === "active" ? "done" : "active"}, the evidence says ${status}.`);
  // A: pr-901 (18)
  plan("pl-921", "Funnel stages v2", "done", "pr-901");
  tasks(14, "done", { project: "pr-901" });
  tasks(3, "open", { project: "pr-901" });
  // B: pr-902 (18)
  plan("pl-922", "Caller sheet", "done", "pr-902");
  plan("pl-923", "Call retries", "done", "pr-902");
  plan("pl-924", "Voicemail drops", "abandoned", "pr-902");
  tasks(12, "done", { project: "pr-902" });
  tasks(2, "open", { project: "pr-902" });
  tasks(1, "dropped", { project: "pr-902" });
  // C: pr-903 (9)
  plan("pl-925", "Warm pool", "done", "pr-903");
  tasks(6, "done", { project: "pr-903" });
  tasks(2, "open", { project: "pr-903" });
  // P1: pl-911, under no project (6)
  plan("pl-911", "Counterparty pitches", "done");
  tasks(5, "done", { plan: "pl-911" });
  // P2: pl-912 (5)
  plan("pl-912", "Networks", "active");
  tasks(4, "open", { plan: "pl-912" });
  // Loose (8)
  plan("pl-926", "Q2 cleanup", "abandoned");
  plan("pl-927", "Old onboarding", "abandoned");
  tasks(2, "done", {});
  tasks(3, "open", {});
  tasks(1, "backlog", {});
  return changes;
})();

const RECORDS_LEAD = [
  "Sixty four records say something other than what the tree says. Forty four are finished work still marked open, fifteen are open work the board closed, and five plans nobody will pick up again.",
  "Nothing here starts or stops work: every change sets a status the evidence already supports, through the same update a person would use. I grouped them by project so you can settle one project at a time; the loose ones at the end sit under no project.",
].join("\n\n");

export const ORG_RECORDS_FIXTURE_PROPOSAL: OrgProposalRow = proposal(901, "Settle 64 stale records", RECORDS_LEAD, RECORD_ROWS, {
  asks: [{ title: "Settle 64 stale records", why: "The board and the tree disagree on 64 rows; every one has evidence on main or in a handoff.", effect: "44 done, 15 reopened, 3 abandoned, 1 dropped and 1 to the backlog. No work starts or stops.", seqs: RECORD_ROWS.map((r) => r.seq) }],
});

/** The same 64 with no plan or project on any row (the real op-57 as posted): one loose group. */
export const ORG_RECORDS_FIXTURE_PROPOSAL_BARE: OrgProposalRow = (() => {
  const unfiled = (c: OrgChange): OrgChange => {
    if (c.kind === "task_status") { const { plan: _p, project: _q, ...rest } = c; return rest; }
    if (c.kind === "plan_status") { const { project: _q, ...rest } = c; return rest; }
    return c;
  };
  const id = "fixture-proposal-901-bare";
  return { ...ORG_RECORDS_FIXTURE_PROPOSAL, _id: id, changes: RECORD_ROWS.map((r) => ({ ...r, _id: `fixture-records-bare-${r.seq}`, proposal_id: id, change: unfiled(r.change) })) };
})();

/** The grouped proposal after a send: A applied, B part way, C rejected, two of P1 failed, the rest still waiting. */
export const ORG_RECORDS_FIXTURE_PROPOSAL_SENT: OrgProposalRow = (() => {
  const groups = new Map(orgRecordGroups(RECORD_ROWS).map((g) => [g.key, g.seqs]));
  const at = T0 - 10 * MIN;
  const stamp = new Map<number, Partial<OrgProposalChange>>();
  const mark = (key: string, status: OrgChangeStatus, more: Partial<OrgProposalChange> = {}, pick?: (i: number) => boolean) => {
    for (const [i, seq] of (groups.get(key) ?? []).entries()) if (!pick || pick(i)) stamp.set(seq, { status, decided_at: at, ...more });
  };
  mark("project:pr-901", "applied", { applied_at: at });
  mark("project:pr-902", "applied", { applied_at: at }, (i) => i < 10);
  mark("project:pr-902", "accepted", {}, (i) => i >= 10);
  mark("project:pr-903", "skipped", { reply: { verdict: "reject", text: "Not yet", at } });
  mark("plan:pl-911", "failed", { applied_note: "pl-911 is already done" }, (i) => i < 2);
  const id = "fixture-proposal-901-sent";
  return { ...ORG_RECORDS_FIXTURE_PROPOSAL, _id: id, changes: RECORD_ROWS.map((r) => ({ ...r, _id: `fixture-records-sent-${r.seq}`, proposal_id: id, ...stamp.get(r.seq) })) };
})();

// ---------------------------------------------------------------- op-902: a charter edited in place

export const ESCALATIONS_CHARTER_EDITS: OrgCharterEdit[] = [
  { op: "replace", before: ESCALATIONS_CHARTER_SENTENCES[1], after: "Reads the escalation queue at the start of every wake and answers each one within the hop deadline, oldest first." },
  { op: "add", line: "Posts the digest to the team channel on Monday before the standup." },
  { op: "remove", before: ESCALATIONS_CHARTER_SENTENCES[5] },
];

const MATCHING_GOAL_AFTER = "Every inbound lead reaches a ranked shortlist within a day. The funnel reads the same on the sheet, in the digest and on the caller's row. A lead that waits past a day is on the morning escalation list.";

export const ORG_CHARTER_EDIT_FIXTURE_PROPOSAL: OrgProposalRow = (() => {
  const { changes, push } = rows("fixture-charter-edit");
  const edit = push({ kind: "charter_edit", handle: "escalations", edits: ESCALATIONS_CHARTER_EDITS }, "The charter says morning and afternoon; the role wakes on the queue now, and the Platform line is covered by the sync layer's own routine.", {
    evidence: [{ label: "Wake log, last 14 days", href: "/org/or-12?tab=wakes" }],
    expected_effect: "The role reads the queue when it wakes, not twice a day; the digest reaches the channel.",
  });
  edit.revision = { kind: "amended", note: "Added the digest line; the channel post was in the routine, not the charter.", at: T0 - 20 * MIN, before: { kind: "charter_edit", handle: "escalations", edits: [ESCALATIONS_CHARTER_EDITS[0], ESCALATIONS_CHARTER_EDITS[2]] } };
  push({ kind: "project_meta", project: "pr-901", goal: MATCHING_GOAL_AFTER }, "The goal never says what happens to a lead that waits; the escalation ledger shows nine of them this month.", {
    evidence: [{ label: "9 leads past a day", href: "/projects/pr-901" }],
  });
  return proposal(902, "Sharpen the Escalations lead's charter", "Two edits to the Escalations lead's charter and one line added, and the matching goal gains the sentence the ledger keeps asking for.", changes);
})();

// ---------------------------------------------------------------- op-903: a long charter (op-56's shape)

const DESK_DESCRIPTION = "The counterparty desk: who we introduce to whom, the pitch each side hears, the follow up after the call, and the ledger of which introductions became a transaction and which went quiet.";

/** The charter as amended: 1449 characters, with numbered steps, an "e.g." and a URL. */
export const PARTNERSHIPS_CHARTER = [
  "Owns the counterparty desk: every introduction we broker, from the first pitch to the follow up after the call, and the ledger that says which ones became a transaction.",
  "Each week the role: 1. reads the matching queue and picks the ten introductions most likely to close, e.g. a buyer and a seller in the same vertical with no prior contact; 2. drafts the pitch each side hears, in the voice of the person who will make the call; 3. books the calls through the callers project and sits in on the first three of the week; 4. writes the follow up within a day of each call, with the next step named and dated; 5. updates the ledger at https://example.com/desk/ledger with the outcome, the reason it went quiet when it did, and what the pitch should have said.",
  "Decides alone which introductions to make and what the pitch says; brings a person in before any fee is quoted, before any introduction crosses a conflict the ledger records, and before anything is sent to a counterparty who asked not to be contacted.",
  "Measures itself on introductions that reach a second call and on transactions closed within a quarter, never on the number of pitches sent.",
  "Keeps the pitch templates current, retires the ones that have not produced a second call in a month, and writes down why.",
  "Reports to Cam on the week's ledger every Friday and on any introduction that went wrong the same day.",
].join(" ");

/** The charter as first proposed: 874 characters, the same job before the steps were written out. */
export const PARTNERSHIPS_CHARTER_BEFORE = [
  "Owns the counterparty desk: every introduction we broker, from the first pitch to the follow up after the call, and the ledger that says which ones became a transaction.",
  "Picks the introductions most likely to close, drafts the pitch each side hears, books the calls through the callers project and writes the follow up within a day of each call.",
  "Decides alone which introductions to make and what the pitch says; brings a person in before any fee is quoted and before any introduction crosses a conflict the ledger records.",
  "Measures itself on introductions that reach a second call and on transactions closed within a quarter.",
  "Reports to Cam on the week's ledger every Friday and on any introduction that went wrong the same day.",
].join(" ");

export const ORG_LONG_CHARTER_FIXTURE_PROPOSAL: OrgProposalRow = (() => {
  const { changes, push } = rows("fixture-long-charter");
  push({ kind: "projects", changes: [{ op: "create", title: "Counterparty Desk", description: DESK_DESCRIPTION }] }, "Forty introductions this quarter were tracked in three sheets and a chat thread; none of them file under a project.", {
    evidence: [{ label: "3 sheets, 1 thread", href: "/feed?q=introduction" }],
  });
  const role: OrgRoleProposal = { kind: "role", name: "Partnerships lead", handle: "partnerships", reports_to: "Cam", scope: { projects: ["Counterparty Desk"] }, charter: PARTNERSHIPS_CHARTER, tenure: { kind: "standing" } };
  push(role, "The desk has no owner: the pitches are written by whoever has the call, and nobody writes the follow up.", {
    evidence: [{ label: "12 calls with no follow up", href: "/tasks?project=Counterparty+Desk" }],
    expected_effect: "Every introduction has a pitch, a call and a follow up, and the ledger says what happened.",
    risk: "The charter is long for a first wake; the role will read the whole desk before it acts.",
    revision: { kind: "amended", note: "Wrote the weekly steps out after you asked what the role does on its own.", at: T0 - 15 * MIN, before: { ...role, charter: PARTNERSHIPS_CHARTER_BEFORE } },
  });
  return proposal(903, "A Partnerships lead for the counterparty desk", "One project for the introductions we broker and one role to own it, reporting to Cam.", changes);
})();

/** What the cards read a before from: the tree, the projects, the plans, and the tasks the record proposal names as the board holds them now. */
export const ORG_RECORDS_FIXTURE_LIVE: SubjectLive = {
  tree: ORG_RECORDS_FIXTURE_TREE,
  goals: [],
  projects: ORG_RECORDS_FIXTURE_PROJECTS,
  plans: ORG_RECORDS_FIXTURE_PLANS,
  tasks: RECORD_ROWS.flatMap((r) => (r.change.kind === "task_status" ? [{ _id: `fixture-task-${r.change.task}`, short_id: r.change.task, title: r.change.title ?? r.change.task, status: r.change.status === "open" ? "done" : "in_progress" }] : [])),
};

export const ORG_RECORDS_FIXTURE_PROPOSALS: readonly OrgProposalRow[] = [ORG_RECORDS_FIXTURE_PROPOSAL, ORG_RECORDS_FIXTURE_PROPOSAL_BARE, ORG_RECORDS_FIXTURE_PROPOSAL_SENT, ORG_CHARTER_EDIT_FIXTURE_PROPOSAL, ORG_LONG_CHARTER_FIXTURE_PROPOSAL];
