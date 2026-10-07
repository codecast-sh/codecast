// Org proposals (docs/architecture/org-init.md O2): the machine-readable half
// of a decision `cast org init` or `cast org update` posts. The analyzer writes
// one fenced JSON block into the decision's context; `cast org apply` reads
// the block back and acts on the answer. The CLI prompt, the Convex apply
// path and both tests share this one reading of the block and of the option
// order, so an option index means the same thing everywhere.

import { autonomyOn, trustForSwitch } from "./roleAutonomy";
import { INITIATIVE_RECORD_MAX } from "./initiative";
import { proposalChangeRefId } from "../entities";

export const ORG_PROPOSAL_FENCE = "org-proposal";

/** `cards` is the line's admission cap (line-profile.md LP6): open change cards per person. */
export type OrgProposalCaps = { hands_per_day?: number; wakes_per_day?: number; tokens_per_day?: number; cards?: number };

// The line a role's tasks run on (the-line.md L2): a workflow slug, absent
// meaning the shipped "line" template.
export const DEFAULT_LINE_SLUG = "line";
/** The line a role runs: its own pick, else the shipped line. */
export const lineSlugOf = (role: { line_workflow_slug?: string | null }): string => role.line_workflow_slug || DEFAULT_LINE_SLUG;
export const LINE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type OrgProposalScope = {
  /** Project refs: a short id, an id, or a title substring unique in the workspace. */
  projects?: string[];
  /** Plan refs: pl-N or an id. */
  plans?: string[];
};

/** Standing or program (org-staffing.md S10). In a spec the end names a plan
 *  by short id, a project by any ref, or a date in unix ms; the apply path
 *  resolves refs into ids inside the boundary. */
export type OrgTenureSpec =
  | { kind: "standing" }
  | { kind: "program"; ends: { plan: string } | { project: string } | { date: number }; then: "retire" | "review" };

/** A session that already works as this role (org-roles-run-work.md R2).
 *  Accepting the role names it: the session becomes the role's standing
 *  session with its history intact, and no new session starts. `title`,
 *  `started_at` and `helpers` are what the author read about the session (its
 *  title, when it started in unix ms, how many sessions it has started as
 *  helpers); the ghost card's sentence is built from them (seatSentence). */
export type OrgRoleSeat = { existing: string; title?: string; started_at?: number; helpers?: number };

export type OrgRoleProposal = {
  kind: "role";
  name: string;
  handle: string;
  /** Absent = a fresh standing session is started for the role. */
  seat?: OrgRoleSeat;
  scope?: OrgProposalScope;
  tenure?: OrgTenureSpec;
  /** A key from orgAvatars.AVATAR_KEYS; absent = the default for the handle. */
  avatar?: string;
  /** "@handle" or "or-N" for a role, "me" or a member's name for a person; absent = the person applying. */
  reports_to?: string;
  charter?: string;
  /** The switch as stored (org-staffing.md S23.1); a hired role starts on, so a proposal rarely writes it. */
  trust?: OrgTrustStage;
  caps?: OrgProposalCaps;
  /** The workflow slug its line runs on (line-profile.md LP7); absent = the role's default. */
  line?: string;
  /** See OrgLeaveSessions: the sessions in the new role's scope stay with their owner. */
  leave_sessions?: boolean;
  /** The counts and session titles the proposal rests on; prose for the reader. */
  evidence?: string[];
};

export type OrgProjectHorizon = "ongoing" | "bounded";

export type OrgProjectChange =
  | { op: "create"; title: string; description?: string; project_path?: string; horizon?: OrgProjectHorizon }
  | { op: "merge"; from: string; into: string };

export type OrgProjectsProposal = { kind: "projects"; changes: OrgProjectChange[] };

export type OrgMoveProposal = {
  kind: "move";
  handle: string;
  reports_to?: string;
  scope_add?: string[];
  scope_remove?: string[];
  reason?: string;
  /** See OrgLeaveSessions: with `scope_add`, the sessions in the gained scope stay with their owner. */
  leave_sessions?: boolean;
};

export type OrgRetireProposal = { kind: "retire"; handle: string; reason?: string };

export type OrgProposal = OrgRoleProposal | OrgProjectsProposal | OrgMoveProposal | OrgRetireProposal;

export const ORG_PROPOSAL_KINDS = ["role", "projects", "move", "retire"] as const;

// ── Staffing changes (docs/architecture/org-staffing.md S4) ──────────────────
// A proposal (op-N) is a list of changes decided one by one. The four stack
// kinds above are changes too; these six are the staffing additions. One
// validator per kind, one apply order, one describer: the CLI walk, the
// server's create mutation and the ghost nodes on the org page read these.

export type OrgTrustStage = "understand" | "decide" | "direct";
export type OrgPriority = "p0" | "p1" | "p2" | "p3";

/** A role that gains scope takes over the sessions in it that report to its
 *  host and to no role (org-roles-run-work.md R1). `leave_sessions` is the
 *  person's one edit on a role, scope or adopt change: leave them where they are. */
export type OrgLeaveSessions = { leave_sessions?: boolean };
export type OrgScopeChange = { kind: "scope"; handle: string; add?: string[]; remove?: string[] } & OrgLeaveSessions;
export type OrgBudgetChange = { kind: "budget"; handle: string; caps: OrgProposalCaps };
/** The switch (org-staffing.md S23.1). The wire kind stays `trust` for one release; a spec may
 *  write `{ kind: "autonomy", handle, on }` and parseOrgProposalSpec maps it here. */
export type OrgTrustChange = { kind: "trust"; handle: string; trust: OrgTrustStage };
/** A spec's switch change before parsing maps it onto the stored kind. */
export function normalizeAutonomyChange(raw: any): any {
  if (!raw || typeof raw !== "object" || raw.kind !== "autonomy") return raw;
  const { on, ...rest } = raw;
  return { ...rest, kind: "trust", trust: typeof on === "boolean" ? trustForSwitch(on) : on };
}
export type OrgRoutineChange = { kind: "routine"; handle: string; title: string; prompt: string; every: string };
export type OrgProjectMetaChange = {
  kind: "project_meta";
  project: string;
  goal?: string;
  success_metrics?: string[];
  priority?: OrgPriority;
  /** "@handle" of the owner role. */
  owner?: string;
  non_goals?: string[];
  risks?: string[];
};
/** This session becomes the role's standing session (the analyzer offering to be the head of people). */
export type OrgAdoptChange = { kind: "adopt"; handle: string; conversation: string } & OrgLeaveSessions;
/** File a plan under a project (plans.project_id), so a role's scope can see it. Both are refs. */
export type OrgFileChange = { kind: "file"; plan: string; project: string };

// A role's charter edited in place (org-staffing.md S7): the change carries
// only what moves, never the whole text, so the card draws each passage
// before and after and a reader sees the edit, not two charters. A passage
// names an exact, unique stretch of the charter as it stands; the apply path
// substitutes it (applyCharterEdits) and writes the result through the role's
// own update. The charter stays short: the job in a few sentences.
export const ORG_CHARTER_MAX = 800;
export const ORG_CHARTER_PASSAGE_MAX = 300;
export const ORG_CHARTER_EDITS_MAX = 5;
/** How to bring a charter under the cap, said once wherever the cap refuses. */
export const ORG_CHARTER_CONDENSE = `a charter is the job in a few sentences, at most ${ORG_CHARTER_MAX} characters: what the role watches, what it does on its own, and what it brings to a person; cut examples, procedures, and anything its routine or its scope already says`;
export type OrgCharterEdit =
  | { op: "replace"; before: string; after: string }
  | { op: "add"; line: string }
  | { op: "remove"; before: string };
export type OrgCharterEditChange = { kind: "charter_edit"; handle: string; edits: OrgCharterEdit[] };

// Bring records in line (org-staffing.md S9): a plan, task or project whose
// evidence says it is finished gets its status set, through the same update
// paths a person uses. `reason` is the evidence, for the person deciding.
// `title` is the record's own title, carried on the change so the row reads
// "Mark done: <title>" wherever the proposal is read: a reader's store may
// not hold that team's records, so the title travels with the proposal (the
// analyzer writes it from its inputs; the server fills it at post time when
// the record is in the workspace).
export type OrgPlanStatusChange = { kind: "plan_status"; plan: string; status: "done" | "abandoned" | "active"; reason: string; title?: string; /** The project the plan is filed under (pr-N), so the proposal groups by it (orgRecordGroups); the server fills it at post time. */ project?: string };
/** A task's status set: done or dropped closes it; open (or backlog, where the
 *  team's statuses have it) puts a row that was marked in progress but never
 *  worked back where it belongs, instead of dropping real backlog. */
export type OrgTaskStatusChange = { kind: "task_status"; task: string; status: "done" | "dropped" | "open" | "backlog"; reason: string; title?: string; /** The plan (pl-N) and project (pr-N) the task sits under; the server fills them at post time. A task under a plan the same proposal closes is settled by that close (orgRecordRedundancyErrors). */ plan?: string; project?: string };
export type OrgProjectStatusChange = { kind: "project_status"; project: string; status: "paused" | "done" | "active"; reason: string; title?: string };
export type OrgRecordStatusChange = OrgPlanStatusChange | OrgTaskStatusChange | OrgProjectStatusChange;

// Hiring from a template (org-hire.md W8). Trust is authority inside codecast;
// `authority` is what a person lets a role do outside it: spend on an account,
// publish to destinations, write into a project, connect a service, each with
// a limit and a review boundary. A hire is the instance of a template on one
// project; the role change of the same handle in the same proposal is its seat.
export type OrgAuthorityKind = "spend" | "publish" | "write" | "connect";
export type OrgAuthorityLimit = { usd_per_month?: number; usd_per_day?: number; per_day?: number };
export type OrgAuthorityGrant = { id: string; kind: OrgAuthorityKind; label: string; scope?: string; limit?: OrgAuthorityLimit; expires?: string };
export type OrgAuthorityChange = { kind: "authority"; handle: string; authority: OrgAuthorityGrant[] };
export type OrgHireChange = {
  kind: "hire"; handle: string; template: string; version: string; digest: string; instance: string; project: string;
  /** Answers to the template's inputs; never a secret's value (those bind on the host). */
  config?: Record<string, string>;
  update_policy?: "manual" | "canary" | "stable";
};
/** Move an instance to another release of its template (H9); the host step performs it. */
export type OrgUpgradeChange = { kind: "upgrade"; instance: string; template: string; to: string; digest: string };

// The company's goals (initiatives-projects-role-page.md "I1, revised"): a
// reviewer that reads one shared goal in the projects' own goals, a call or a
// chat thread proposes it as a change, and a person accepts. Every ref here
// is what the analyzer read: a project's short id, id or title; an
// initiative's in-N, id or title; an owner as "@handle", "me" or a member's
// name. `title` on the two changes to an existing initiative is its title,
// carried so the row reads cold in a store that does not hold the row.
/** How a goal is measured: a name and the number to reach ("Weekly active teams", "1000"). At most two. */
export type OrgInitiativeMetric = { name: string; target: string };
/** A step on the way to a goal, with the day it is due (unix ms) when one was named. */
export type OrgInitiativeMilestone = { title: string; date?: number };
/** The written half of a goal's intent record (I5) a change may carry: why
 *  it matters, what done looks like, milestones, where the goal was stated
 *  (`sources`: each an address, the words said, or both, read by
 *  parseIntentSource), what is still undecided and what was decided. */
export type OrgInitiativeRecord = { why?: string; done_when?: string; milestones?: OrgInitiativeMilestone[]; sources?: string[]; questions?: string[]; decisions?: string[] };
/** Set a goal: the initiative with the sentence that says what reaching it
 *  looks like, the projects that carry it, who drives it, the top level goal
 *  it feeds (`parent`: a ref, or the title of a goal set earlier in the same
 *  proposal), the one or two numbers it is measured by, and its record. */
export type OrgInitiativeChange = { kind: "initiative"; title: string; description: string; projects: string[]; owner?: string; target_date?: number; parent?: string; metrics?: OrgInitiativeMetric[]; evidence?: string[] } & OrgInitiativeRecord;
/** Add projects to a goal that exists. */
export type OrgInitiativeProjectsChange = { kind: "initiative_projects"; initiative: string; projects: string[]; title?: string };
/** Give a goal an owner, a person or a role. */
export type OrgInitiativeOwnerChange = { kind: "initiative_owner"; initiative: string; owner: string; title?: string };
/** Place a goal that exists in the tree, say how it is measured and write its
 *  record: `parent` is a ref or null (a top level goal), `metrics` replaces
 *  the list, `why` and `done_when` replace the words, and `milestones`,
 *  `sources`, `questions` and `decisions` are entries to ADD, never a
 *  replacement. Each is optional and an absent one is left as it is. */
export type OrgInitiativeShapeChange = { kind: "initiative_shape"; initiative: string; parent?: string | null; metrics?: OrgInitiativeMetric[]; title?: string } & OrgInitiativeRecord;
export type OrgGoalChange = OrgInitiativeChange | OrgInitiativeProjectsChange | OrgInitiativeOwnerChange | OrgInitiativeShapeChange;

export type OrgChange = OrgProposal | OrgScopeChange | OrgBudgetChange | OrgTrustChange | OrgRoutineChange | OrgProjectMetaChange | OrgAdoptChange | OrgFileChange | OrgCharterEditChange
  | OrgPlanStatusChange | OrgTaskStatusChange | OrgProjectStatusChange | OrgAuthorityChange | OrgHireChange | OrgUpgradeChange | OrgGoalChange;

export const ORG_CHANGE_KINDS = [...ORG_PROPOSAL_KINDS, "file", "scope", "budget", "trust", "routine", "project_meta", "adopt", "charter_edit", "plan_status", "task_status", "project_status", "authority", "hire", "upgrade", "initiative", "initiative_projects", "initiative_owner", "initiative_shape"] as const;
/** The kinds the pane groups under "Bring records in line" (S9). */
export const ORG_SYNC_KINDS: readonly OrgChangeKind[] = ["plan_status", "task_status", "project_status"];
/** The kinds that set, extend or staff a goal; one ask holds them (I1, revised). */
export const ORG_GOAL_KINDS: readonly OrgChangeKind[] = ["initiative", "initiative_projects", "initiative_owner", "initiative_shape"];
/** Kinds a person never sees drawn (org-staffing.md S23.2): a limit is a safety
 *  net the person does not read about, so a card draws no chip and no row for
 *  it. A proposal holding nothing else says what changes in plain words, with
 *  no unit named (quietChangeSentence). */
export const ORG_QUIET_KINDS: readonly OrgChangeKind[] = ["budget"];
export const isOrgQuietChange = (c: { kind: string }): boolean => (ORG_QUIET_KINDS as readonly string[]).includes(c.kind);
/** The plain sentence for a quiet change: what changes, never how much. */
export function quietChangeSentence(c: OrgChange, name?: string): string {
  const who = name ?? ("handle" in c && typeof (c as { handle?: unknown }).handle === "string" ? `@${(c as { handle: string }).handle.replace(/^@/, "")}` : "the role");
  return `${who} keeps a safety net on its daily work.`;
}
export const isOrgGoalChange = (c: { kind: string }): c is OrgGoalChange => (ORG_GOAL_KINDS as readonly string[]).includes(c.kind);
export type OrgChangeKind = OrgChange["kind"];

// A proposal holds one kind of work: the records brought in line, the
// structure (roles, reporting, areas, charters), or the goals. A person reads
// each as its own thing, so one spec never mixes them (parseOrgProposalSpec
// refuses a mixed one and says how to split it). Records are uncapped, since
// a review settles every stale record it finds and the groups keep them
// readable; a structure or goal proposal stays small enough to read whole.
// The cap is read off Union's real proposals: the largest structure proposal
// held 9 changes and the first goal tree 11 (op-55, op-54, 2026-10-06); 12
// holds both and refuses the 64-row record shape that has no place here.
export type OrgProposalWork = "records" | "structure" | "goals";
export const ORG_PROPOSAL_WORKS: readonly OrgProposalWork[] = ["records", "structure", "goals"];
export const ORG_PROPOSAL_MAX: Record<OrgProposalWork, number | null> = { records: null, structure: 12, goals: 12 };
export function orgWorkOfChange(c: { kind: string }): OrgProposalWork {
  return (ORG_SYNC_KINDS as readonly string[]).includes(c.kind) ? "records" : (ORG_GOAL_KINDS as readonly string[]).includes(c.kind) ? "goals" : "structure";
}
/** The work the changes hold, or null when they mix kinds. */
export function orgProposalWork(changes: ReadonlyArray<{ change: { kind: string } }>): OrgProposalWork | null {
  const works = new Set(changes.map((c) => orgWorkOfChange(c.change)));
  return works.size === 1 ? [...works][0] : null;
}
/** Why the changes are not one proposal: mixed work, or a structure or goal proposal too large to read whole. */
export function orgProposalWorkErrors(changes: ReadonlyArray<{ change: { kind: string } }>): string[] {
  if (!changes.length) return [];
  const byWork = new Map<OrgProposalWork, string[]>();
  for (const c of changes) { const w = orgWorkOfChange(c.change); byWork.set(w, [...(byWork.get(w) ?? []), c.change.kind]); }
  if (byWork.size > 1) {
    const noun: Record<OrgProposalWork, string> = { records: "record", structure: "structure", goals: "goal" };
    const parts = ORG_PROPOSAL_WORKS.filter((w) => byWork.has(w)).map((w) => { const kinds = byWork.get(w)!; return `${kinds.length} ${noun[w]} ${kinds.length === 1 ? "change" : "changes"} (${[...new Set(kinds)].join(", ")})`; });
    return [`a proposal holds one kind of work, and this one mixes ${andList(parts)}: post the records as one proposal, the structure as another and the goals as a third, each with its own title and summary`];
  }
  const [work, kinds] = [...byWork][0];
  const max = ORG_PROPOSAL_MAX[work];
  if (max !== null && kinds.length > max) return [`a ${work === "goals" ? "goal" : work} proposal holds at most ${max} changes, and this one has ${kinds.length}: split it by area (one proposal per lead, project or goal) or leave the smaller changes for the next review`];
  return [];
}

/** Accept order (S4, S9): the record syncs first (a plan, task or project
 *  whose status the evidence contradicts), then projects, then roles
 *  (parents before children in the proposal's own order), then project
 *  charters (an owner may be a role the same proposal creates), then moves,
 *  scope, budget, trust, routines, adopt, retire. A retirement goes last so
 *  a move off the retiring role lands first; adopt goes after the role it
 *  names exists and BEFORE a routine on it: a role whose proposal also
 *  carries its adopt is created without a standing session (the adopt seats
 *  it), and a routine needs that session to run on. A task's own status lands before its plan's, because closing
 *  a plan cascades to the plan's still-open tasks (dropped): a task the
 *  proposal marks done on its own evidence must be done before the cascade
 *  reads it. Authority lands after trust on a role that exists; a hire lands
 *  after the role, its authority and any routine, since the instance row it
 *  writes names them; an upgrade stands alone. A goal lands after the
 *  projects and the roles it names (a project created in the same proposal,
 *  an owner role it creates), and before the moves and scopes: an owner role
 *  gains the goal's projects in its scope when the owner is set. */
export const ORG_CHANGE_APPLY_RANK: Record<OrgChangeKind, number> = {
  task_status: 0, plan_status: 1, project_status: 2,
  projects: 3, file: 4, role: 5, project_meta: 6, initiative: 7, initiative_projects: 8, initiative_owner: 9, initiative_shape: 10,
  move: 11, scope: 12, charter_edit: 13, budget: 14, trust: 15, authority: 16, adopt: 17, routine: 18, hire: 19, upgrade: 20, retire: 21,
};
const UNRANKED = Math.max(...Object.values(ORG_CHANGE_APPLY_RANK)) + 1;

/** Stable sort by apply rank; ties keep their given order. */
export function orderOrgChanges<T>(rows: T[], changeOf: (row: T) => OrgChange | null | undefined): T[] {
  const rank = (row: T) => { const c = changeOf(row); return c ? ORG_CHANGE_APPLY_RANK[c.kind] : UNRANKED; };
  return rows.map((row, i) => ({ row, i, r: rank(row) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.row);
}

const ORG_TRUST_STAGES: readonly string[] = ["understand", "decide", "direct"];
export const ORG_AUTHORITY_KINDS: readonly OrgAuthorityKind[] = ["spend", "publish", "write", "connect"];
const SLUG_RE = /^[a-z][a-z0-9-]{0,47}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const ORG_PRIORITIES: readonly string[] = ["p0", "p1", "p2", "p3"];
export const ORG_PROJECT_HORIZONS: readonly OrgProjectHorizon[] = ["ongoing", "bounded"];
export const ORG_TENURE_THEN: readonly ("retire" | "review")[] = ["retire", "review"];
export const PLAN_STATUS_CHANGES: readonly OrgPlanStatusChange["status"][] = ["done", "abandoned", "active"];
export const TASK_STATUS_CHANGES: readonly OrgTaskStatusChange["status"][] = ["done", "dropped", "open", "backlog"];
export const PROJECT_STATUS_CHANGES: readonly OrgProjectStatusChange["status"][] = ["paused", "done", "active"];

/** Why a tenure is not one, or null. Shared by the spec validator and the role mutations. */
export function orgTenureError(raw: any): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "tenure is { kind: standing } or { kind: program, ends, then }";
  if (raw.kind === "standing") return null;
  if (raw.kind !== "program") return `tenure kind is standing or program, not ${JSON.stringify(raw.kind)}`;
  const e = raw.ends;
  if (!e || typeof e !== "object" || Array.isArray(e)) return "a program's ends is { plan }, { project } or { date }";
  const keys = Object.keys(e).filter((k) => e[k] !== undefined);
  if (keys.length !== 1 || !["plan", "project", "date"].includes(keys[0])) return "a program ends with exactly one of plan, project, date";
  if (keys[0] === "date" ? !(typeof e.date === "number" && e.date > 0) : !nonEmpty(e[keys[0]])) return keys[0] === "date" ? "a program's end date is unix ms" : `a program's end ${keys[0]} is a ref`;
  return (ORG_TENURE_THEN as readonly string[]).includes(raw.then) ? null : "a program's then is retire or review";
}
/** Why a role's seat is not one, or null. */
export function orgRoleSeatError(raw: any): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !nonEmpty(raw.existing)) return "seat is { existing: the short id of the session that becomes the role's standing session }";
  if (!optString(raw.title)) return "seat title is the session's title";
  const count = (x: any) => x === undefined || (typeof x === "number" && x >= 0);
  return count(raw.started_at) && count(raw.helpers) ? null : "seat started_at is unix ms and helpers is a count";
}

const DAY_MS = 86_400_000;
/** What naming an existing session changes, said to a person who has never
 *  seen a role (R2): the ghost card, the derived ask and the CLI walk all print
 *  these words. The age is read at render, so it stays true while the proposal
 *  waits. */
export function seatSentence(seat: OrgRoleSeat, now: number = Date.now()): string {
  const days = seat.started_at ? Math.floor((now - seat.started_at) / DAY_MS) : 0;
  const ran = days >= 1 ? `has run for ${days} ${days === 1 ? "day" : "days"}` : "";
  const helped = seat.helpers ? `${ran ? "with" : "has started"} ${seat.helpers.toLocaleString("en-US")} helper ${seat.helpers === 1 ? "session" : "sessions"}` : "";
  const facts = [ran, helped].filter(Boolean).join(" ");
  const who = seat.title?.trim() ? seat.title.trim() : `the session ${seat.existing}`;
  return `This is ${who}${facts ? `, which ${facts}` : ""}. Naming it changes nothing about how it works and gives it a place on the chart.`;
}

const HANDLE_RE = /^[a-z0-9-]{2,32}$/;
const EVERY_RE = /^\d+(m|h|d|w)$/;

/** A routine's cadence ("7d", "12h", "30m", "2w") in milliseconds; null when it is not one. */
export function orgEveryToMs(every: string): number | null {
  const m = /^(\d+)(m|h|d|w)$/.exec((every ?? "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }[m[2] as "m" | "h" | "d" | "w"];
  return n > 0 ? n * unit : null;
}

const nonEmpty = (x: any): x is string => typeof x === "string" && x.trim().length > 0;
const strings = (x: any): boolean => Array.isArray(x) && x.every(nonEmpty);
const optStrings = (x: any): boolean => x === undefined || strings(x);
const optString = (x: any): boolean => x === undefined || typeof x === "string";
const capsOk = (x: any): boolean => !!x && typeof x === "object" && !Array.isArray(x) &&
  ["hands_per_day", "wakes_per_day", "tokens_per_day"].every((k) => x[k] === undefined || (typeof x[k] === "number" && x[k] >= 0)) &&
  ["hands_per_day", "wakes_per_day", "tokens_per_day"].some((k) => typeof x[k] === "number");

/** Why a change is not one, or null when it is. One message, the first fault. */
export function orgChangeError(raw: any): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "a change is an object with a kind";
  if (!ORG_CHANGE_KINDS.includes(raw.kind)) return `unknown change kind ${JSON.stringify(raw.kind)}; one of ${ORG_CHANGE_KINDS.join(", ")}`;
  const handle = (): string | null => nonEmpty(raw.handle) ? (HANDLE_RE.test(raw.handle.replace(/^@/, "")) ? null : `handle ${JSON.stringify(raw.handle)} is not a-z, 0-9 and - (2 to 32 chars)`) : "handle is required";
  if (raw.leave_sessions !== undefined && typeof raw.leave_sessions !== "boolean") return "leave_sessions is true or false";
  switch (raw.kind as OrgChangeKind) {
    case "role": case "projects": case "move": case "retire": {
      if (!isOrgProposal(raw)) return `${raw.kind} is missing its required fields`;
      if (raw.kind === "role") {
        const h = handle(); if (h) return h;
        if (raw.tenure !== undefined) { const t = orgTenureError(raw.tenure); if (t) return t; }
        if (raw.avatar !== undefined && !nonEmpty(raw.avatar)) return "avatar is an avatar key";
        if (raw.charter !== undefined && typeof raw.charter !== "string") return "charter is a string";
        if (typeof raw.charter === "string" && raw.charter.trim().length > ORG_CHARTER_MAX) return `charter is ${raw.charter.trim().length} characters; ${ORG_CHARTER_CONDENSE}`;
        if (raw.line !== undefined && !(typeof raw.line === "string" && LINE_SLUG_RE.test(raw.line))) return "line is a workflow slug: 1 to 64 characters of a-z, 0-9 and -";
        if (raw.caps?.cards !== undefined && !(Number.isSafeInteger(raw.caps.cards) && raw.caps.cards > 0)) return "caps.cards is a positive whole number";
        if (raw.seat !== undefined) {
          const s = orgRoleSeatError(raw.seat); if (s) return s;
          // The card promises naming changes nothing about how the session
          // works, and who it answers to is part of that: a move is its own change.
          if (typeof raw.reports_to === "string" && raw.reports_to.trim().startsWith("@")) return "a role that names its session keeps the session's reporting line (the person who runs it); to put it under a role, add a separate move change";
        }
      }
      if (raw.kind === "projects") {
        const bad = raw.changes.find((c: any) => c.op === "create" && c.horizon !== undefined && !(ORG_PROJECT_HORIZONS as readonly string[]).includes(c.horizon));
        if (bad) return `project horizon is one of ${ORG_PROJECT_HORIZONS.join(", ")}`;
      }
      return null;
    }
    case "scope": {
      const h = handle(); if (h) return h;
      if (!optStrings(raw.add) || !optStrings(raw.remove)) return "scope add and remove are lists of project or plan refs";
      if (!(raw.add?.length || raw.remove?.length)) return "scope needs at least one ref to add or remove";
      return null;
    }
    case "budget": {
      const h = handle(); if (h) return h;
      return capsOk(raw.caps) ? null : "budget caps needs at least one of hands_per_day, wakes_per_day, tokens_per_day as a non-negative number";
    }
    case "trust": {
      const h = handle(); if (h) return h;
      return ORG_TRUST_STAGES.includes(raw.trust) ? null : "autonomy on is true or false";
    }
    case "routine": {
      const h = handle(); if (h) return h;
      if (!nonEmpty(raw.title) || !nonEmpty(raw.prompt)) return "routine needs a title and a prompt";
      return nonEmpty(raw.every) && EVERY_RE.test(raw.every) ? null : "routine every is a duration like 7d, 1d, 12h";
    }
    case "project_meta": {
      if (!nonEmpty(raw.project)) return "project_meta needs a project ref";
      if (!optString(raw.goal) || !optStrings(raw.success_metrics) || !optStrings(raw.non_goals) || !optStrings(raw.risks)) return "project_meta goal is a string; success_metrics, non_goals and risks are lists of strings";
      if (raw.priority !== undefined && !ORG_PRIORITIES.includes(raw.priority)) return `priority is one of ${ORG_PRIORITIES.join(", ")}`;
      if (raw.owner !== undefined && !nonEmpty(raw.owner)) return "owner is a role handle";
      if (![raw.goal, raw.success_metrics, raw.priority, raw.owner, raw.non_goals, raw.risks].some((x) => x !== undefined)) return "project_meta changes nothing";
      return null;
    }
    case "adopt": {
      const h = handle(); if (h) return h;
      return nonEmpty(raw.conversation) ? null : "adopt needs the conversation (a session short id) that becomes the role's standing session";
    }
    case "authority": {
      const h = handle(); if (h) return h;
      if (!Array.isArray(raw.authority) || !raw.authority.length || raw.authority.length > 50) return "authority is a list of one to fifty grants";
      const ids = new Set<string>();
      for (const g of raw.authority) {
        if (!g || typeof g !== "object") return "each authority grant is an object";
        if (!nonEmpty(g.id) || !SLUG_RE.test(g.id) || ids.has(g.id)) return "each authority grant has a unique slug id";
        ids.add(g.id);
        if (!(ORG_AUTHORITY_KINDS as readonly string[]).includes(g.kind)) return `authority kind is one of ${ORG_AUTHORITY_KINDS.join(", ")}`;
        if (!nonEmpty(g.label) || !optString(g.scope)) return "each authority grant has a label; scope is text";
        if (g.limit !== undefined) {
          if (!g.limit || typeof g.limit !== "object" || Array.isArray(g.limit)) return "authority limit is an object";
          const keys = Object.keys(g.limit);
          if (!keys.length || keys.some((k) => !["usd_per_month", "usd_per_day", "per_day"].includes(k) || typeof g.limit[k] !== "number" || !(g.limit[k] >= 0))) return "authority limit names usd_per_month, usd_per_day or per_day as non-negative numbers";
        }
        if (g.expires !== undefined && !(nonEmpty(g.expires) && EVERY_RE.test(g.expires))) return "authority expires is a duration like 90d";
      }
      return null;
    }
    case "hire": {
      const h = handle(); if (h) return h;
      if (!nonEmpty(raw.template) || !SLUG_RE.test(raw.template)) return "hire names the template by its slug";
      if (!nonEmpty(raw.version) || !VERSION_RE.test(raw.version) || !nonEmpty(raw.digest) || !DIGEST_RE.test(raw.digest)) return "hire pins a release: version like 2.0.0 and its sha256 digest";
      if (!nonEmpty(raw.instance) || !SLUG_RE.test(raw.instance)) return "hire names the instance by a slug";
      if (!nonEmpty(raw.project)) return "hire needs the project ref the role will lead";
      if (raw.config !== undefined && (!raw.config || typeof raw.config !== "object" || Array.isArray(raw.config) || Object.values(raw.config).some((x) => typeof x !== "string"))) return "hire config is the answers, key to text";
      if (raw.update_policy !== undefined && !["manual", "canary", "stable"].includes(raw.update_policy)) return "update_policy is manual, canary or stable";
      return null;
    }
    case "upgrade": {
      if (!nonEmpty(raw.instance) || !SLUG_RE.test(raw.instance) || !nonEmpty(raw.template) || !SLUG_RE.test(raw.template)) return "upgrade names the instance and its template by slug";
      return nonEmpty(raw.to) && VERSION_RE.test(raw.to) && nonEmpty(raw.digest) && DIGEST_RE.test(raw.digest) ? null : "upgrade pins the release it moves to: version and sha256 digest";
    }
    case "file":
      return nonEmpty(raw.plan) && nonEmpty(raw.project) ? null : "file needs a plan ref and a project ref";
    case "charter_edit": {
      const h = handle(); if (h) return h;
      if (!Array.isArray(raw.edits) || !raw.edits.length || raw.edits.length > ORG_CHARTER_EDITS_MAX) return `charter_edit edits is a list of one to ${ORG_CHARTER_EDITS_MAX} edits: { op: "replace", before, after }, { op: "add", line } or { op: "remove", before }`;
      for (const e of raw.edits) {
        const fault = orgCharterEditError(e); if (fault) return fault;
      }
      return null;
    }
    case "plan_status":
      if (!nonEmpty(raw.plan)) return "plan_status needs a plan ref";
      if (!(PLAN_STATUS_CHANGES as readonly string[]).includes(raw.status)) return `plan_status status is one of ${PLAN_STATUS_CHANGES.join(", ")}`;
      if (!optString(raw.title)) return "plan_status title is the plan's title, a string";
      return nonEmpty(raw.reason) ? null : "plan_status needs a reason: the evidence the record is stale";
    case "task_status":
      if (!nonEmpty(raw.task)) return "task_status needs a task ref";
      if (!(TASK_STATUS_CHANGES as readonly string[]).includes(raw.status)) return `task_status status is one of ${TASK_STATUS_CHANGES.join(", ")}`;
      if (!optString(raw.title)) return "task_status title is the task's title, a string";
      return nonEmpty(raw.reason) ? null : "task_status needs a reason: the evidence the record is stale";
    case "project_status":
      if (!nonEmpty(raw.project)) return "project_status needs a project ref";
      if (!(PROJECT_STATUS_CHANGES as readonly string[]).includes(raw.status)) return `project_status status is one of ${PROJECT_STATUS_CHANGES.join(", ")}`;
      if (!optString(raw.title)) return "project_status title is the project's title, a string";
      return nonEmpty(raw.reason) ? null : "project_status needs a reason: the evidence the record is stale";
    case "initiative":
      if (!nonEmpty(raw.title)) return "initiative needs a title: the goal's name";
      if (!nonEmpty(raw.description)) return "initiative needs a description: the sentence that says what reaching the goal looks like";
      if (!strings(raw.projects) || !raw.projects.length) return "initiative projects is a non-empty list of project refs: the projects that carry the goal";
      if (raw.owner !== undefined && !nonEmpty(raw.owner)) return "initiative owner is \"@handle\" for a role, \"me\" or a member's name for a person";
      if (raw.target_date !== undefined && !(typeof raw.target_date === "number" && raw.target_date > 0)) return "initiative target_date is unix ms";
      if (raw.parent !== undefined && !nonEmpty(raw.parent)) return "initiative parent is the top level goal it feeds: in-N, an id, or the title of a goal set earlier in this proposal";
      { const m = metricsError("initiative", raw.metrics) ?? recordError("initiative", raw); if (m) return m; }
      return optStrings(raw.evidence) ? null : "initiative evidence is a list of strings";
    case "initiative_projects":
      if (!nonEmpty(raw.initiative)) return "initiative_projects needs a goal ref (in-N, an id or its title)";
      if (!strings(raw.projects) || !raw.projects.length) return "initiative_projects projects is a non-empty list of project refs";
      return optString(raw.title) ? null : "initiative_projects title is the goal's title, a string";
    case "initiative_owner":
      if (!nonEmpty(raw.initiative)) return "initiative_owner needs a goal ref (in-N, an id or its title)";
      if (!nonEmpty(raw.owner)) return "initiative_owner owner is \"@handle\" for a role, \"me\" or a member's name for a person";
      return optString(raw.title) ? null : "initiative_owner title is the goal's title, a string";
    case "initiative_shape":
      if (!nonEmpty(raw.initiative)) return "initiative_shape needs a goal ref (in-N, an id or its title)";
      if (raw.parent !== undefined && raw.parent !== null && !nonEmpty(raw.parent)) return "initiative_shape parent is the top level goal it feeds (a ref), or null for a top level goal";
      { const m = metricsError("initiative_shape", raw.metrics) ?? recordError("initiative_shape", raw); if (m) return m; }
      if (raw.parent === undefined && raw.metrics === undefined && !carriesRecord(raw)) return "initiative_shape needs a parent, metrics, why, done_when, milestones, sources, questions or decisions: what it changes about the goal";
      return optString(raw.title) ? null : "initiative_shape title is the goal's title, a string";
  }
  return null;
}

/** One or two metrics, each { name, target }, or absent. */
function metricsError(kind: string, raw: unknown): string | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length > 2) return `${kind} metrics is a list of at most two { name, target }: the numbers the goal is measured by`;
  for (const m of raw) if (!m || typeof m !== "object" || !nonEmpty((m as any).name) || !nonEmpty((m as any).target)) return `${kind} metrics entries are { name, target }, both strings ("Weekly active teams", "1000")`;
  return null;
}

/** The record lists a change may add to as plain strings, and what each entry is. */
const RECORD_STRING_LISTS = { sources: "where the goal was stated: an address (a call, a session, a link), the words said, or both", questions: "what is still undecided", decisions: "what was decided" } as const;
/** The lists a shape change adds to, never replaces. */
const SHAPE_ADD_LISTS = ["milestones", "sources", "questions", "decisions"] as const;
/** A goal change's record (I5): why and done_when as words, milestones as
 *  { title, date? }, and the string lists, each within the row's own cap
 *  (INITIATIVE_RECORD_MAX). */
function recordError(kind: string, raw: any): string | null {
  if (raw.why !== undefined && !nonEmpty(raw.why)) return `${kind} why is a string: why the goal matters`;
  if (raw.done_when !== undefined && !nonEmpty(raw.done_when)) return `${kind} done_when is a string: what done looks like, the sentence a result is checked against`;
  if (raw.milestones !== undefined) {
    if (!Array.isArray(raw.milestones) || raw.milestones.length > INITIATIVE_RECORD_MAX.milestones) return `${kind} milestones is a list of at most ${INITIATIVE_RECORD_MAX.milestones} { title, date? }: the steps on the way`;
    for (const m of raw.milestones) if (!m || typeof m !== "object" || !nonEmpty(m.title) || (m.date !== undefined && !(typeof m.date === "number" && m.date > 0))) return `${kind} milestones entries are { title, date? }: a title, and the day it is due as unix ms`;
  }
  for (const list of ["sources", "questions", "decisions"] as const) {
    if (!optStrings(raw[list]) || (raw[list]?.length ?? 0) > INITIATIVE_RECORD_MAX[list]) return `${kind} ${list} is a list of at most ${INITIATIVE_RECORD_MAX[list]} strings: ${RECORD_STRING_LISTS[list]}`;
  }
  return null;
}
/** Does the change write anything to the goal's record? An empty list adds nothing. */
const carriesRecord = (c: any): boolean => c.why !== undefined || c.done_when !== undefined || SHAPE_ADD_LISTS.some((list) => c[list]?.length > 0);

export function isOrgChange(raw: any): raw is OrgChange { return orgChangeError(raw) === null; }

export type OrgEvidenceLink = { label: string; href?: string };

/** A change row's status (S4). `accepted` is the optimistic beat between a
 *  verdict and its apply; `failed` is a refusal the apply core returned. */
export type OrgChangeStatus = "proposed" | "accepted" | "skipped" | "applied" | "failed" | "removed";

/** The statuses a person can still decide (S4): a failed change stays open
 *  so it can be retried with edits or skipped. The server's decide, acceptAll
 *  and resolve gates and the web's action rows, counts and journal all read
 *  this one set, so "still to decide" means the same thing on both sides. */
export const ORG_DECIDABLE_STATUSES: readonly OrgChangeStatus[] = ["proposed", "failed"];
export function isOrgChangeDecidable(status: string): boolean {
  return (ORG_DECIDABLE_STATUSES as readonly string[]).includes(status);
}

// ── The conversation is part of the proposal (S18) ──────────────────────────

/** The author's thread bound to a proposal: the head of people's standing
 *  session, or the session that ran the review. The pane embeds it. */
export type OrgProposalThread = { conversation_id: string; short_id?: string };

/** What `orgProposals.revise` did to a change (S18). A removed change keeps
 *  its row with `status: "removed"`, struck through with the note; an
 *  amended one keeps its row and id, the new change replaces the old and
 *  `before` keeps what it read as; an added one is a new row. Revise is
 *  authoring, never deciding: a decided change is refused. */
export type OrgChangeRevision = {
  kind: "removed" | "amended" | "added";
  /** What the author said about it, one line. */
  note: string;
  at: number;
  before?: OrgChange;
};

/** A title inside a header line: `("Rank Union's projects")`. A double quote
 *  in it would end the header early for a reader, so it reads as a single one. */
const quotedTitle = (title: string): string => `("${title.replace(/"/g, "'")}")`;

/** A message sent from the pane opens with the change the person was looking
 *  at, so the agent answers about the right row. One line, then a blank line,
 *  then the person's words. Both sides read this one format. */
export function aboutChangeHeader(proposalShortId: string, seq: number, line: string): string {
  return `About ${proposalShortId} change ${seq} ${quotedTitle(line)}:`;
}
export function withAboutChange(content: string, proposalShortId: string, seq: number, line: string): string {
  return `${aboutChangeHeader(proposalShortId, seq, line)}\n\n${content}`;
}
/** The same header for a reply about one ask (S19). `index` is the ask's
 *  place in the resolved asks, from 0, the number `decideAsk` takes; the
 *  header counts from 1, the way a person counts the cards. */
export function aboutAskHeader(proposalShortId: string, index: number, title: string): string {
  return `About ${proposalShortId} ask ${index + 1} ${quotedTitle(title)}:`;
}
export function withAboutAsk(content: string, proposalShortId: string, index: number, title: string): string {
  return `${aboutAskHeader(proposalShortId, index, title)}\n\n${content}`;
}
/** The same header for a reply about the proposal as a whole: what a
 *  conversation's card puts in the composer on Ask (org-staffing.md S24). */
export function aboutProposalHeader(proposalShortId: string, title: string): string {
  return `About ${proposalShortId} ${quotedTitle(title)}:`;
}
export function withAboutProposal(content: string, proposalShortId: string, title: string): string {
  return `${aboutProposalHeader(proposalShortId, title)}\n\n${content}`;
}
const ABOUT_RE = /^About (op-\d+) change (\d+) \("([^\n]*)"\):\n\n?/;
/** The change a message names, and the words after the header; null when it names none. */
export function parseAboutChange(content: string): { proposal: string; seq: number; line: string; body: string } | null {
  const m = ABOUT_RE.exec(content);
  return m ? { proposal: m[1], seq: Number(m[2]), line: m[3], body: content.slice(m[0].length) } : null;
}

// ── A card answers the agent (org-staffing.md S39) ──────────────────────────

/** What a person says to the changes of one card: apply them, do not, or
 *  words about them with no verdict. */
export type OrgReplyVerdict = "approve" | "reject" | "note";
/** One answer to the changes of one card. `seqs` empty = about the whole
 *  proposal (a note only). `line` is the card's sentence. */
export type OrgReplyItem = { verdict: OrgReplyVerdict; seqs: number[]; text?: string; line: string };
/** A person's answers to one proposal, sent together. `proposal` is its short
 *  id (`op-55`). `applied` is whether every approval had landed when the
 *  words were written (absent means yes): the server's send knows, and says
 *  "Approved" alone when a continuation or a failure leaves some to read on
 *  the rows. */
export type OrgProposalReply = { proposal: string; title: string; items: OrgReplyItem[]; applied?: boolean };
/** What a change row keeps of the person's answer, so a card says it after a reload and on another device. */
export type OrgChangeReply = { verdict: OrgReplyVerdict; text?: string; at: number; by?: string };

/** The word a surface shows for a verdict: `act` on the control before the
 *  send, `done` on the card after it. */
export const ORG_REPLY_WORDS: Record<OrgReplyVerdict, { act: string; done: string }> = {
  approve: { act: "Approve", done: "Approved" },
  reject: { act: "Reject", done: "Rejected" },
  note: { act: "Reply", done: "Noted" },
};

/**
 * The words the agent reads, one block per proposal. Used by the web (a
 * conversation's send) and the server (the thread send), so both write a
 * person's answers the same way:
 *
 *   On op-55 ("Rank Union's projects by the goals they carry"):
 *   - Approved, and applied: op-55#1, op-55#3 and op-55#4.
 *   - Rejected op-55#2 (make Matching Engine & Funnel a high priority): P1 is too high, make it P2.
 *   - On op-55#6 (make Callers & Call Management a medium priority): Cameron owns this, not Samvit.
 *   - On the whole proposal: do the same for the plans next.
 *
 * Approvals with no words fold into the first line. Every answer that carries
 * words or a rejection follows in the order of its first change, whatever
 * order the person gave them in, and words about the whole proposal come
 * last. Each change is written as its reference (`op-55#3`), which the agent
 * can act on and a person's bubble draws as a pill. Empty when the reply says
 * nothing (no items, or only a note with no words). With `applied: false`
 * the approvals read "Approved: op-55#1." and the agent reads the rows for
 * what has landed.
 */
export function proposalReplyText(reply: OrgProposalReply): string {
  const applied = reply.applied !== false;
  const refs = (seqs: number[]) => andList([...new Set(seqs)].sort((a, b) => a - b).map((seq) => proposalChangeRefId(reply.proposal, seq)));
  // A card's sentence inside a line: no capital, no full stop ("make Growth a high priority").
  const named = (item: OrgReplyItem) => {
    const line = item.line.trim().replace(/\.$/, "");
    return `${refs(item.seqs)}${line ? ` (${line.charAt(0).toLowerCase()}${line.slice(1)})` : ""}`;
  };
  // A person's words stay inside their bullet: a new line is indented, a blank one is dropped.
  const wordsOf = (item: OrgReplyItem) => (item.text ?? "").trim().replace(/\s*\n\s*/g, "\n  ");
  const said = (lead: string, words: string) => (words ? `${lead}: ${words}` : `${lead}.`);

  const folded: number[] = [];
  const about: OrgReplyItem[] = [];
  const whole: string[] = [];
  for (const item of reply.items) {
    const words = wordsOf(item);
    if (!item.seqs.length) { if (words) whole.push(`On the whole proposal: ${words}`); }
    else if (item.verdict === "approve" && !words) folded.push(...item.seqs);
    else if (item.verdict !== "note" || words) about.push(item);
  }
  const lines = [
    ...(folded.length ? [`Approved${applied ? ", and applied" : ""}: ${refs(folded)}.`] : []),
    ...about.sort((a, b) => Math.min(...a.seqs) - Math.min(...b.seqs)).map((item) => {
      const words = wordsOf(item);
      if (item.verdict === "approve") return `Approved ${refs(item.seqs)}${applied ? ", and applied" : ""}: ${words}`;
      return said(item.verdict === "reject" ? `Rejected ${named(item)}` : `On ${named(item)}`, words);
    }),
    ...whole,
  ];
  if (!lines.length) return "";
  // The ref alone: it renders as the proposal's titled pill, and the agent wrote the proposal.
  return [`On ${reply.proposal}:`, ...lines.map((l) => `- ${l}`)].join("\n");
}

/** Several proposals answered in one send: one block each, a blank line between. */
export function proposalRepliesText(replies: OrgProposalReply[]): string {
  return replies.map(proposalReplyText).filter(Boolean).join("\n\n");
}

/** One change as the spec carries it, with the reader's side. */
export type OrgSpecChange = {
  change: OrgChange;
  rationale: string;
  evidence?: OrgEvidenceLink[];
  expected_effect?: string;
  risk?: string;
};

/** The faults of one spec change (the shape `changes[i]` takes). Shared by
 *  the spec parser and by revise's add, so a change added to an open
 *  proposal passes exactly the checks a change created with it passed. */
export function orgSpecChangeErrors(c: any): string[] {
  if (!c || typeof c !== "object" || Array.isArray(c)) return ["an object with change and rationale"];
  const errors: string[] = [];
  const fault = orgChangeError(c.change);
  if (fault) errors.push(fault);
  if (!nonEmpty(c.rationale)) errors.push("rationale is required");
  if (c.evidence !== undefined && !(Array.isArray(c.evidence) && c.evidence.every((e: any) => e && nonEmpty(e.label) && optString(e.href)))) errors.push("evidence is a list of { label, href? }");
  if (!optString(c.expected_effect) || !optString(c.risk)) errors.push("expected_effect and risk are strings");
  return errors;
}

/** A validated spec change with only the keys the row stores. */
export function normalizeOrgSpecChange(c: any): OrgSpecChange {
  return { change: c.change, rationale: c.rationale, ...(c.evidence ? { evidence: c.evidence } : {}), ...(c.expected_effect ? { expected_effect: c.expected_effect } : {}), ...(c.risk ? { risk: c.risk } : {}) };
}

/**
 * One revise op (org-staffing.md S18): the author of an open proposal removes
 * a change, amends one, or adds one. `seq` names the change as the page and
 * the CLI do ("#3"); an amend's `edits` is the same object patch a person's
 * "accept with edits" takes, laid over the change with editedOrgChange and
 * checked with orgChangeError, and may also rewrite the rationale. An add is
 * a whole spec change. `note` is the author's own words for the row ("growth
 * is dead, dropping it"); the page shows it beside the change. Only an
 * undecided change can be removed or amended.
 */
export type OrgReviseOp =
  | { op: "remove"; seq: number; note?: string }
  | { op: "amend"; seq: number; edits?: Record<string, unknown>; rationale?: string; note?: string }
  | { op: "add"; change: OrgSpecChange; note?: string };
export const ORG_REVISE_OPS = ["remove", "amend", "add"] as const;

/** The shape faults of one op; the server checks the proposal's own state
 *  (open, undecided, no duplicate subject) on top of this. */
export function orgReviseOpError(raw: any): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "an op is an object: { op: \"remove\" | \"amend\", seq } or { op: \"add\", change }";
  if (!(ORG_REVISE_OPS as readonly string[]).includes(raw.op)) return `op is one of ${ORG_REVISE_OPS.join(", ")}`;
  if (raw.note !== undefined && !nonEmpty(raw.note)) return `${raw.op}: note is a non-empty string`;
  if (raw.op === "add") {
    const faults = orgSpecChangeErrors(raw.change);
    return faults.length ? `add: ${faults.join("; ")}` : null;
  }
  if (!Number.isInteger(raw.seq) || raw.seq < 1) return `${raw.op}: seq is the change's number (1, 2, …)`;
  if (raw.op === "amend") {
    const hasEdits = raw.edits !== undefined && raw.edits !== null;
    if (hasEdits && (typeof raw.edits !== "object" || Array.isArray(raw.edits))) return "amend: edits is an object patch over the change's own keys";
    if (raw.rationale !== undefined && !nonEmpty(raw.rationale)) return "amend: rationale is a non-empty string";
    if (!hasEdits && raw.rationale === undefined) return "amend: give edits, a rationale, or both";
  }
  return null;
}

/**
 * One line of a proposal's revision journal: what a revise did to which
 * change, when and by whom (the proposal's author shape). `line` is the
 * change as it reads after the op (for a remove, as it read), `was` the line
 * an amend replaced. The org page lists these inline beside the changes so a
 * reader sees the conversation's effect on the list.
 */
export type OrgRevision = {
  op: "removed" | "amended" | "added";
  seq: number;
  at: number;
  by: { kind: "role" | "session" | "user"; id: string };
  line: string;
  was?: string;
  note?: string;
};

export type OrgProposalMode = "init" | "review" | "request";
export const ORG_PROPOSAL_MODES: readonly OrgProposalMode[] = ["init", "review", "request"];

/** The file `cast org propose --spec` reads and `orgProposals.create` stores. */
/** One thing the proposal asks of the person (org-staffing.md S19): a title
 *  they can read cold, one sentence of why, one line of what accepting
 *  changes, and the changes folded inside it, by seq. The asks of a proposal
 *  partition its changes: every change is in exactly one. */
export type OrgAsk = { title: string; why: string; effect: string; seqs: number[] };

export type OrgProposalSpec = {
  title: string;
  summary_md: string;
  mode: OrgProposalMode;
  changes: OrgSpecChange[];
  /** Written by the author at propose time; a spec without them derives them (deriveAsks). */
  asks?: OrgAsk[];
};

/** The faults of a spec's asks against its changes as written (seq 1 is the
 *  first change). The partition is the contract: a change in no ask would
 *  never reach the person, and a change in two would be decided twice. */
export function orgAsksErrors(asks: unknown, changes: ReadonlyArray<{ change: OrgChange }>): string[] {
  if (!Array.isArray(asks) || !asks.length) return ["asks is a non-empty list of { title, why, effect, seqs }"];
  const errors: string[] = [];
  const owner = new Map<number, number[]>();
  // A seqs list that does not read says nothing about the partition, so the
  // partition is reported only once every list reads.
  let malformed = false;
  asks.forEach((a: any, i: number) => {
    if (!a || typeof a !== "object" || !nonEmpty(a.title) || !nonEmpty(a.why) || !nonEmpty(a.effect)) errors.push(`asks[${i}]: title, why and effect are required`);
    if (!Array.isArray(a?.seqs) || !a.seqs.length || !a.seqs.every((n: unknown) => Number.isInteger(n) && (n as number) >= 1)) { errors.push(`asks[${i}]: seqs is a non-empty list of change numbers (1 is the first change)`); malformed = true; return; }
    for (const n of new Set<number>(a.seqs)) {
      if (n > changes.length) errors.push(`asks[${i}] names change ${n}, and the spec has ${changes.length}`);
      else owner.set(n, [...(owner.get(n) ?? []), i]);
    }
  });
  const partition: string[] = [];
  if (!malformed) changes.forEach((c, i) => {
    const in_ = owner.get(i + 1) ?? [];
    if (in_.length === 1) return;
    partition.push(`changes[${i}] (${describeOrgChange(c.change)}) is in ${in_.length ? in_.map((a) => `asks[${a}]`).join(" and ") : "no ask"}: every change belongs to exactly one ask`);
  });
  const SHOWN = 10;
  errors.push(...partition.slice(0, SHOWN), ...(partition.length > SHOWN ? [`and ${partition.length - SHOWN} more changes outside the partition`] : []));
  return errors;
}

/** Every role handle a change refers to, lower case and without the @: its
 *  own subject, the parent a role or a move names, a charter's owner. "me"
 *  and a person's name are not roles. */
export function orgChangeHandles(c: OrgChange): string[] {
  const h = (x: unknown) => (typeof x === "string" && x.trim().startsWith("@") ? x.trim().slice(1).toLowerCase() : null);
  const any = c as any;
  const own = typeof any.handle === "string" ? any.handle.trim().replace(/^@/, "").toLowerCase() : null;
  return [own, h(any.reports_to), c.kind === "project_meta" || c.kind === "initiative" || c.kind === "initiative_owner" ? h(any.owner) : null].filter((x): x is string => !!x);
}

type AskRow = { seq: number; change: OrgChange; status?: string; rationale?: string; expected_effect?: string };
const askHandle = (c: OrgChange): string | null => ("handle" in c && typeof c.handle === "string" ? c.handle.trim().replace(/^@/, "").toLowerCase() : null);

/** "a, b and c" */
export const andList = (xs: string[]) => xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
/** Several clauses about one subject: the first names it and the rest say
 *  "it" ("move X under P", "give it two measures"). */
const clausesAbout = (subject: string, clauses: ReadonlyArray<(s: string) => string>): string[] => clauses.map((clause, i) => clause(i ? "it" : subject));
const isClause = (x: unknown): x is (s: string) => string => typeof x === "function";
const number =(n: number) => n.toLocaleString("en-US");
/** The three limits in words, in one order: "2 hands, 8 wakes and 800,000 tokens". */
export function capsWords(caps: { hands_per_day?: number; wakes_per_day?: number; tokens_per_day?: number }): string {
  const parts: string[] = [];
  if (caps.hands_per_day !== undefined) parts.push(`${number(caps.hands_per_day)} ${caps.hands_per_day === 1 ? "hand" : "hands"}`);
  if (caps.wakes_per_day !== undefined) parts.push(`${number(caps.wakes_per_day)} ${caps.wakes_per_day === 1 ? "wake" : "wakes"}`);
  if (caps.tokens_per_day !== undefined) parts.push(`${number(caps.tokens_per_day)} tokens`);
  return andList(parts);
}
/** "1d" reads as every day, "7d" as every week, "12h" as every 12 hours. */
export function everyWords(every: string): string {
  const m = every.trim().match(/^(\d+)\s*([dhwm])$/i);
  if (!m) return `every ${every}`;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === "d" && n === 1) return "every day";
  if (unit === "d" && n === 7) return "every week";
  if (unit === "w" && n === 1) return "every week";
  const word = { d: "day", h: "hour", w: "week", m: "minute" }[unit as "d" | "h" | "w" | "m"];
  return n === 1 ? `every ${word}` : `every ${n} ${word}s`;
}

/** The names a derived ask speaks in (S19): an agent by its handle, a
 *  project or a plan by the id or title a change carries, a session by its
 *  short id. Each answers undefined for a ref it does not know, and the ref
 *  itself stands. The server derives asks with no names at all; the page
 *  passes the tree's. */
export type OrgAskNames = {
  role?: (handle: string) => string | undefined;
  project?: (ref: string) => string | undefined;
  plan?: (ref: string) => string | undefined;
  initiative?: (ref: string) => string | undefined;
  /** A session's title, for a change that seats one (a role's seat, an adopt). */
  session?: (ref: string) => string | undefined;
};

/** The one line a goal change reads as (I1, revised), for a person who has
 *  not read the letter: "set a goal: Win the private network, carried by
 *  Callers and Broker network, owned by @calling". The row, the derived ask,
 *  the log and the CLI walk all say it this way; names resolve through the
 *  same table the asks use, and a ref the reader's store does not know stands
 *  as written. An owner of "me" reads as "you": the card has no speaker.
 *  `words` is the card's way of saying it (ChangeWords): `brief` gives the
 *  verb first sentence whose only name for the goal is its title ("add the
 *  goal X under P", "have Callers carry X"), and `subject` stands in for the
 *  goal ("it"). */
export function goalChangeSentence(c: OrgGoalChange, names?: OrgAskNames, words?: Pick<ChangeWords, "subject" | "brief" | "purpose">): string {
  return andList(goalChangeClauses(c, names, words));
}
function goalChangeClauses(c: OrgGoalChange, names?: OrgAskNames, words: Pick<ChangeWords, "subject" | "brief" | "purpose"> = {}): string[] {
  const { brief } = words;
  // A handle stands as written for a reader with no card in front of them; the card names the role.
  const owner = (ref: string | undefined) => !ref ? "" : ref.trim().toLowerCase() === "me" ? "you" : ref.trim().startsWith("@") ? (brief && names?.role?.(ref.trim().slice(1).toLowerCase())) || `@${ref.trim().slice(1)}` : names?.role?.(ref.trim().toLowerCase()) ?? ref.trim();
  const project = (ref: string) => names?.project?.(ref) ?? ref;
  const goal = (ref: string, title?: string) => title?.trim() || names?.initiative?.(ref) || ref;
  /** The goal as the sentence calls it: the caller's word, else its title (after "the goal" where the reader has no card). */
  const subject = (name: string) => words.subject ?? (brief ? name : `the goal ${name}`);
  switch (c.kind) {
    case "initiative":
      if (brief) return [words.purpose ? `set ${words.subject ?? c.title.trim()} as the purpose` : `add ${words.subject ?? `the goal ${c.title.trim()}`} ${c.parent ? `under ${goal(c.parent)}` : "at the top level"}`];
      return [`set a goal: ${words.subject ?? c.title.trim()}, carried by ${andList(c.projects.map(project))}${c.owner ? `, owned by ${owner(c.owner)}` : ""}${c.parent ? `, under ${goal(c.parent)}` : ""}${c.metrics?.length ? `, measured by ${metricsWords(c.metrics)}` : ""}${c.milestones?.length ? `, with ${count(c.milestones.length, "milestone")}` : ""}`];
    case "initiative_projects": {
      const s = subject(goal(c.initiative, c.title)), carriers = andList(c.projects.map(project));
      return [brief ? `have ${carriers} carry ${s}` : `add ${carriers} to ${s}`];
    }
    case "initiative_owner": {
      const s = subject(goal(c.initiative, c.title));
      if (brief) return [c.owner.trim() ? `make ${owner(c.owner).replace(/^you$/, "yourself")} ${s === "it" ? "its owner" : `the owner of ${s}`}` : `leave ${s} with no owner`];
      return [c.owner.trim() ? `make ${owner(c.owner)} the owner of ${s}` : `${s} has no owner`];
    }
    case "initiative_shape": {
      const s = subject(goal(c.initiative, c.title));
      // The record reads as what is written down, never as the words themselves: those are the effect's.
      const record = recordWords(c);
      if (brief) {
        const { parent, metrics } = c;
        const clauses = [
          parent !== undefined && ((g: string) => parent === null ? `move ${g} to the top level` : `move ${g} under ${goal(parent)}`),
          metrics !== undefined && ((g: string) => metrics.length === 0 ? `stop measuring ${g} by a number` : metrics.length === 1 ? `measure ${g} by ${metrics[0].name.trim()}` : `give ${g} ${metrics.length === 2 ? "two" : metrics.length} measures`),
          record.length > 0 && ((g: string) => `record ${andList(record)} on ${g}`),
        ].filter(isClause);
        return clauses.length ? clausesAbout(s, clauses) : [`change ${s}`];
      }
      const parts = [
        c.parent === undefined ? "" : c.parent === null ? "a top level goal" : `under ${goal(c.parent)}`,
        c.metrics === undefined ? "" : c.metrics.length ? `measured by ${metricsWords(c.metrics)}` : "with no metric",
      ].filter(Boolean);
      const placed = parts.length ? `${c.parent === null && parts.length === 1 ? "make" : "put"} ${s} ${andList(parts)}` : "";
      if (!record.length) return [placed || `change ${s}`];
      return [placed ? `${placed}, and record ${andList(record)}` : `record on ${s}: ${andList(record)}`];
    }
  }
}
const count = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
/** The words as a sentence: a full stop where the writer left none. */
const fullStop = (text: string) => { const t = text.trim(); return /[.!?]$/.test(t) ? t : `${t}.`; };
/** What a shape change writes to the goal's record, each part named and counted: "why it matters", "the milestone Private beta open", "2 open questions". */
function recordWords(c: OrgInitiativeShapeChange): string[] {
  const some = (k: number | undefined, one: string, many: string) => !k ? "" : k === 1 ? one : `${k} ${many}`;
  return [
    c.why !== undefined ? "why it matters" : "",
    c.done_when !== undefined ? "what done looks like" : "",
    some(c.milestones?.length, `the milestone ${c.milestones?.[0]?.title.trim()}`, "milestones"),
    some(c.questions?.length, "an open question", "open questions"),
    some(c.decisions?.length, "a decision", "decisions"),
    some(c.sources?.length, "where it was stated", "places it was stated"),
  ].filter(Boolean);
}
/** The record a goal change carries, as the sentences an effect reads: the words themselves, each under its own name. */
function recordEffect(c: OrgInitiativeRecord): string {
  const stop = fullStop;
  return [
    c.why?.trim() ? `Why it matters: ${stop(c.why)}` : "",
    c.done_when?.trim() ? `Done when: ${stop(c.done_when)}` : "",
    c.milestones?.length ? `${c.milestones.length === 1 ? "Milestone" : "Milestones"}: ${c.milestones.map((m) => `${m.title.trim()}${m.date ? ` (${humanEndDate(m.date)})` : ""}`).join("; ")}.` : "",
    c.questions?.length ? `Still open: ${c.questions.map((q) => stop(q)).join(" ")}` : "",
    c.decisions?.length ? `Decided: ${c.decisions.map((d) => stop(d)).join(" ")}` : "",
    c.sources?.length ? `Its record says where it was stated (${count(c.sources.length, "source")}).` : "",
  ].filter(Boolean).join(" ");
}
/** "Weekly active teams (target 1,000) and Paying teams (target 40)" */
export const metricsWords = (metrics: ReadonlyArray<OrgInitiativeMetric>): string => andList(metrics.map((m) => `${m.name.trim()} (target ${m.target.trim()})`));

/**
 * A derived ask's words, for a person reading cold: no handle, no
 * parenthetical, a sentence for what accepting changes. The row's own line
 * (describeOrgChange) is for the fold, where the row is the subject; up
 * here the subject is the agent and what happens to it.
 */
function askWords(names?: OrgAskNames) {
  const handle = (h: string) => h.trim().replace(/^@/, "");
  const agent = (h: string) => names?.role?.(handle(h).toLowerCase()) ?? handle(h);
  // "you": the card has no speaker, so the deciding person is the reader, the way the row line says it.
  const parent = (ref: string | undefined) => !ref || ref === "me" ? "you" : ref.startsWith("@") ? agent(ref) : names?.role?.(ref) ?? ref;
  const projects = (refs: string[]) => refs.length ? `the ${andList(refs.map((r) => names?.project?.(r) ?? r))} ${refs.length === 1 ? "project" : "projects"}` : "";
  const plans = (refs: string[]) => refs.length ? `the ${andList(refs.map((r) => names?.plan?.(r) ?? r))} ${refs.length === 1 ? "plan" : "plans"}` : "";
  /** A scope a change names without saying which kind each ref is. */
  const things = (refs: string[]) => andList(refs.map((r) => {
    const project = names?.project?.(r), plan = names?.plan?.(r);
    return project ? `the ${project} project` : plan ? `the ${plan} plan` : r;
  }));
  const tenure = (t: OrgRoleProposal["tenure"]): string => {
    if (!t) return "";
    if (t.kind === "standing") return " It stays until you retire it.";
    const e: any = t.ends;
    const ends = e.plan !== undefined ? `with ${plans([String(e.plan)])}` : e.project !== undefined ? `with ${projects([String(e.project)])}` : `on ${humanEndDate(e.date)}`;
    return ` It ends ${ends}, then ${t.then === "retire" ? "retires" : "comes up for review"}.`;
  };
  /** What rides with a new agent: its limit, its routine, the session that becomes it. */
  const rider = (c: OrgChange): string => {
    switch (c.kind) {
      // A limit is a safety net the person does not read about (S23.2, ORG_QUIET_KINDS).
      case "budget": return "";
      case "routine": return ` It runs ${c.title} ${everyWords(c.every)}.`;
      case "trust": return autonomyOn(c.trust) ? " It starts work in its area on its own." : " It reads and recommends; you start the work.";
      case "adopt": return ` The session ${c.conversation} becomes it.`;
      case "authority": return ` Outside codecast it may ${authorityWords(c.authority)}, inside the limits you set.`;
      case "hire": return ` It is hired from the template ${c.template} ${c.version}, and leads ${c.project}.`;
      case "move": return c.reports_to ? ` A separate change puts it under ${parent(c.reports_to)}; skip that and it keeps reporting to whoever runs it today.` : "";
      default: return "";
    }
  };
  const title = (c: OrgChange): string => {
    switch (c.kind) {
      case "role": return c.seat ? `Name ${c.name} as a role` : `Add an agent: ${c.name}`;
      case "retire": return `Retire ${agent(c.handle)}`;
      case "move": return `Move ${agent(c.handle)}`;
      case "scope": return `Change what ${agent(c.handle)} looks after`;
      case "charter_edit": return `Change what ${agent(c.handle)}'s charter says`;
      case "trust": return `${autonomyOn(c.trust) ? "Turn on" : "Turn off"} starting work on its own for ${agent(c.handle)}`;
      case "initiative": case "initiative_projects": case "initiative_owner": case "initiative_shape": { const s = goalChangeSentence(c, names); return s.charAt(0).toUpperCase() + s.slice(1); }
      default: return describeOrgChange(c);
    }
  };
  const effect = (c: OrgChange, riders: ReadonlyArray<OrgChange> = []): string => {
    switch (c.kind) {
      case "role": {
        const scope = [projects(c.scope?.projects ?? []), plans(c.scope?.plans ?? [])].filter(Boolean).join(" and ");
        const runsLine = c.line || c.caps?.cards !== undefined ? ` It runs the project's line on the ${c.line ?? DEFAULT_LINE_SLUG} workflow${c.caps?.cards !== undefined ? `, starting new work only while fewer than ${c.caps.cards} change cards wait on a person` : ""}.` : "";
        const line = `reporting to ${parent(c.reports_to)}${scope ? ` and looking after ${scope}` : ""}.${runsLine}${tenure(c.tenure)}${riders.map(rider).join("")}`;
        return c.seat ? `${seatSentence(c.seat)} It becomes a role, ${line}` : `A new agent, ${c.name}, ${line}`;
      }
      case "retire": return `${agent(c.handle)} retires. Its sessions go back to their owners, and anything under it reports one level up.`;
      case "move": {
        const parts = [c.reports_to ? `reports to ${parent(c.reports_to)} from now on` : "", c.scope_add?.length ? `takes on ${things(c.scope_add)}` : "", c.scope_remove?.length ? `hands off ${things(c.scope_remove)}` : ""].filter(Boolean);
        return `${agent(c.handle)} ${andList(parts)}.`;
      }
      case "scope": {
        const parts = [c.add?.length ? `takes on ${things(c.add)}` : "", c.remove?.length ? `hands off ${things(c.remove)}` : ""].filter(Boolean);
        return `${agent(c.handle)} ${andList(parts)}.`;
      }
      case "charter_edit": return `${agent(c.handle)}'s charter changes in ${c.edits.length === 1 ? "one place" : `${c.edits.length} places`}; each passage is shown before and after. Its area and its reporting line stay as they are.`;
      case "initiative": return `A new goal, ${c.title.trim()}, appears on the goals page with ${projects(c.projects)} under it${c.owner ? ` and ${parent(c.owner)} as its owner` : " and no owner yet"}${c.parent ? `, feeding ${names?.initiative?.(c.parent) ?? c.parent}` : ""}${c.metrics?.length ? `. It is read against ${metricsWords(c.metrics)}` : ""}. ${recordEffect(c) ? `${fullStop(c.description)} ${recordEffect(c)}` : c.description.trim()}`;
      case "initiative_projects": return `${projects(c.projects)} ${c.projects.length === 1 ? "counts" : "count"} toward the goal from now on, and its owner's area grows to include ${c.projects.length === 1 ? "it" : "them"}.`;
      case "initiative_owner": return `${parent(c.owner)} drives the goal from now on: its health is what ${c.owner.trim().toLowerCase() === "me" ? "you say" : "they say"}, and the goal's projects join their area.`;
      case "initiative_shape": return `${c.parent !== undefined ? (c.parent ? `The goal feeds ${names?.initiative?.(c.parent) ?? c.parent} from now on, and every role under it sees that chain. ` : "The goal stands on its own at the top level. ") : ""}${c.metrics !== undefined ? (c.metrics.length ? `On track means against ${metricsWords(c.metrics)}; its owner reports the numbers. ` : "It is no longer read against a number. ") : ""}${recordEffect(c)}`.trim();
      default: return describeOrgChange(c);
    }
  };
  /** Why, when the author gave no rationale: the reason the change itself
   *  carries, else an honest blank that points at the control. A role's
   *  charter is its job, not the reason to create it, so it never stands in. */
  const why = (c: OrgChange): string => {
    if (c.kind === "retire" && c.reason?.trim()) return c.reason.trim();
    return "The author did not say why. Ask about this.";
  };
  return { title, effect, why };
}

/**
 * The asks of a proposal that carries none (S19): one written before asks
 * existed, or one a person posted. The record changes are one ask; the goal
 * changes are one ask (I1, revised); each role, retire, move and scope
 * change is its own, and a change on the handle of a role this proposal
 * creates (its adopt, its routine, its budget) rides with that role, because
 * accepting a seat without them leaves it half made; whatever is left is one
 * ask. Removed changes belong to no ask.
 */
export function deriveAsks(changes: ReadonlyArray<AskRow>, names?: OrgAskNames): OrgAsk[] {
  const words = askWords(names);
  const live = orderOrgChanges(changes.filter((c) => c.status !== "removed"), (c) => c.change);
  const records = live.filter((c) => ORG_SYNC_KINDS.includes(c.change.kind));
  const goals = live.filter((c) => isOrgGoalChange(c.change));
  const created = new Map<string, AskRow>(live.filter((c) => c.change.kind === "role").map((c) => [askHandle(c.change)!, c]));
  // A move of a role this proposal creates rides in that role's ask (a named
  // session put under an existing role, R2), so the person can accept the
  // name and skip the move from one card; any other move is its own ask.
  const own = live.filter((c) => c.change.kind === "role" || c.change.kind === "retire" || c.change.kind === "scope" || c.change.kind === "charter_edit" || (c.change.kind === "move" && !created.has(askHandle(c.change) ?? "")));
  const riders = new Map<AskRow, AskRow[]>();
  const rest: AskRow[] = [];
  for (const c of live) {
    if (records.includes(c) || goals.includes(c) || own.includes(c)) continue;
    const role = created.get(askHandle(c.change) ?? "");
    if (role) riders.set(role, [...(riders.get(role) ?? []), c]);
    else rest.push(c);
  }
  const seqs = (rows: AskRow[]) => rows.map((c) => c.seq).sort((a, b) => a - b);
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const out: OrgAsk[] = [];
  // One ask per group (a project, a plan, the plans settled on their own, or
  // the records filed under none): the person settles a project's records
  // together, and a group's line is its totals, never the list. A group of
  // one reads as that change.
  for (const g of orgRecordGroups(records, names)) {
    const one = g.seqs.length === 1 ? records.find((c) => c.seq === g.seqs[0])! : null;
    const where = g.kind === "project" ? `in ${g.title ?? g.ref}` : g.kind === "plan" ? `under the plan ${g.title ?? g.ref}` : "filed under no project";
    const plans = g.kind === "plans" ? `${g.totals.every((t) => t.act === "done" || t.act === "abandoned") ? "Close" : "Settle"} ${g.seqs.length} plans` : null;
    out.push({
      title: one ? changeLine(one.change, { names, brief: true }) : plans ?? `Settle ${n(g.seqs.length, "record", "records")} ${where}`,
      why: one ? one.rationale?.trim() || (one.change as OrgRecordStatusChange).reason.trim() : "These plans, tasks and projects show as active, but the work on them is finished, was dropped, or never started.",
      effect: `${recordGroupTotalsLine(g)}. No work starts or stops.`,
      seqs: g.seqs,
    });
  }
  // The goals ask: one goal change reads as its own sentence; several read as
  // a count, with each sentence inside the fold. The author's own why and
  // effect stand when a lone change carries them.
  if (goals.length) {
    const one = goals.length === 1 ? goals[0] : null;
    const sets = goals.filter((c) => c.change.kind === "initiative").length;
    out.push({
      title: one ? words.title(one.change) : `${n(sets, "goal", "goals")} to set${goals.length > sets ? `, and ${n(goals.length - sets, "change", "changes")} to the goals that exist` : ""}`,
      why: one?.rationale?.trim() || "The projects' own goals, and what the company said in its calls and threads, point at these goals; the goals page does not hold them yet.",
      effect: one?.expected_effect?.trim() || (one ? words.effect(one.change) : `${n(goals.length, "change", "changes")} on the goals page: a goal set, a project added to one, or an owner named. No work starts or stops.`),
      seqs: seqs(goals),
    });
  }
  for (const c of own) {
    const rode = riders.get(c) ?? [];
    out.push({ title: words.title(c.change), why: c.rationale?.trim() || words.why(c.change), effect: c.expected_effect?.trim() || words.effect(c.change, rode.map((r) => r.change)), seqs: seqs([c, ...rode]) });
  }
  // The words count the rows a person will see: a quiet kind (a limit,
  // S23.2) rides in the ask but is never a row; an ask of quiet changes
  // alone reads as sentences, one per change, so it counts them all.
  const restShown = rest.filter((c) => !isOrgQuietChange(c.change)).length || rest.length;
  if (rest.length) out.push({
    title: `${n(restShown, "smaller change", "smaller changes")}: filing, goals and settings`,
    why: "Plans filed under the area they belong to, written goals for an area, and settings of agents that already exist.",
    effect: `${n(restShown, "change", "changes")}, each listed inside. No agent is added or removed.`,
    seqs: seqs(rest),
  });
  return out;
}

/** The asks a page renders: the stored ones, less the changes a revise
 *  removed, plus derived asks for any change no stored ask names (a revise
 *  added it). With nothing stored, all of them derive. Always a partition of
 *  the live changes. */
export function resolveOrgAsks(stored: ReadonlyArray<OrgAsk> | undefined | null, changes: ReadonlyArray<AskRow>, names?: OrgAskNames): OrgAsk[] {
  const live = changes.filter((c) => c.status !== "removed");
  if (!stored?.length) return deriveAsks(live, names);
  const liveSeqs = new Set(live.map((c) => c.seq));
  const asks = stored.map((a) => ({ ...a, seqs: a.seqs.filter((q) => liveSeqs.has(q)) })).filter((a) => a.seqs.length);
  const covered = new Set(asks.flatMap((a) => a.seqs));
  return [...asks, ...deriveAsks(live.filter((c) => !covered.has(c.seq)), names)];
}

/** The latest revise on a proposal's changes, or 0. Every revise stamps the
 *  rows it touches and no row is ever deleted, so this names the proposal's
 *  last revise from the rows alone: the page reads it off the rows it
 *  painted, the server off the rows it holds. */
export function latestOrgRevisionAt(changes: ReadonlyArray<{ revision?: { at: number } | null }>): number {
  let at = 0;
  for (const c of changes) if (c.revision && c.revision.at > at) at = c.revision.at;
  return at;
}

/** What the page showed when the person pressed a verdict (S18, S19): the
 *  latest revise among the rows it painted and, for an ask, the seqs the card
 *  held. An ask is named by position, and a revise moves positions and
 *  rewrites content, so a verdict says what it was read against. */
export type OrgVerdictSeen = { revised_at: number; seqs?: number[] };

/** Why a verdict does not stand against the proposal as it is now, or null.
 *  `askSeqs` is what the ask at the sent position holds today. A caller that
 *  sends nothing is taken only on a proposal nobody revised: nothing can have
 *  moved under it. */
export function orgVerdictSeenFault(shortId: string, seen: OrgVerdictSeen | undefined | null, changes: ReadonlyArray<{ revision?: { at: number } | null }>, askSeqs?: ReadonlyArray<number>): string | null {
  const latest = latestOrgRevisionAt(changes);
  const key = (seqs: ReadonlyArray<number>) => [...seqs].sort((a, b) => a - b).join(",");
  const moved = seen
    ? seen.revised_at !== latest || (!!askSeqs && key(seen.seqs ?? []) !== key(askSeqs))
    : latest > 0;
  return moved ? `${shortId} ${ORG_VERDICT_REVISED}` : null;
}
/** The tail of that refusal, in revise's own words for the other direction
 *  ("a revise never touches a change a person decided"). The page reads it to
 *  show the revised list instead of a failure. */
export const ORG_VERDICT_REVISED = "was revised after this page read it; a verdict never lands on a change the person has not seen";

/** Validate a spec. Every fault is reported, each naming the change by index
 *  and kind, so a long spec is fixed in one pass. */
/** What a change acts on, so a proposal cannot carry the same act twice
 *  ("mark task ct-1 open" posted as two rows reads as two decisions and
 *  inflates every count). Null for kinds that may repeat by design. */
export function orgChangeKey(c: OrgChange): string | null {
  const h = (x: string) => x.trim().replace(/^@/, "").toLowerCase();
  switch (c.kind) {
    case "task_status": return `task_status:${c.task.trim()}`;
    case "plan_status": return `plan_status:${c.plan.trim()}`;
    case "project_status": return `project_status:${c.project.trim().toLowerCase()}`;
    case "file": return `file:${c.plan.trim()}`;
    case "project_meta": return `project_meta:${c.project.trim().toLowerCase()}`;
    case "charter_edit": return `charter_edit:${h(c.handle)}`;
    case "role": return `role:${h(c.handle)}`;
    case "adopt": return `adopt:${h(c.handle)}`;
    case "retire": return `retire:${h(c.handle)}`;
    case "budget": return `budget:${h(c.handle)}`;
    case "trust": return `trust:${h(c.handle)}`;
    case "authority": return `authority:${h(c.handle)}`;
    case "hire": return `hire:${c.instance.trim().toLowerCase()}`;
    case "upgrade": return `upgrade:${c.instance.trim().toLowerCase()}`;
    case "initiative": return `initiative:${c.title.trim().toLowerCase()}`;
    case "initiative_projects": return `initiative_projects:${c.initiative.trim().toLowerCase()}`;
    case "initiative_owner": return `initiative_owner:${c.initiative.trim().toLowerCase()}`;
    case "initiative_shape": return `initiative_shape:${c.initiative.trim().toLowerCase()}`;
    default: return null;
  }
}

/** What each change of a proposal needs from, or gives to, another change
 *  in it, by seq: a role created in the same proposal as its adopt is created
 *  WITHOUT a standing session and seated by the adopt; a routine on that
 *  handle runs on the session the adopt seats. The apply order (apply rank)
 *  honours this, and the page and the CLI print it so a person deciding row
 *  by row sees that skipping the adopt leaves the seat to be provisioned
 *  (the skip does that itself and says so). */
export function orgChangeDependencies(rows: ReadonlyArray<{ seq: number; change: OrgChange }>): Record<number, string> {
  const h = (x: string) => x.trim().replace(/^@/, "").toLowerCase();
  const out: Record<number, string> = {};
  const adopts = new Map<string, number>();
  const roles = new Map<string, number>();
  const seated = new Map<string, number>();
  for (const r of rows) {
    if (r.change.kind === "adopt") adopts.set(h(r.change.handle), r.seq);
    if (r.change.kind === "role") { roles.set(h(r.change.handle), r.seq); if (r.change.seat) seated.set(h(r.change.handle), r.seq); }
  }
  for (const r of rows) {
    const c = r.change;
    if (c.kind === "role") { const a = adopts.get(h(c.handle)); if (a !== undefined) out[r.seq] = `created without a standing session; #${a} seats it`; }
    else if (c.kind === "adopt") { const ro = roles.get(h(c.handle)); if (ro !== undefined) out[r.seq] = `seats the role #${ro} creates; skip it and that role is provisioned a fresh session instead`; }
    else if (c.kind === "routine") { const a = adopts.get(h(c.handle)) ?? seated.get(h(c.handle)); if (a !== undefined) out[r.seq] = `runs on the session #${a} seats`; }
    else if (c.kind === "authority") { const ro = roles.get(h(c.handle)); if (ro !== undefined) out[r.seq] = `authority for the role #${ro} creates; skip that role and this is refused`; }
    else if (c.kind === "hire") { const ro = roles.get(h(c.handle)); if (ro !== undefined) out[r.seq] = `hires the role #${ro} creates from a template; skip that role and this is refused`; }
  }
  return out;
}

/** The faults of a spec's seats (R2): a session is named by one role, and a
 *  role that names its session carries no adopt, because two changes would
 *  then seat one role and a person could accept one and skip the other. */
export function orgSeatErrors(changes: ReadonlyArray<{ change: OrgChange }>): string[] {
  const h = (x: string) => x.trim().replace(/^@/, "").toLowerCase();
  const errors: string[] = [];
  const named = new Map<string, number>();
  const seatedAt = new Map<string, number>();
  changes.forEach((row, i) => {
    const c = row.change;
    if (c.kind !== "role" || !c.seat) return;
    const session = c.seat.existing.trim();
    const first = named.get(session);
    if (first !== undefined) errors.push(`changes[${i}] (${describeOrgChange(c)}) names session ${session}, which changes[${first}] already names: one session is one role`);
    else named.set(session, i);
    seatedAt.set(h(c.handle), i);
  });
  changes.forEach((row, i) => {
    const c = row.change;
    const role = c.kind === "adopt" ? seatedAt.get(h(c.handle)) : undefined;
    if (role !== undefined) errors.push(`changes[${i}] (${describeOrgChange(c)}) repeats the seat changes[${role}] already carries: a role that names its session needs no adopt`);
  });
  return errors;
}

/** Two rows about one subject that agree fold into one: the fields union,
 *  the prose (rationale, reason, effect, risk) joins when it differs, the
 *  evidence concatenates. Rows that disagree on a field are refused, naming
 *  it, because one row cannot carry both. The analyzer builds a spec from
 *  lists, and a project that sits in its charter list and its owner list is
 *  the ordinary way two rows meet; folding here means the post never refuses
 *  what one row could have carried, and the note says what was folded. */
export function foldRepeatedSubjects(rows: any[]): { changes: any[]; notes: string[]; errors: string[]; index: number[] } {
  const out: any[] = []; const notes: string[] = []; const errors: string[] = [];
  /** Where each row as written ended up: its own place, or the row it folded into. */
  const index: number[] = [];
  const at = new Map<string, { out: number; src: number }>();
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const prose = (a?: string, b?: string) => !a ? b : !b || a.trim() === b.trim() ? a : `${a}\n\n${b}`;
  rows.forEach((row, i) => {
    const key = orgChangeKey(row.change);
    const hit = key ? at.get(key) : undefined;
    if (!hit) { if (key) at.set(key, { out: out.length, src: i }); index[i] = out.length; out.push(row); return; }
    index[i] = hit.out;
    const first = out[hit.out];
    // A shape change's record lists add to the goal, so two rows' lists join rather than disagree.
    const joins = (k: string) => row.change.kind === "initiative_shape" && (SHAPE_ADD_LISTS as readonly string[]).includes(k);
    const joined = Object.fromEntries(SHAPE_ADD_LISTS.filter((k) => joins(k) && first.change[k] && row.change[k]).map((k) => [k, [...first.change[k], ...row.change[k].filter((e: unknown) => !first.change[k].some((f: unknown) => same(e, f)))]]));
    const conflict = Object.keys(row.change).find((k) => k !== "reason" && !joins(k) && k in first.change && !same(first.change[k], row.change[k]));
    if (conflict) { errors.push(`changes[${i}] (${describeOrgChange(row.change)}) repeats changes[${hit.src}] with a different ${conflict}: one change per subject`); return; }
    const evidence = [...(first.evidence ?? []), ...(row.evidence ?? []).filter((e: any) => !(first.evidence ?? []).some((f: any) => same(e, f)))];
    out[hit.out] = {
      ...first,
      change: { ...first.change, ...row.change, ...joined, ...("reason" in first.change || "reason" in row.change ? { reason: prose(first.change.reason, row.change.reason) } : {}) },
      rationale: prose(first.rationale, row.rationale),
      ...(evidence.length ? { evidence } : {}),
      ...(prose(first.expected_effect, row.expected_effect) ? { expected_effect: prose(first.expected_effect, row.expected_effect) } : {}),
      ...(prose(first.risk, row.risk) ? { risk: prose(first.risk, row.risk) } : {}),
    };
    notes.push(`changes[${i}] (${describeOrgChange(row.change)}) folded into changes[${hit.src}]: one change per subject`);
  });
  return { changes: out, notes, errors, index };
}

export function parseOrgProposalSpec(raw: unknown): { spec: OrgProposalSpec; errors: []; notes?: string[] } | { spec: null; errors: string[] } {
  const errors: string[] = [];
  const r: any = raw;
  if (!r || typeof r !== "object" || Array.isArray(r)) return { spec: null, errors: ["the spec is a JSON object with title, summary_md, mode and changes"] };
  if (!nonEmpty(r.title)) errors.push("title is required");
  if (!nonEmpty(r.summary_md)) errors.push("summary_md is required: the summary a founder reads on a phone");
  if (!ORG_PROPOSAL_MODES.includes(r.mode)) errors.push(`mode is one of ${ORG_PROPOSAL_MODES.join(", ")}`);
  if (Array.isArray(r.changes)) r.changes = r.changes.map((row: any) => row && typeof row === "object" && row.change ? { ...row, change: normalizeAutonomyChange(row.change) } : row);
  if (!Array.isArray(r.changes) || r.changes.length === 0) errors.push("changes is a non-empty list");
  else r.changes.forEach((c: any, i: number) => {
    const at = `changes[${i}]${c?.change?.kind ? ` (${c.change.kind})` : ""}`;
    errors.push(...orgSpecChangeErrors(c).map((e) => `${at}: ${e}`));
  });
  let changes: any[] = r.changes;
  let notes: string[] = [];
  let asks: OrgAsk[] | undefined;
  if (!errors.length) errors.push(...orgSeatErrors(r.changes), ...orgProposalWorkErrors(r.changes), ...orgRecordRedundancyErrors(r.changes));
  if (!errors.length && r.asks !== undefined) errors.push(...orgAsksErrors(r.asks, r.changes));
  if (!errors.length) {
    const folded = foldRepeatedSubjects(r.changes);
    errors.push(...folded.errors);
    changes = folded.changes;
    notes = folded.notes;
    // The asks name changes as written; a folded row answers to the ask of
    // the row it folded into, so the partition survives the fold.
    if (r.asks !== undefined) {
      // A row folded from two asks follows the agent it names: the ask that
      // creates a role the merged change refers to (a charter's owner, a
      // routine's handle) holds it, so accepting the other ask alone never
      // applies a change that rests on an agent nobody accepted. With no such
      // ask, the first one that named it keeps it.
      const written: OrgAsk[] = r.asks;
      const creates = written.map((a) => new Set(a.seqs.map((q) => r.changes[q - 1].change).filter((c: OrgChange) => c.kind === "role").map((c: any) => askHandle(c))));
      const home = new Map<number, number>();
      changes.forEach((row, out) => {
        const named = written.map((a, i) => (a.seqs.some((q) => folded.index[q - 1] === out) ? i : -1)).filter((i) => i >= 0);
        const refs = orgChangeHandles(row.change);
        home.set(out + 1, named.find((i) => refs.some((h) => creates[i].has(h))) ?? named[0]);
      });
      asks = written.map((a, i) => ({
        title: a.title.trim(), why: a.why.trim(), effect: a.effect.trim(),
        seqs: [...new Set(a.seqs.map((q) => folded.index[q - 1] + 1))].filter((q) => home.get(q) === i).sort((x, y) => x - y),
      })).filter((a) => a.seqs.length);
    }
  }
  if (errors.length) return { spec: null, errors };
  return {
    spec: {
      title: r.title.trim(),
      summary_md: r.summary_md,
      mode: r.mode,
      changes: changes.map(normalizeOrgSpecChange),
      ...(asks ? { asks } : {}),
    },
    errors: [],
    ...(notes.length ? { notes } : {}),
  };
}

const at = (h: string) => `@${h.replace(/^@/, "")}`;
const list = (xs?: string[]) => (xs ?? []).join(", ");

const isPlainObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/**
 * A person's edits laid over a change (S5 "accept with edits"). Object valued
 * keys (`caps`, `scope`) merge one level deep, so editing one cap keeps the
 * others; `kind` never changes. Pure and unvalidated: the server checks the
 * result with orgChangeError before applying, the org page draws it as is.
 */
export function editedOrgChange<T extends OrgChange>(change: T, edits: unknown): T {
  if (!isPlainObject(edits)) return change;
  const merged: Record<string, unknown> = { ...change };
  for (const [k, v] of Object.entries(edits)) {
    const cur = merged[k];
    merged[k] = isPlainObject(v) && isPlainObject(cur) ? { ...cur, ...v } : v;
  }
  merged.kind = change.kind;
  return merged as T;
}

/**
 * What applying a change would take over (org-roles-run-work.md R1): the role
 * it names and the refs its scope gains, in the form `orgInit.takeoverPreview`
 * takes; null when it moves no session (no scope gained, or the change already
 * says `leave_sessions`). An adopt gains nothing itself: the seated role takes
 * over what its scope already holds. ONE rule for the two readers that must
 * agree: the pages that show the count before accept, and accept all, which
 * keeps one such change to a transaction because each costs hundreds of reads.
 */
export function orgChangeTakeover(c: OrgChange): { handle: string; add: string[]; seat?: string } | null {
  if ((c as OrgLeaveSessions).leave_sessions) return null;
  const typed = (kind: "project" | "plan") => (ref: string) => (/^(project|plan):/.test(ref) ? ref : `${kind}:${ref}`);
  const gains = (add: string[] | undefined) => (add?.length ? { handle: (c as { handle: string }).handle, add } : null);
  switch (c.kind) {
    // The session a role names becomes its seat before the takeover runs, so
    // it is never one of the sessions that move.
    case "role": { const g = gains([...(c.scope?.projects ?? []).map(typed("project")), ...(c.scope?.plans ?? []).map(typed("plan"))]); return g && c.seat ? { ...g, seat: c.seat.existing } : g; }
    case "scope": return gains(c.add);
    case "move": return gains(c.scope_add);
    case "adopt": return { handle: c.handle, add: [] };
    default: return null;
  }
}
export const orgChangeTakesOver = (c: OrgChange): boolean => orgChangeTakeover(c) !== null;

/** What a takeover moves, as counts: the dry count before, the result after. */
export type OrgTakeoverCounts = { sessions: number; kept_in_front: number; over_cap: number; told?: { sessions: number; deferred?: number } };

/** One writer for the sentence, so the note before accept, the note after
 *  apply and every page that shows the count say the same thing. `told` is
 *  what happened, so only a result that has it (after apply) says it. */
export function takeoverPhrase(handle: string, r: { sessions: unknown[]; kept_in_front: unknown[]; over_cap: number; told?: { sessions: number; deferred?: number } } | OrgTakeoverCounts | null | undefined, applied: boolean): string {
  if (!r) return "";
  const n = typeof r.sessions === "number" ? r.sessions : r.sessions.length;
  if (n === 0) return "";
  const one = n === 1;
  const parts = [`${n} session${one ? "" : "s"} now report${one ? "s" : ""} to @${handle.replace(/^@/, "")} and leave${one ? "s" : ""} your needs input`];
  const kept = typeof r.kept_in_front === "number" ? r.kept_in_front : r.kept_in_front.length;
  if (kept) parts.push(`${kept} of them stay${kept === 1 ? "s" : ""} in front of you with a question still open`);
  if (applied && r.told) parts.push(`${r.told.sessions} told now${r.told.deferred ? `, ${r.told.deferred} will read it on their next turn` : ""}`);
  if (r.over_cap) parts.push(`${r.over_cap} more stay where they are until the next change`);
  return parts.join("; ");
}

/** "spend on Google Ads and post to social", from the grants' kinds and labels. */
export function authorityWords(grants: ReadonlyArray<OrgAuthorityGrant>): string {
  const verbs: Record<OrgAuthorityKind, string> = { spend: "spend", publish: "publish", write: "write", connect: "connect" };
  const parts = grants.map((g) => `${verbs[g.kind]} (${g.label}${g.limit?.usd_per_month !== undefined ? `, up to $${g.limit.usd_per_month} a month` : g.limit?.usd_per_day !== undefined ? `, up to $${g.limit.usd_per_day} a day` : g.limit?.per_day !== undefined ? `, up to ${g.limit.per_day} a day` : ""})`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0] ?? "nothing more";
}

/** One line per change, the words the CLI walk and the ghost chips use. */
export function describeOrgChange(c: OrgChange): string {
  switch (c.kind) {
    case "role": return `${c.seat ? `name session ${c.seat.existing} as role` : "create role"} ${c.name} ${at(c.handle)}${c.reports_to ? ` reporting to ${c.reports_to}` : ""}${c.scope?.projects?.length || c.scope?.plans?.length ? ` over ${list([...(c.scope.projects ?? []), ...(c.scope.plans ?? [])])}` : ""}${c.tenure ? ` (${describeTenure(c.tenure)})` : ""}`;
    case "projects": return c.changes.map((x) => x.op === "create" ? `create project ${x.title}${x.horizon ? ` (${x.horizon})` : ""}` : `merge project ${x.from} into ${x.into}`).join("; ");
    case "move": return `move ${at(c.handle)}${c.reports_to ? ` under ${c.reports_to}` : ""}${c.scope_add?.length ? ` +${list(c.scope_add)}` : ""}${c.scope_remove?.length ? ` -${list(c.scope_remove)}` : ""}`;
    case "retire": return `retire ${at(c.handle)}`;
    case "scope": return `scope ${at(c.handle)}${c.add?.length ? ` +${list(c.add)}` : ""}${c.remove?.length ? ` -${list(c.remove)}` : ""}`;
    case "budget": return `budget ${at(c.handle)} ${Object.entries(c.caps).filter(([, v]) => v !== undefined).map(([k, v]) => `${k.replace("_per_day", "")} ${v}/day`).join(", ")}`;
    case "trust": return `autonomy ${at(c.handle)} ${autonomyOn(c.trust) ? "on" : "off"}`;
    case "routine": return `routine on ${at(c.handle)}: ${c.title} every ${c.every}`;
    case "project_meta": return `charter ${c.project}${c.owner ? ` owner ${at(c.owner)}` : ""}${c.priority ? ` ${c.priority}` : ""}${c.goal ? `: ${c.goal}` : ""}`;
    case "adopt": return `adopt session ${c.conversation} as ${at(c.handle)}'s standing session`;
    case "authority": return `authority ${at(c.handle)}: ${c.authority.map((g) => `${g.kind} (${g.label})`).join(", ")}`;
    case "hire": return `hire ${at(c.handle)} from template ${c.template}@${c.version} on ${c.project} as ${c.instance}`;
    case "upgrade": return `upgrade instance ${c.instance} to ${c.template}@${c.to}`;
    case "file": return `file plan ${c.plan} under project ${c.project}`;
    case "charter_edit": return `charter ${at(c.handle)}: ${c.edits.map(charterEditTerse).join("; ")}`;
    case "plan_status": return `mark plan ${c.plan} ${c.status}`;
    case "task_status": return `mark task ${c.task} ${c.status}`;
    case "project_status": return `mark project ${c.project} ${c.status}`;
    case "initiative": return `set goal ${c.title} over ${list(c.projects)}${c.owner ? ` owned by ${c.owner}` : ""}${c.parent ? ` under ${c.parent}` : ""}${c.metrics?.length ? ` measured by ${metricsWords(c.metrics)}` : ""}${recordTerse(c)}`;
    case "initiative_projects": return `goal ${c.initiative} +${list(c.projects)}`;
    case "initiative_owner": return `goal ${c.initiative} owner ${c.owner}`;
    case "initiative_shape": return `goal ${c.initiative}${c.parent !== undefined ? ` under ${c.parent ?? "nothing"}` : ""}${c.metrics !== undefined ? ` metrics ${c.metrics.length ? metricsWords(c.metrics) : "none"}` : ""}${recordTerse(c)}`;
  }
}
/** The record a goal change carries, for the terse line: " why done_when +2 milestones +1 sources". */
const recordTerse = (c: OrgInitiativeRecord): string =>
  `${c.why !== undefined ? " why" : ""}${c.done_when !== undefined ? " done_when" : ""}${(["milestones", "questions", "decisions", "sources"] as const).map((list) => c[list]?.length ? ` +${c[list]!.length} ${list}` : "").join("")}`;

/**
 * A record change as its row shows it (S9): the act ("mark done"), the
 * record's ref ("ct-42") and its title when the change carries one. The row
 * renders the act and the title with the ref as a pill; `changeLine` writes
 * the same parts as one string ("Mark done: Fix the build (ct-42)"). A
 * title that only repeats the ref (a project named by its title) is dropped,
 * so the ref is never said twice. Null for every other kind of change.
 */
export function recordChangeParts(c: OrgChange): { act: string; ref: string; title: string | null } | null {
  if (c.kind !== "plan_status" && c.kind !== "task_status" && c.kind !== "project_status") return null;
  const ref = (c.kind === "plan_status" ? c.plan : c.kind === "task_status" ? c.task : c.project).trim();
  const title = c.title?.trim() || null;
  return { act: `mark ${c.status}`, ref, title: title && title.toLowerCase() !== ref.toLowerCase() ? title : null };
}

/**
 * The one line a change reads as to a person (org-staffing.md S17): a sentence
 * addressed to the reader, in the product's own words (role, area
 * of work, daily limit), never the CLI walk's command syntax
 * (describeOrgChange keeps that for the terminal). The proposal pane, the
 * chart's chips, the org log and the undo preview all say a change this way
 * (S21: the log, the proposal and the preview say one thing in one way).
 * Total: a kind this build does not know (a newer server) still reads as a
 * sentence, so a page degrades to a readable row instead of throwing.
 */
export function changeLine(change: OrgChange, words?: ChangeWords): string {
  const line = changeSentence(change, words);
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** A project's priority as a sentence says it: "make Growth a high priority". */
export const PRIORITY_WORDS: Record<OrgPriority, string> = { p0: "the top priority", p1: "a high priority", p2: "a medium priority", p3: "a low priority" };

/** How a sentence is written for a reader who has names in hand. With nothing
 *  passed a change reads the way the log and the terminal print it. */
export type ChangeWords = {
  /** A role by handle, a project, plan or goal by ref, a session by short id; a ref the names do not know stands as written. */
  names?: OrgAskNames;
  /** What to call the subject in place of its name: "it" for a clause that follows another about the same subject. */
  subject?: string;
  /** The card's sentence: verb first, the subject's name written once, and
   *  nothing a field row already shows (a handle, an area, a measure's
   *  target, a limit's number). */
  brief?: boolean;
  /** The project's priority before the change, when the caller knows it: null for none. */
  was?: { priority?: OrgPriority | null };
  /** The goal this change sets is the purpose, the one top level goal the proposal's other goals sit under. */
  purpose?: boolean;
};

/** The sentence of a change before its capital letter, with no full stop: the
 *  clauses of changeClauses joined as one. A caller that joins several changes
 *  to one subject reads the clauses instead. */
export function changeSentence(change: OrgChange, words?: ChangeWords): string {
  return andList(changeClauses(change, words));
}

/**
 * A change as the clauses of its sentence. Every form but the card's is one
 * clause. The card's (`brief`) is one clause per thing the change does to its
 * subject, the first naming the subject and the rest saying "it" ("move X
 * under P", "give it two measures"), so several changes to one subject join
 * into one sentence: the lead change's clauses, then each other change's with
 * `subject: "it"`.
 */
export function changeClauses(c: OrgChange, words: ChangeWords = {}): string[] {
  const { names, brief } = words;
  const bare = (ref: string) => ref.trim().replace(/^@/, "").toLowerCase();
  /** A role by the name the reader knows, else its handle as written. */
  const who = (handle: string) => names?.role?.(bare(handle)) ?? at(handle);
  /** Who a role reports to: "you" for the reader, a role by name, anyone else as the change names them. */
  const parent = (ref: string | undefined) => !ref || ref === "me" ? "you" : names?.role?.(bare(ref)) ?? ref;
  const project = (ref: string) => names?.project?.(ref) ?? ref;
  const plan = (ref: string) => names?.plan?.(ref) ?? ref;
  /** An entry of a role's area, which a change names without saying which kind it is. */
  const thing = (ref: string) => names?.project?.(ref) ?? names?.plan?.(ref) ?? ref;
  /** The subject as the sentence calls it: the caller's word, else its name, after the noun a cold reader needs ("the role X"). */
  const subject = (name: string, noun = "") => words.subject ?? (noun ? `${noun} ${name}` : name);
  switch (c.kind) {
    case "role": {
      // A role that names a session adds nothing: the session is already there (R2).
      const session = c.seat ? c.seat.title?.trim() || names?.session?.(c.seat.existing) || c.seat.existing : "";
      if (brief) return [`${c.seat ? `name the session ${session} as` : "add"} ${subject(c.name, "the role")}, reporting to ${parent(c.reports_to)}`];
      const scope = [...(c.scope?.projects ?? []).map(project), ...(c.scope?.plans ?? []).map(plan)];
      return [`${c.seat ? `name the session ${session} as a role` : "add a role"}, ${subject(`${c.name} (${at(c.handle)})`)}, reporting to ${parent(c.reports_to)}${scope.length ? `, looking after ${andList(scope)}` : ""}`];
    }
    case "projects": {
      const entries = c.changes.map((x) => x.op === "create" ? `create the project ${x.title}${x.horizon ? ` (${x.horizon})` : ""}` : `fold the project ${project(x.from)} into ${project(x.into)}`);
      return brief ? entries : [entries.join("; ")];
    }
    case "move": {
      const s = subject(who(c.handle)), gains = andList((c.scope_add ?? []).map(thing)), loses = andList((c.scope_remove ?? []).map(thing));
      if (brief) {
        const clauses = [
          c.reports_to && ((r: string) => `have ${r} report to ${parent(c.reports_to)}`),
          gains && ((r: string) => `have ${r} look after ${gains}`),
          loses && ((r: string) => `have ${r} stop looking after ${loses}`),
        ].filter(isClause);
        return clauses.length ? clausesAbout(s, clauses) : [`move ${s}`];
      }
      return [`move ${s}${c.reports_to ? ` under ${parent(c.reports_to)}` : ""}${gains ? `; now also looks after ${gains}` : ""}${loses ? `; no longer looks after ${loses}` : ""}`];
    }
    case "retire": return [`retire ${subject(who(c.handle))}${brief ? ". Its" : "; its"} sessions go back to their owners`];
    case "scope": {
      const s = subject(who(c.handle)), gains = andList((c.add ?? []).map(thing)), loses = andList((c.remove ?? []).map(thing));
      if (brief) {
        const clauses = [gains && ((r: string) => `have ${r} look after ${gains}`), loses && ((r: string) => `have ${r} stop looking after ${loses}`)].filter(isClause);
        return clauses.length ? clausesAbout(s, clauses) : [`have ${s} keep its area of work`];
      }
      return [`${s} ${[gains && `also looks after ${gains}`, loses && `stops looking after ${loses}`].filter(Boolean).join(" and ") || "keeps its area of work"}`];
    }
    // A limit's number is never the card's to print (S23.2): there the change reads as the quiet sentence.
    case "budget": return [brief ? quietChangeSentence(c, subject(who(c.handle))).replace(/\.$/, "") : `${subject(who(c.handle))} may use up to ${capsWords(c.caps)} a day`];
    case "trust": {
      const s = subject(who(c.handle)), on = autonomyOn(c.trust);
      if (brief) return [on ? `let ${s} start work in its area on its own` : `have ${s} ask before it starts work`];
      return [`${s} ${on ? "starts work on its own" : "stops starting work on its own"}`];
    }
    case "routine": {
      const s = subject(who(c.handle));
      return [brief ? `have ${s} run ${c.title} ${everyWords(c.every)}` : `${s} runs "${c.title}" ${everyWords(c.every)}`];
    }
    case "project_meta": {
      // What the change writes down is named, never printed: the words are the card's rows and the project page's.
      const { priority, owner } = c, was = words.was?.priority;
      const written = [
        c.goal != null && ((p: string) => `what ${p} is for`),
        c.success_metrics != null && ((p: string) => `how ${p} is measured`),
        c.non_goals != null && ((p: string) => `what ${p} leaves out`),
        c.risks != null && ((p: string) => p === "it" ? "its risks" : `the risks to ${p}`),
      ].filter(isClause);
      const clauses = [
        priority && ((p: string) => priority === "p0" || !was || was === priority ? `make ${p} ${PRIORITY_WORDS[priority]}` : `${priority < was ? "raise" : "lower"} ${p} to ${PRIORITY_WORDS[priority]}`),
        owner && ((p: string) => `make ${who(owner)} ${p === "it" ? "its lead" : `the lead of ${p}`}`),
        written.length > 0 && ((p: string) => `write down ${andList(clausesAbout(p, written))}`),
      ].filter(isClause);
      return clauses.length ? clausesAbout(subject(project(c.project)), clauses) : [`change ${subject(project(c.project), "the project")}`];
    }
    case "adopt": {
      const title = names?.session?.(c.conversation);
      return [`make ${title ? `the session ${title}` : `session ${c.conversation}`} the standing session of ${subject(who(c.handle))}`];
    }
    case "authority": {
      const s = subject(who(c.handle));
      return [`${brief ? `let ${s}` : `${s} may`} ${authorityWords(c.authority)}, inside the limits you set`];
    }
    case "hire": return [`hire ${subject(who(c.handle))} from the template ${c.template} (${c.version}) to lead ${project(c.project)}`];
    case "upgrade": return [`move ${subject(c.instance, "the instance")} to ${c.template} ${c.to}`];
    case "file": return [`put ${subject(plan(c.plan), brief ? "the plan" : "plan")} under the project ${project(c.project)}`];
    case "charter_edit": {
      // What the edit does, never the words: the card shows each passage before and after.
      const s = subject(who(c.handle));
      const own = (r: string) => (r === "it" ? "its charter" : `${r}'s charter`);
      const k = (op: OrgCharterEdit["op"]) => c.edits.filter((e) => e.op === op).length;
      const clauses = [
        k("replace") > 0 && ((r: string) => `rewrite ${k("replace") === 1 ? "a passage" : `${k("replace")} passages`} of ${own(r)}`),
        k("add") > 0 && ((r: string) => `add ${k("add") === 1 ? "a line" : `${k("add")} lines`} to ${own(r)}`),
        k("remove") > 0 && ((r: string) => `cut ${k("remove") === 1 ? "a passage" : `${k("remove")} passages`} from ${own(r)}`),
      ].filter(isClause);
      // The card reads one clause per thing done; every other form is one sentence.
      return brief ? clausesAbout(s, clauses) : [andList(clausesAbout(s, clauses))];
    }
    case "plan_status": case "task_status": case "project_status": {
      const parts = recordChangeParts(c)!;
      // The log and the terminal keep the id beside the title; the card says it as an act on the record, by its title.
      if (!brief) return [parts.title ? `${parts.act}: ${parts.title} (${parts.ref})` : describeOrgChange(c)];
      const noun = c.kind === "plan_status" ? "plan" : c.kind === "task_status" ? "task" : "project";
      const s = subject(parts.title ?? (c.kind === "plan_status" ? plan(parts.ref) : c.kind === "project_status" ? project(parts.ref) : parts.ref), `the ${noun}`);
      return [c.status === "active" || c.status === "open" ? `reopen ${s}` : c.status === "backlog" ? `move ${s} to the backlog` : `mark ${s} as ${c.status}`];
    }
    case "initiative": case "initiative_projects": case "initiative_owner": case "initiative_shape": return goalChangeClauses(c, names, words);
    default: {
      const kind = (c as { kind?: unknown }).kind;
      return [`a change this version of codecast cannot show yet${typeof kind === "string" && kind ? ` ("${kind}")` : ""}`];
    }
  }
}

/** "standing" or "program · ends with pl-3, then retire": the chip on a node,
 *  the hire form and a proposal's role line all say it this way. */
export function describeTenure(t: OrgTenureSpec | { kind: "standing" } | { kind: "program"; ends: { plan?: unknown; project?: unknown; date?: number }; then: "retire" | "review" } | null | undefined, names?: { plan?: string; project?: string }): string {
  if (!t) return "";
  if (t.kind === "standing") return "standing";
  const e: any = t.ends;
  const ends = e.plan !== undefined ? `with ${names?.plan ?? e.plan}` : e.project !== undefined ? `with ${names?.project ?? e.project}` : humanEndDate(e.date);
  return `program · ends ${ends}, then ${t.then}`;
}

const TENURE_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A program's end date the way a person says it: "Oct 3". The year comes along
 *  only when it is not the current one, so a near end stays short and a distant
 *  one is never ambiguous. UTC throughout, like the date the spec carries. */
function humanEndDate(ms: number): string {
  const d = new Date(ms);
  const day = `${TENURE_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return d.getUTCFullYear() === new Date().getUTCFullYear() ? day : `${day} ${d.getUTCFullYear()}`;
}

/** Option order every org proposal decision uses. The index is the verdict. */
export const ORG_PROPOSAL_OPTIONS = {
  role: ["Create as proposed", "Create with changes", "Skip"],
  projects: ["Apply as proposed", "Apply with changes", "Skip"],
  move: ["Move as proposed", "Move with changes", "Skip"],
  retire: ["Retire as proposed", "Retire with changes", "Skip"],
} as const satisfies Record<OrgProposal["kind"], readonly [string, string, string]>;

export type OrgProposalVerdict = "apply" | "apply_with_changes" | "skip";

export function orgProposalVerdict(answerIndex: number | undefined): OrgProposalVerdict | null {
  if (answerIndex === 0) return "apply";
  if (answerIndex === 1) return "apply_with_changes";
  if (answerIndex === 2) return "skip";
  return null;
}

/** Render the block the decision context carries. */
export function orgProposalBlock(proposal: OrgProposal): string {
  return "```" + ORG_PROPOSAL_FENCE + "\n" + JSON.stringify(proposal, null, 2) + "\n```";
}

const FENCE_RE = new RegExp("```" + ORG_PROPOSAL_FENCE + "[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n```");

/** The proposal inside a decision's context, or null when there is none or it is malformed. */
export function extractOrgProposal(md: string | undefined | null): OrgProposal | null {
  const m = FENCE_RE.exec(md ?? "");
  if (!m) return null;
  let raw: any;
  try { raw = JSON.parse(m[1]); } catch { return null; }
  return isOrgProposal(raw) ? raw : null;
}

export function isOrgProposal(raw: any): raw is OrgProposal {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  switch (raw.kind) {
    case "role":
      return typeof raw.name === "string" && raw.name.trim().length > 0 && typeof raw.handle === "string" && raw.handle.trim().length > 0;
    case "projects":
      return Array.isArray(raw.changes) && raw.changes.every((c: any) =>
        c && ((c.op === "create" && typeof c.title === "string" && c.title.trim()) || (c.op === "merge" && typeof c.from === "string" && typeof c.into === "string")));
    case "move":
      return typeof raw.handle === "string" && raw.handle.trim().length > 0;
    case "retire":
      return typeof raw.handle === "string" && raw.handle.trim().length > 0;
    default:
      return false;
  }
}

// "Create with changes" carries the person's text in the answer. JSON with the
// proposal's own keys overrides fields; anything else is prose and rides along
// as a note the apply path folds into the charter (a role) or the reason.
export function applyProposalChanges<T extends OrgProposal>(proposal: T, answerText: string | undefined | null): { proposal: T; note?: string } {
  const text = (answerText ?? "").trim();
  if (!text) return { proposal };
  if (text.startsWith("{")) {
    try {
      const patch = JSON.parse(text);
      if (patch && typeof patch === "object" && !Array.isArray(patch)) {
        const merged = { ...proposal, ...patch, kind: proposal.kind };
        if (isOrgProposal(merged)) return { proposal: merged as T };
      }
    } catch { /* prose that happens to open with a brace */ }
  }
  return { proposal, note: text };
}

// ── Record groups (org-staffing.md S9, revised) ─────────────────────────────
// A record proposal is read by project: the person settles one project's
// records together and sees the totals, never the list. Every record change
// is in exactly one group; the group is the project the change names or
// sits under, else its plan, else the records filed under none. Removed
// changes belong to no group.

export type OrgRecordAct = "done" | "dropped" | "abandoned" | "reopened" | "backlog" | "paused";
export type OrgRecordTotal = { noun: "project" | "plan" | "task"; act: OrgRecordAct; count: number };
export type OrgRecordGroup = {
  /** "project:<ref>", "plan:<ref>", "plans" or "loose". */
  key: string;
  /** "plans": the plans this proposal settles on their own (one status change each, no tasks under them), folded into one group so a long list of them never buries the projects. */
  kind: "project" | "plan" | "plans" | "loose";
  /** The project's or plan's ref as the changes carry it (pr-N, pl-N, or a title). */
  ref?: string;
  /** The project's or plan's title: from a change on that record in this proposal, else the reader's names; absent when neither knows it, and the ref stands. The plans group is titled "N plans". */
  title?: string;
  /** The changes in the group, ascending. */
  seqs: number[];
  /** What the group does, as counts: projects first, then plans, then tasks. Zero counts are left out. */
  totals: OrgRecordTotal[];
};

const RECORD_ACTS: readonly OrgRecordAct[] = ["done", "dropped", "abandoned", "reopened", "backlog", "paused"];
const RECORD_NOUNS = ["project", "plan", "task"] as const;
/** What a record change does to its record, as the totals count it: a reopen is "reopened" whatever the row's open word. */
export function recordAct(c: OrgRecordStatusChange): OrgRecordAct {
  return c.status === "active" || c.status === "open" ? "reopened" : c.status;
}
const recordNoun = (c: OrgRecordStatusChange): "project" | "plan" | "task" => (c.kind === "plan_status" ? "plan" : c.kind === "task_status" ? "task" : "project");
const recordRef = (c: OrgRecordStatusChange): string => (c.kind === "plan_status" ? c.plan : c.kind === "task_status" ? c.task : c.project).trim();

export function orgRecordGroups(changes: ReadonlyArray<{ seq: number; change: OrgChange; status?: string }>, names?: OrgAskNames): OrgRecordGroup[] {
  const live = changes.filter((c): c is { seq: number; change: OrgRecordStatusChange; status?: string } => c.status !== "removed" && (ORG_SYNC_KINDS as readonly string[]).includes(c.change.kind));
  const lc = (ref: string) => ref.trim().toLowerCase();
  // What this proposal itself knows about the records it names: a plan's project, a record's title.
  const titleOf = new Map<string, string>();
  const planProject = new Map<string, string>();
  for (const { change: c } of live) {
    if (c.title?.trim()) titleOf.set(lc(recordRef(c)), c.title.trim());
    if (c.kind === "plan_status" && c.project?.trim()) planProject.set(lc(c.plan), c.project.trim());
  }
  const placeOf = (c: OrgRecordStatusChange): { kind: OrgRecordGroup["kind"]; ref?: string } => {
    if (c.kind === "project_status") return { kind: "project", ref: c.project.trim() };
    if (c.kind === "plan_status") return c.project?.trim() ? { kind: "project", ref: c.project.trim() } : { kind: "plan", ref: c.plan.trim() };
    const project = c.project?.trim() || (c.plan ? planProject.get(lc(c.plan)) : undefined);
    if (project) return { kind: "project", ref: project };
    if (c.plan?.trim()) return { kind: "plan", ref: c.plan.trim() };
    return { kind: "loose" };
  };
  const groups = new Map<string, OrgRecordGroup>();
  const counts = new Map<string, Map<string, number>>();
  for (const row of live) {
    const place = placeOf(row.change);
    const key = place.kind === "loose" ? "loose" : `${place.kind}:${lc(place.ref!)}`;
    let g = groups.get(key);
    if (!g) {
      const title = place.ref ? titleOf.get(lc(place.ref)) ?? (place.kind === "project" ? names?.project?.(place.ref) : names?.plan?.(place.ref)) : undefined;
      g = { key, kind: place.kind, ...(place.ref ? { ref: place.ref } : {}), ...(title && title.toLowerCase() !== lc(place.ref!) ? { title } : {}), seqs: [], totals: [] };
      groups.set(key, g);
      counts.set(key, new Map());
    }
    g.seqs.push(row.seq);
    const k = `${recordNoun(row.change)}:${recordAct(row.change)}`;
    counts.get(key)!.set(k, (counts.get(key)!.get(k) ?? 0) + 1);
  }
  const totalsOf = (c: Map<string, number>): OrgRecordTotal[] => RECORD_NOUNS.flatMap((noun) => RECORD_ACTS.flatMap((act) => { const n = c.get(`${noun}:${act}`); return n ? [{ noun, act, count: n }] : []; }));
  for (const [key, g] of groups) {
    g.seqs.sort((a, b) => a - b);
    g.totals = totalsOf(counts.get(key)!);
  }
  // Two or more plans settled on their own (each group one plan_status, no
  // tasks) fold into one "N plans" group; a single one keeps its own name.
  const alone = [...groups.values()].filter((g) => g.kind === "plan" && g.seqs.length === 1 && g.totals[0]?.noun === "plan");
  if (alone.length > 1) {
    const sum = new Map<string, number>();
    for (const g of alone) { groups.delete(g.key); for (const [k, n] of counts.get(g.key)!) sum.set(k, (sum.get(k) ?? 0) + n); }
    groups.set("plans", { key: "plans", kind: "plans", title: `${alone.length} plans`, seqs: alone.flatMap((g) => g.seqs).sort((a, b) => a - b), totals: totalsOf(sum) });
  }
  // The biggest group first, then the plans, the loose records last, ties by first seq.
  const rank = (g: OrgRecordGroup) => (g.kind === "loose" ? 2 : g.kind === "plans" ? 1 : 0);
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || b.seqs.length - a.seqs.length || a.seqs[0] - b.seqs[0]);
}

/** "2 plans done, 11 tasks done and 3 tasks reopened": the group's one line, in the words the card uses for each act. */
export const RECORD_ACT_WORDS: Record<OrgRecordAct, string> = { done: "done", dropped: "dropped", abandoned: "abandoned", reopened: "reopened", backlog: "to the backlog", paused: "paused" };
export function recordGroupTotalsLine(g: { totals: readonly OrgRecordTotal[] }): string {
  return andList(g.totals.map((t) => `${t.count} ${t.noun}${t.count === 1 ? "" : "s"} ${RECORD_ACT_WORDS[t.act]}`));
}

/**
 * A task close the proposal's own plan close already covers (S9, revised):
 * closing a plan drops its open tasks (never done: the plan closed without
 * them), so a task change under that plan that drops it is refused as a
 * second row for one act. A task done on its own evidence keeps its own
 * change, which lands before the plan's by apply rank and is already closed
 * when the cascade reads the plan.
 */
export function orgRecordRedundancyErrors(changes: ReadonlyArray<{ change: OrgChange }>): string[] {
  const closing = new Map<string, { i: number; status: "done" | "abandoned" }>();
  changes.forEach((row, i) => {
    const c = row.change;
    if (c.kind === "plan_status" && (c.status === "done" || c.status === "abandoned")) closing.set(c.plan.trim().toLowerCase(), { i, status: c.status });
  });
  if (!closing.size) return [];
  const errors: string[] = [];
  changes.forEach((row, i) => {
    const c = row.change;
    if (c.kind !== "task_status" || !c.plan?.trim()) return;
    const plan = closing.get(c.plan.trim().toLowerCase());
    if (!plan) return;
    if (c.status === "dropped") errors.push(`changes[${i}] (${describeOrgChange(c)}) is covered by changes[${plan.i}], which marks its plan ${c.plan.trim()} ${plan.status}: closing the plan drops its open tasks, so drop this change (a task finished on its own evidence keeps its own done change)`);
  });
  return errors;
}

// ── Charter edits ───────────────────────────────────────────────────────────

/** Why one edit is not one, or null. */
export function orgCharterEditError(e: any): string | null {
  if (!e || typeof e !== "object" || Array.isArray(e)) return "a charter edit is { op: \"replace\", before, after }, { op: \"add\", line } or { op: \"remove\", before }";
  const passage = (field: string, text: unknown): string | null =>
    !nonEmpty(text) ? `charter_edit ${e.op}: ${field} is the passage, a non-empty string` : text.trim().length > ORG_CHARTER_PASSAGE_MAX ? `charter_edit ${e.op}: ${field} is ${text.trim().length} characters; a passage is at most ${ORG_CHARTER_PASSAGE_MAX}, so quote the sentence that changes, not the whole charter` : null;
  switch (e.op) {
    case "replace": {
      const fault = passage("before", e.before) ?? passage("after", e.after); if (fault) return fault;
      return e.before.trim() === e.after.trim() ? "charter_edit replace: after is the same as before" : null;
    }
    case "add": return passage("line", e.line);
    case "remove": return passage("before", e.before);
    default: return `charter_edit op is replace, add or remove, not ${JSON.stringify(e.op)}`;
  }
}

/** A long passage shortened for a terminal line. */
const clip = (text: string, n = 48): string => { const t = text.trim().replace(/\s+/g, " "); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const charterEditTerse = (e: OrgCharterEdit): string => (e.op === "replace" ? `replace "${clip(e.before)}" with "${clip(e.after)}"` : e.op === "add" ? `add "${clip(e.line)}"` : `remove "${clip(e.before)}"`);

/**
 * The charter after the edits, or why they do not apply: a passage must
 * occur exactly once in the charter as it stands (matched on its words,
 * whatever the spacing), and the result must fit the cap. Pure, so the
 * server applies it and a page can preview it.
 */
export function applyCharterEdits(charter: string | null | undefined, edits: ReadonlyArray<OrgCharterEdit>): { charter: string; error?: undefined } | { charter?: undefined; error: string } {
  let text = (charter ?? "").replace(/\r\n/g, "\n");
  const find = (passage: string): { at: number; len: number } | string => {
    const words = passage.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const re = new RegExp(words.join("\\s+"), "g");
    const hits = [...text.matchAll(re)];
    if (!hits.length) return `the passage "${clip(passage)}" is not in the charter as it stands; quote it exactly`;
    if (hits.length > 1) return `the passage "${clip(passage)}" appears ${hits.length} times in the charter; quote more of it so it names one place`;
    return { at: hits[0].index!, len: hits[0][0].length };
  };
  for (const e of edits) {
    if (e.op === "add") { text = `${text.trim()}${text.trim() ? "\n\n" : ""}${e.line.trim()}`; continue; }
    const hit = find(e.before);
    if (typeof hit === "string") return { error: hit };
    text = `${text.slice(0, hit.at)}${e.op === "replace" ? e.after.trim() : ""}${text.slice(hit.at + hit.len)}`;
  }
  text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").replace(/ ([.,;:])/g, "$1").trim();
  if (text.length > ORG_CHARTER_MAX) return { error: `the charter would be ${text.length} characters after this edit; ${ORG_CHARTER_CONDENSE}` };
  return { charter: text };
}
