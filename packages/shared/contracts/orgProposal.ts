// Org proposals (docs/architecture/org-init.md O2): the machine-readable half
// of a decision `cast org init` or `cast org update` posts. The analyzer writes
// one fenced JSON block into the decision's context; `cast org apply` reads
// the block back and acts on the answer. The CLI prompt, the Convex apply
// path and both tests share this one reading of the block and of the option
// order, so an option index means the same thing everywhere.

import { autonomyOn, trustForSwitch } from "./roleAutonomy";

export const ORG_PROPOSAL_FENCE = "org-proposal";

export type OrgProposalCaps = { hands_per_day?: number; wakes_per_day?: number; tokens_per_day?: number };

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
/** This session becomes the role's standing session (the analyzer offering to be the chief of staff). */
export type OrgAdoptChange = { kind: "adopt"; handle: string; conversation: string } & OrgLeaveSessions;
/** File a plan under a project (plans.project_id), so a role's scope can see it. Both are refs. */
export type OrgFileChange = { kind: "file"; plan: string; project: string };

// Bring records in line (org-staffing.md S9): a plan, task or project whose
// evidence says it is finished gets its status set, through the same update
// paths a person uses. `reason` is the evidence, for the person deciding.
// `title` is the record's own title, carried on the change so the row reads
// "Mark done: <title>" wherever the proposal is read: a reader's store may
// not hold that team's records, so the title travels with the proposal (the
// analyzer writes it from its inputs; the server fills it at post time when
// the record is in the workspace).
export type OrgPlanStatusChange = { kind: "plan_status"; plan: string; status: "done" | "abandoned" | "active"; reason: string; title?: string };
/** A task's status set: done or dropped closes it; open (or backlog, where the
 *  team's statuses have it) puts a row that was marked in progress but never
 *  worked back where it belongs, instead of dropping real backlog. */
export type OrgTaskStatusChange = { kind: "task_status"; task: string; status: "done" | "dropped" | "open" | "backlog"; reason: string; title?: string };
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
/** Set a goal: the initiative with the sentence that says what reaching it
 *  looks like, the projects that carry it, and who drives it. */
export type OrgInitiativeChange = { kind: "initiative"; title: string; description: string; projects: string[]; owner?: string; target_date?: number; evidence?: string[] };
/** Add projects to a goal that exists. */
export type OrgInitiativeProjectsChange = { kind: "initiative_projects"; initiative: string; projects: string[]; title?: string };
/** Give a goal an owner, a person or a role. */
export type OrgInitiativeOwnerChange = { kind: "initiative_owner"; initiative: string; owner: string; title?: string };
export type OrgGoalChange = OrgInitiativeChange | OrgInitiativeProjectsChange | OrgInitiativeOwnerChange;

export type OrgChange = OrgProposal | OrgScopeChange | OrgBudgetChange | OrgTrustChange | OrgRoutineChange | OrgProjectMetaChange | OrgAdoptChange | OrgFileChange
  | OrgPlanStatusChange | OrgTaskStatusChange | OrgProjectStatusChange | OrgAuthorityChange | OrgHireChange | OrgUpgradeChange | OrgGoalChange;

export const ORG_CHANGE_KINDS = [...ORG_PROPOSAL_KINDS, "file", "scope", "budget", "trust", "routine", "project_meta", "adopt", "plan_status", "task_status", "project_status", "authority", "hire", "upgrade", "initiative", "initiative_projects", "initiative_owner"] as const;
/** The kinds the pane groups under "Bring records in line" (S9). */
export const ORG_SYNC_KINDS: readonly OrgChangeKind[] = ["plan_status", "task_status", "project_status"];
/** The kinds that set, extend or staff a goal; one ask holds them (I1, revised). */
export const ORG_GOAL_KINDS: readonly OrgChangeKind[] = ["initiative", "initiative_projects", "initiative_owner"];
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
  projects: 3, file: 4, role: 5, project_meta: 6, initiative: 7, initiative_projects: 8, initiative_owner: 9,
  move: 10, scope: 11, budget: 12, trust: 13, authority: 14, adopt: 15, routine: 16, hire: 17, upgrade: 18, retire: 19,
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
      return optStrings(raw.evidence) ? null : "initiative evidence is a list of strings";
    case "initiative_projects":
      if (!nonEmpty(raw.initiative)) return "initiative_projects needs an initiative ref (in-N, an id or its title)";
      if (!strings(raw.projects) || !raw.projects.length) return "initiative_projects projects is a non-empty list of project refs";
      return optString(raw.title) ? null : "initiative_projects title is the initiative's title, a string";
    case "initiative_owner":
      if (!nonEmpty(raw.initiative)) return "initiative_owner needs an initiative ref (in-N, an id or its title)";
      if (!nonEmpty(raw.owner)) return "initiative_owner owner is \"@handle\" for a role, \"me\" or a member's name for a person";
      return optString(raw.title) ? null : "initiative_owner title is the initiative's title, a string";
  }
  return null;
}

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

/** The author's thread bound to a proposal: the chief of staff's standing
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

/** A message sent from the pane opens with the change the person was looking
 *  at, so the agent answers about the right row. One line, then a blank line,
 *  then the person's words. Both sides read this one format. */
export function aboutChangeHeader(proposalShortId: string, seq: number, line: string): string {
  return `About ${proposalShortId} change ${seq} ("${line.replace(/"/g, "'")}"):`;
}
export function withAboutChange(content: string, proposalShortId: string, seq: number, line: string): string {
  return `${aboutChangeHeader(proposalShortId, seq, line)}\n\n${content}`;
}
/** The same header for a reply about one ask (S19). `index` is the ask's
 *  place in the resolved asks, from 0, the number `decideAsk` takes; the
 *  header counts from 1, the way a person counts the cards. */
export function aboutAskHeader(proposalShortId: string, index: number, title: string): string {
  return `About ${proposalShortId} ask ${index + 1} ("${title.replace(/"/g, "'")}"):`;
}
export function withAboutAsk(content: string, proposalShortId: string, index: number, title: string): string {
  return `${aboutAskHeader(proposalShortId, index, title)}\n\n${content}`;
}
/** The same header for a reply about the proposal as a whole: what a
 *  conversation's card puts in the composer on Ask (org-staffing.md S24). */
export function aboutProposalHeader(proposalShortId: string, title: string): string {
  return `About ${proposalShortId} ("${title.replace(/"/g, "'")}"):`;
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
const number = (n: number) => n.toLocaleString("en-US");
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
 *  project or a plan by the id or title a change carries. Each answers
 *  undefined for a ref it does not know, and the ref itself stands. The
 *  server derives asks with no names at all; the page passes the tree's. */
export type OrgAskNames = {
  role?: (handle: string) => string | undefined;
  project?: (ref: string) => string | undefined;
  plan?: (ref: string) => string | undefined;
  initiative?: (ref: string) => string | undefined;
};

/** The one line a goal change reads as (I1, revised), for a person who has
 *  not read the letter: "set a goal: Win the private network, carried by
 *  Callers and Broker network, owned by @calling". The row, the derived ask,
 *  the log and the CLI walk all say it this way; names resolve through the
 *  same table the asks use, and a ref the reader's store does not know stands
 *  as written. An owner of "me" reads as "you": the card has no speaker. */
export function goalChangeSentence(c: OrgGoalChange, names?: OrgAskNames): string {
  const owner = (ref: string | undefined) => !ref ? "" : ref.trim().toLowerCase() === "me" ? "you" : ref.trim().startsWith("@") ? `@${ref.trim().slice(1)}` : names?.role?.(ref.trim().toLowerCase()) ?? ref.trim();
  const project = (ref: string) => names?.project?.(ref) ?? ref;
  const goal = (ref: string, title?: string) => title?.trim() || names?.initiative?.(ref) || ref;
  switch (c.kind) {
    case "initiative": return `set a goal: ${c.title.trim()}, carried by ${andList(c.projects.map(project))}${c.owner ? `, owned by ${owner(c.owner)}` : ""}`;
    case "initiative_projects": return `add ${andList(c.projects.map(project))} to the goal ${goal(c.initiative, c.title)}`;
    case "initiative_owner": return c.owner.trim() ? `make ${owner(c.owner)} the owner of the goal ${goal(c.initiative, c.title)}` : `the goal ${goal(c.initiative, c.title)} has no owner`;
  }
}

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
      case "trust": return `${autonomyOn(c.trust) ? "Turn on" : "Turn off"} starting work on its own for ${agent(c.handle)}`;
      case "initiative": case "initiative_projects": case "initiative_owner": { const s = goalChangeSentence(c, names); return s.charAt(0).toUpperCase() + s.slice(1); }
      default: return describeOrgChange(c);
    }
  };
  const effect = (c: OrgChange, riders: ReadonlyArray<OrgChange> = []): string => {
    switch (c.kind) {
      case "role": {
        const scope = [projects(c.scope?.projects ?? []), plans(c.scope?.plans ?? [])].filter(Boolean).join(" and ");
        const line = `reporting to ${parent(c.reports_to)}${scope ? ` and looking after ${scope}` : ""}.${tenure(c.tenure)}${riders.map(rider).join("")}`;
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
      case "initiative": return `A new goal, ${c.title.trim()}, appears on the initiatives page with ${projects(c.projects)} under it${c.owner ? ` and ${parent(c.owner)} as its owner` : " and no owner yet"}. ${c.description.trim()}`;
      case "initiative_projects": return `${projects(c.projects)} ${c.projects.length === 1 ? "counts" : "count"} toward the goal from now on, and its owner's area grows to include ${c.projects.length === 1 ? "it" : "them"}.`;
      case "initiative_owner": return `${parent(c.owner)} drives the goal from now on: its health is what ${c.owner.trim().toLowerCase() === "me" ? "you say" : "they say"}, and the goal's projects join their area.`;
      default: return describeOrgChange(c);
    }
  };
  /** Why, when the author gave no rationale: the charter or reason the
   *  change itself carries, else an honest blank that points at the control. */
  const why = (c: OrgChange): string => {
    if (c.kind === "role" && c.charter?.trim()) return c.charter.trim();
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
  const own = live.filter((c) => c.change.kind === "role" || c.change.kind === "retire" || c.change.kind === "scope" || (c.change.kind === "move" && !created.has(askHandle(c.change) ?? "")));
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
  if (records.length) out.push({
    title: `Bring ${n(records.length, "record", "records")} up to date`,
    why: "These plans, tasks and projects show as active, but the work on them is finished, was dropped, or never started.",
    effect: `${n(records.length, "record changes", "records change")} status. No work starts or stops.`,
    seqs: seqs(records),
  });
  // The goals ask: one goal change reads as its own sentence; several read as
  // a count, with each sentence inside the fold. The author's own why and
  // effect stand when a lone change carries them.
  if (goals.length) {
    const one = goals.length === 1 ? goals[0] : null;
    const sets = goals.filter((c) => c.change.kind === "initiative").length;
    out.push({
      title: one ? words.title(one.change) : `${n(sets, "goal", "goals")} to set${goals.length > sets ? `, and ${n(goals.length - sets, "change", "changes")} to the goals that exist` : ""}`,
      why: one?.rationale?.trim() || "The projects' own goals, and what the company said in its calls and threads, point at these goals; the initiatives page does not hold them yet.",
      effect: one?.expected_effect?.trim() || (one ? words.effect(one.change) : `${n(goals.length, "change", "changes")} on the initiatives page: a goal set, a project added to one, or an owner named. No work starts or stops.`),
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
    const conflict = Object.keys(row.change).find((k) => k !== "reason" && k in first.change && !same(first.change[k], row.change[k]));
    if (conflict) { errors.push(`changes[${i}] (${describeOrgChange(row.change)}) repeats changes[${hit.src}] with a different ${conflict}: one change per subject`); return; }
    const evidence = [...(first.evidence ?? []), ...(row.evidence ?? []).filter((e: any) => !(first.evidence ?? []).some((f: any) => same(e, f)))];
    out[hit.out] = {
      ...first,
      change: { ...first.change, ...row.change, ...("reason" in first.change || "reason" in row.change ? { reason: prose(first.change.reason, row.change.reason) } : {}) },
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
  if (!errors.length) errors.push(...orgSeatErrors(r.changes));
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
    case "plan_status": return `mark plan ${c.plan} ${c.status}`;
    case "task_status": return `mark task ${c.task} ${c.status}`;
    case "project_status": return `mark project ${c.project} ${c.status}`;
    case "initiative": return `create initiative ${c.title} over ${list(c.projects)}${c.owner ? ` owned by ${c.owner}` : ""}`;
    case "initiative_projects": return `initiative ${c.initiative} +${list(c.projects)}`;
    case "initiative_owner": return `initiative ${c.initiative} owner ${c.owner}`;
  }
}

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
 * addressed to the reader, in the product's own words (standing agent, area
 * of work, daily limit), never the CLI walk's command syntax
 * (describeOrgChange keeps that for the terminal). The proposal pane, the
 * chart's chips, the org log and the undo preview all say a change this way
 * (S21: the log, the proposal and the preview say one thing in one way).
 * Total: a kind this build does not know (a newer server) still reads as a
 * sentence, so a page degrades to a readable row instead of throwing.
 */
export function changeLine(change: OrgChange): string {
  const line = changeSentence(change);
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** "you" for the reader, else the parent as the change names it. */
const whoReads = (ref: string | undefined) => !ref || ref === "me" ? "you" : ref;

function changeSentence(c: OrgChange): string {
  switch (c.kind) {
    case "role": {
      const scope = [...(c.scope?.projects ?? []), ...(c.scope?.plans ?? [])];
      // A role that names a session adds nothing: the session is already there (R2).
      return `${c.seat ? `name the session ${c.seat.title?.trim() || c.seat.existing} as a role` : "add a standing agent"}, ${c.name} (${at(c.handle)}), reporting to ${whoReads(c.reports_to)}${scope.length ? `, looking after ${andList(scope)}` : ""}`;
    }
    case "projects": return c.changes.map((x) => x.op === "create" ? `create the project ${x.title}${x.horizon ? ` (${x.horizon})` : ""}` : `fold the project ${x.from} into ${x.into}`).join("; ");
    case "move": return `move ${at(c.handle)}${c.reports_to ? ` under ${whoReads(c.reports_to)}` : ""}${c.scope_add?.length ? `; now also looks after ${andList(c.scope_add)}` : ""}${c.scope_remove?.length ? `; no longer looks after ${andList(c.scope_remove)}` : ""}`;
    case "retire": return `retire ${at(c.handle)}; its sessions go back to their owners`;
    case "scope": {
      const parts: string[] = [];
      if (c.add?.length) parts.push(`also looks after ${andList(c.add)}`);
      if (c.remove?.length) parts.push(`stops looking after ${andList(c.remove)}`);
      return `${at(c.handle)} ${parts.join(" and ") || "keeps its area of work"}`;
    }
    case "budget": return `${at(c.handle)} may use up to ${capsWords(c.caps)} a day`;
    case "trust": return `${at(c.handle)} ${autonomyOn(c.trust) ? "starts work on its own" : "stops starting work on its own"}`;
    case "routine": return `${at(c.handle)} runs "${c.title}" ${everyWords(c.every)}`;
    case "project_meta": return `write the charter of ${c.project}${c.owner ? `, owned by ${at(c.owner)}` : ""}${c.priority ? `, priority ${c.priority}` : ""}${c.goal ? `: ${c.goal}` : ""}`;
    case "adopt": return `make session ${c.conversation} the standing session of ${at(c.handle)}`;
    case "authority": return `${at(c.handle)} may ${authorityWords(c.authority)}, inside the limits you set`;
    case "hire": return `hire ${at(c.handle)} from the template ${c.template} (${c.version}) to lead ${c.project}`;
    case "upgrade": return `move the instance ${c.instance} to ${c.template} ${c.to}`;
    case "file": return `put plan ${c.plan} under the project ${c.project}`;
    case "plan_status": case "task_status": case "project_status": {
      const parts = recordChangeParts(c)!;
      return parts.title ? `${parts.act}: ${parts.title} (${parts.ref})` : describeOrgChange(c);
    }
    case "initiative": case "initiative_projects": case "initiative_owner": return goalChangeSentence(c);
    default: {
      const kind = (c as { kind?: unknown }).kind;
      return `a change this version of codecast cannot show yet${typeof kind === "string" && kind ? ` ("${kind}")` : ""}`;
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
