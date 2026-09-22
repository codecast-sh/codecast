// The org log (docs/architecture/org-staffing.md S21): the typed row every
// change to the organization leaves behind, and the pure functions over it.
// A row never stores a sentence. It stores what moved (`before`, `after`),
// what the change did beyond its subject (`effects`), and the names of the
// things it mentions (`labels`), and every reader renders the sentence from
// that with the proposal page's own writers (changeLine, takeoverPhrase), so
// the log, the proposal and the undo preview say one thing in one way.
//
// The Convex writer (convex/lib/orgChangeLog.ts), the queries and the undo
// (convex/orgChanges.ts), the web History tab and `cast org log` all read
// this one file. Ids are strings here: the shared package knows no Convex.

import {
  andList,
  changeLine,
  orgChangeDependencies,
  takeoverPhrase,
  type OrgChange,
  type OrgChangeKind,
  type OrgProposalCaps,
} from "./orgProposal";

// ── The row ──────────────────────────────────────────────────────────────────

/** Kinds the proposal vocabulary does not have: a change made at a door that
 *  is not a proposal, or the inverse of a proposal kind. */
export const ORG_LOG_ONLY_KINDS = ["session", "lead", "initiative_owner", "role_edit", "restore", "unseat", "routine_stop", "project_remove"] as const;
export type OrgLogOnlyKind = (typeof ORG_LOG_ONLY_KINDS)[number];
export type OrgLogKind = OrgChangeKind | OrgLogOnlyKind;

export const ORG_LOG_DOORS = ["proposal", "settings", "chart", "project_page", "initiative", "cli", "history"] as const;
export type OrgLogDoor = (typeof ORG_LOG_DOORS)[number];

/** What the person did in one gesture. One gesture is one entry. */
export const ORG_LOG_GESTURES = ["accept_ask", "accept_all", "accept_change", "save", "drag", "command", "undo", "redo"] as const;
export type OrgLogGesture = (typeof ORG_LOG_GESTURES)[number];

export type OrgLogSubjectType = "role" | "project" | "plan" | "task" | "session" | "initiative";
export type OrgLogSubject = { type: OrgLogSubjectType; id: string; short_id?: string; label: string };

export type OrgPartyRef = { kind: "user"; user_id: string } | { kind: "role"; role_id: string };
export type OrgScopeIds = { project_ids: string[]; plan_ids: string[] };
/** Who a session reports to: its owners, and the role it is filed under. */
export type OrgSessionParent = { owner_user_ids: string[]; org_role_id?: string };

/** The fields that moved, and only those. `before` holds each as it was,
 *  `after` as it became; a key absent from both did not move. A field that
 *  went from or to nothing is `null`, never left out, so the inverse knows to
 *  clear it. */
export type OrgLogFields = {
  // A role. A hire has `status` null before and "active" after.
  status?: string | null;
  name?: string;
  handle?: string;
  avatar?: string | null;
  charter?: string | null;
  tenure?: unknown;
  review_backend?: string | null;
  reports_to?: OrgPartyRef;
  scope?: OrgScopeIds;
  caps?: OrgProposalCaps;
  trust?: string;
  /** What the role may do outside codecast (org-hire.md H4); the list as stored. */
  authority?: unknown;
  /** A hire from a template (org-hire.md): the instance the role now runs on one project. Null before. */
  instance?: { instance: string; template_id: string; version: string; project_id: string } | null;
  /** An accepted upgrade of an instance, waiting for the host step (H9). Null before, and null again when withdrawn. */
  upgrade?: { instance: string; template_id: string; to: string } | null;
  standing_session?: { conversation_id: string; short_id: string } | null;
  routine?: { agent_task_id: string; title: string; every?: string } | null;
  // A project, a plan, a task.
  owner_role_id?: string | null;
  project_id?: string | null;
  goal?: string | null;
  success_metrics?: unknown;
  priority?: string | null;
  non_goals?: unknown;
  risks?: unknown;
  /** The projects kind: what each entry of the change created or folded. */
  projects?: Array<{ op: "create"; project_id: string; title: string } | { op: "merge"; from_id: string; into_id: string }>;
  // An initiative.
  owner?: OrgPartyRef | null;
  // A session.
  parent?: OrgSessionParent;
};

/** What the change did beyond its subject. Every part is optional and every
 *  part carries what the inverse needs to put it back. */
export type OrgLogEffects = {
  /** Sessions a role took over, each with where it was. The arrays are what
   *  `takeoverPhrase(handle, effects.takeover, true)` reads. */
  takeover?: {
    role_id: string;
    handle: string;
    sessions: Array<{ conversation_id: string; short_id: string; before: OrgSessionParent }>;
    kept_in_front: string[];
    over_cap: number;
    told?: { sessions: number; deferred?: number };
  };
  /** Tasks a retire handed up the reporting line. `from` and `to` are assignee strings. */
  tasks_handed?: Array<{ task_id: string; short_id: string; from: string; to: string }>;
  /** Roles a retire moved up to its own parent. */
  children_moved?: Array<{ role_id: string; handle: string; before: OrgPartyRef }>;
  /** Sessions that left a role for their owners (a retire, or a takeover
   *  going back), each with where it was, so the inverse files it again. */
  sessions_released?: Array<{ conversation_id: string; short_id: string; before?: OrgSessionParent }>;
  /** Scope a lead or an initiative's owner gained. */
  scope_gained?: { role_id: string; handle: string; project_ids: string[]; plan_ids: string[] };
  /** Routines a seat started, or a retire stopped. */
  routines_started?: Array<{ agent_task_id: string; title: string }>;
  routines_stopped?: Array<{ agent_task_id: string; title: string }>;
  /** Tasks a plan close dropped with it. */
  tasks_closed?: Array<{ task_id: string; short_id: string; before_status: string }>;
  /** Rows a project merge moved. */
  rows_moved?: Array<{ table: "tasks" | "plans" | "docs"; id: string }>;
  /** A role seated on a session that already ran. */
  seat?: { conversation_id: string; short_id: string; previous_title?: string; kept?: boolean };
};

export type OrgLogRow = {
  _id: string;
  batch: string;
  seq: number;
  kind: OrgLogKind;
  subject: OrgLogSubject;
  before: OrgLogFields;
  after: OrgLogFields;
  effects: OrgLogEffects;
  /** The name of every id the row mentions, as it read when the row was written. */
  labels: Record<string, string>;
  /** Every role the row touches (subject or effects), for the role filter. */
  role_ids: string[];
  at: number;
  /** The row this one undoes, and the row that undid this one. */
  undoes?: string;
  undone_by?: string;
  /** A preview row only: true when the row is the inverse of a logged one. */
  inverse?: boolean;
  /** A preview row only: why it is left alone. */
  skipped?: string;
};

export type OrgLogActor = {
  user_id: string;
  name: string;
  proposal?: { short_id: string; title?: string };
  ask?: { index: number; title: string };
};

/** One entry: what a person did in one gesture, with its rows inside. */
export type OrgLogEntry = {
  _id: string;
  batch: string;
  workspace: string;
  team_id?: string;
  /** The highest row seq in the batch. */
  seq: number;
  at: number;
  door: OrgLogDoor;
  gesture: OrgLogGesture;
  actor: OrgLogActor;
  row_count: number;
  kinds: Partial<Record<OrgLogKind, number>>;
  /** The first row, so an entry of one row needs no second read. */
  lead: OrgLogRow | null;
  role_ids: string[];
  undoes?: string;
  undoes_lead?: OrgLogRow | null;
  undone_by?: { batch: string; user_id: string; name: string; at: number };
  /** The viewer could have made this change, so they may undo it. */
  may_undo: boolean;
};

export type OrgUndoPreview = {
  batch: string;
  /** The inverse rows, newest change first: what will change back. */
  will_change: OrgLogRow[];
  /** Rows whose subject changed again since: undo never overwrites those. */
  left_alone: Array<{ row: OrgLogRow; changed_by?: { batch: string; name: string; at: number } }>;
  /** Later entries that depend on this one: undone together, or not at all. */
  depends: OrgLogEntry[];
  cannot_take_back: Array<{ kind: "message_sent" | "wake_ran" | "session_worked"; count: number }>;
  /** Set when undo is not possible at all, with the reason. */
  refused?: string;
};

// ── Writing: a nested core folds into the open row ───────────────────────────

/** What one core reports about what it just wrote. */
export type OrgChangeFact = {
  kind: OrgLogKind;
  subject: OrgLogSubject;
  before?: OrgLogFields;
  after?: OrgLogFields;
  effects?: OrgLogEffects;
  labels?: Record<string, string>;
};

export type OrgOpenRow = Omit<OrgChangeFact, "subject" | "kind"> & { kind?: OrgLogKind; subject?: OrgLogSubject; before: OrgLogFields; after: OrgLogFields; effects: OrgLogEffects; labels: Record<string, string> };

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** Stable JSON: object keys sorted, so two readings of one value compare equal. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) => v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    : v) ?? "null";
}

const scopeGain = (before: OrgScopeIds | undefined, after: OrgScopeIds | undefined) => ({
  project_ids: (after?.project_ids ?? []).filter((id) => !(before?.project_ids ?? []).includes(id)),
  plan_ids: (after?.plan_ids ?? []).filter((id) => !(before?.plan_ids ?? []).includes(id)),
});

/**
 * One gesture is one row, however many cores it ran through. A project's
 * lead calls the scope cover, which calls the role update, which runs the
 * takeover, which calls the session reparent once per session: the lead's
 * row is open the whole time, and each nested core's fact folds into it.
 *
 * A fact about the row's own subject moves its fields: the first `before`
 * of a field stands (what it was when the gesture began) and the last `after`
 * wins. A fact about another subject is something the change did beyond its
 * subject, so it lands in `effects`: a session that moved joins the takeover,
 * a role whose scope grew is `scope_gained`. A row opened without a subject
 * (a hire: the role does not exist yet) takes the first fact's subject.
 */
export function mergeFact(open: OrgOpenRow, fact: OrgChangeFact): OrgOpenRow {
  const row: OrgOpenRow = { ...open, before: { ...open.before }, after: { ...open.after }, effects: { ...open.effects }, labels: { ...open.labels, ...(fact.labels ?? {}) } };
  if (!row.subject) row.subject = fact.subject;
  // A row opened without a kind (a role update: scope, or a plain edit?) is
  // named by the first fact about its own subject.
  if (!row.kind && row.subject.type === fact.subject.type && row.subject.id === fact.subject.id) row.kind = fact.kind;
  const own = row.subject.type === fact.subject.type && row.subject.id === fact.subject.id;
  if (own) {
    for (const [k, v] of Object.entries(fact.before ?? {})) if (!(k in row.before)) (row.before as any)[k] = v;
    Object.assign(row.after, fact.after ?? {});
  } else if (fact.kind === "session" && fact.before?.parent && !fact.after?.parent?.org_role_id) {
    // A session going back to its person: the takeover read backwards.
    row.effects.sessions_released = [...(row.effects.sessions_released ?? []), { conversation_id: fact.subject.id, short_id: fact.subject.short_id ?? fact.subject.label, before: fact.before.parent }];
  } else if (fact.kind === "session" && fact.before?.parent) {
    const role_id = fact.after?.parent?.org_role_id ?? "";
    const t = row.effects.takeover ?? { role_id, handle: fact.labels?.[role_id]?.replace(/^@/, "") ?? "", sessions: [], kept_in_front: [], over_cap: 0 };
    row.effects.takeover = { ...t, sessions: [...t.sessions, { conversation_id: fact.subject.id, short_id: fact.subject.short_id ?? fact.subject.label, before: fact.before.parent }] };
  } else if (fact.subject.type === "role" && (fact.before?.scope || fact.after?.scope)) {
    const gained = scopeGain(fact.before?.scope, fact.after?.scope);
    const was = row.effects.scope_gained;
    row.effects.scope_gained = {
      role_id: fact.subject.id,
      handle: fact.subject.label.replace(/^@/, ""),
      project_ids: [...(was?.project_ids ?? []), ...gained.project_ids],
      plan_ids: [...(was?.plan_ids ?? []), ...gained.plan_ids],
    };
  }
  // Effects a nested core names itself are the row's effects whoever the
  // fact was about. Lists grow; a takeover's counts are the batch form's.
  for (const [k, v] of Object.entries(fact.effects ?? {}) as Array<[keyof OrgLogEffects, any]>) {
    const had = row.effects[k] as any;
    if (Array.isArray(v)) (row.effects as any)[k] = [...(had ?? []), ...v];
    else if (k === "takeover" && had) row.effects.takeover = { ...had, ...v, sessions: had.sessions.length ? had.sessions : v.sessions };
    else (row.effects as any)[k] = v;
  }
  return row;
}

/** Drop the fields that did not move, so a save that changed nothing writes nothing. */
export function movedFields(before: OrgLogFields, after: OrgLogFields): { before: OrgLogFields; after: OrgLogFields } {
  const out = { before: {} as OrgLogFields, after: {} as OrgLogFields };
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)]) as Set<keyof OrgLogFields>) {
    if (same(before[k] ?? null, after[k] ?? null)) continue;
    (out.before as any)[k] = before[k] ?? null;
    (out.after as any)[k] = after[k] ?? null;
  }
  return out;
}

const effectCount = (e: OrgLogEffects): number =>
  (e.takeover?.sessions.length ?? 0) + (e.tasks_handed?.length ?? 0) + (e.children_moved?.length ?? 0) + (e.sessions_released?.length ?? 0)
  + (e.scope_gained ? e.scope_gained.project_ids.length + e.scope_gained.plan_ids.length : 0)
  + (e.routines_started?.length ?? 0) + (e.routines_stopped?.length ?? 0) + (e.tasks_closed?.length ?? 0) + (e.rows_moved?.length ?? 0) + (e.seat ? 1 : 0);

/** Did the row change anything? A row that moved no field and had no effect is never written. */
export function rowChangedSomething(row: { before: OrgLogFields; after: OrgLogFields; effects: OrgLogEffects }): boolean {
  return Object.keys(row.after).length > 0 || Object.keys(row.before).length > 0 || effectCount(row.effects) > 0;
}

/** Every role a row touches, for the role filter of the list and the Scope view. */
export function rowRoleIds(row: { subject?: OrgLogSubject; before: OrgLogFields; after: OrgLogFields; effects: OrgLogEffects }): string[] {
  const ids = new Set<string>();
  const party = (p: OrgPartyRef | null | undefined) => { if (p?.kind === "role") ids.add(p.role_id); };
  if (row.subject?.type === "role") ids.add(row.subject.id);
  for (const f of [row.before, row.after]) {
    party(f.reports_to); party(f.owner);
    if (f.owner_role_id) ids.add(f.owner_role_id);
    if (f.parent?.org_role_id) ids.add(f.parent.org_role_id);
  }
  const e = row.effects;
  if (e.takeover?.role_id) ids.add(e.takeover.role_id);
  if (e.scope_gained) ids.add(e.scope_gained.role_id);
  for (const c of e.children_moved ?? []) { ids.add(c.role_id); party(c.before); }
  return [...ids];
}

// ── Reading: the sentence ────────────────────────────────────────────────────

const at = (h: string) => `@${h.replace(/^@/, "")}`;
const nameOf = (row: Pick<OrgLogRow, "labels">, id: string | null | undefined, fallback = "someone") => (id && row.labels[id]) || fallback;
const partyName = (row: Pick<OrgLogRow, "labels">, p: OrgPartyRef | null | undefined) => !p ? undefined : nameOf(row, p.kind === "role" ? p.role_id : p.user_id);
const handleOf = (row: Pick<OrgLogRow, "subject" | "after" | "before">) => (row.after.handle ?? row.before.handle ?? row.subject.label).replace(/^@/, "");
const scopeNames = (row: Pick<OrgLogRow, "labels">, s: { project_ids: string[]; plan_ids: string[] }) => [...s.project_ids, ...s.plan_ids].map((id) => nameOf(row, id, id));

/**
 * The row in the proposal page's vocabulary, so `changeLine` writes its
 * sentence. Null for a kind that vocabulary does not have; `orgLogLine`
 * writes those. Works on an inverse row too: an inverse is a row.
 */
export function orgLogRowChange(row: OrgLogRow): OrgChange | null {
  const handle = row.subject.type === "role" ? handleOf(row) : "";
  const gained = scopeNames(row, scopeGain(row.before.scope, row.after.scope));
  const lost = scopeNames(row, scopeGain(row.after.scope, row.before.scope));
  switch (row.kind) {
    case "role": return {
      kind: "role", name: row.after.name ?? row.subject.label, handle,
      reports_to: partyName(row, row.after.reports_to),
      ...(row.after.scope ? { scope: { projects: row.after.scope.project_ids.map((id) => nameOf(row, id, id)), plans: row.after.scope.plan_ids.map((id) => nameOf(row, id, id)) } } : {}),
      ...(row.effects.seat ? { seat: { existing: row.effects.seat.short_id, title: row.effects.seat.previous_title } } : {}),
    };
    case "retire": return { kind: "retire", handle };
    case "move": return { kind: "move", handle, reports_to: partyName(row, row.after.reports_to), ...(gained.length ? { scope_add: gained } : {}), ...(lost.length ? { scope_remove: lost } : {}) };
    case "scope": return { kind: "scope", handle, ...(gained.length ? { add: gained } : {}), ...(lost.length ? { remove: lost } : {}) };
    case "budget": return { kind: "budget", handle, caps: row.after.caps ?? {} };
    case "trust": return { kind: "trust", handle, trust: (row.after.trust ?? "understand") as any };
    case "hire": return row.after.instance ? { kind: "hire", handle, template: row.after.instance.template_id, version: row.after.instance.version, digest: "", instance: row.after.instance.instance, project: nameOf(row, row.after.instance.project_id, "its project") } : null;
    case "upgrade": return row.after.upgrade ? { kind: "upgrade", instance: row.after.upgrade.instance, template: row.after.upgrade.template_id, to: row.after.upgrade.to, digest: "" } : null;
    case "authority": return { kind: "authority", handle, authority: ((row.after.authority as any[]) ?? []).map((g) => ({ id: g.id, kind: g.kind, label: g.label, ...(g.scope ? { scope: g.scope } : {}), ...(g.limit ? { limit: g.limit } : {}) })) };
    case "routine": return { kind: "routine", handle, title: row.after.routine?.title ?? "", prompt: "", every: row.after.routine?.every ?? "" };
    case "adopt": return { kind: "adopt", handle, conversation: row.after.standing_session?.short_id ?? row.effects.seat?.short_id ?? "" };
    case "file": return { kind: "file", plan: row.subject.short_id ?? row.subject.label, project: nameOf(row, row.after.project_id, "no project") };
    // The subject's label is the record's title (recordSubject), so the log
    // reads the row the way the proposal did: "Mark done: Launch (pl-7)".
    case "plan_status": return { kind: "plan_status", plan: row.subject.short_id ?? row.subject.label, status: row.after.status as any, reason: "", title: row.subject.label };
    case "task_status": return { kind: "task_status", task: row.subject.short_id ?? row.subject.label, status: row.after.status as any, reason: "", title: row.subject.label };
    case "project_status": return { kind: "project_status", project: row.subject.label, status: row.after.status as any, reason: "" };
    case "project_meta": return {
      kind: "project_meta", project: row.subject.label,
      ...(row.after.owner_role_id ? { owner: nameOf(row, row.after.owner_role_id) } : {}),
      ...(row.after.priority ? { priority: row.after.priority as any } : {}),
      ...(row.after.goal ? { goal: row.after.goal } : {}),
    };
    case "projects": return {
      kind: "projects",
      changes: (row.after.projects ?? []).map((p) => p.op === "create" ? { op: "create" as const, title: p.title } : { op: "merge" as const, from: nameOf(row, p.from_id, p.from_id), into: nameOf(row, p.into_id, p.into_id) }),
    };
    default: return null;
  }
}

const EDIT_WORDS: Partial<Record<keyof OrgLogFields, string>> = { name: "name", handle: "handle", avatar: "face", charter: "charter", tenure: "tenure", review_backend: "reviewer", status: "status" };

/** The sentence of a kind the proposal vocabulary does not have. */
function logOnlySentence(row: OrgLogRow): string {
  switch (row.kind as OrgLogOnlyKind) {
    case "session": {
      const p = row.after.parent;
      const to = p?.org_role_id ? nameOf(row, p.org_role_id) : andList((p?.owner_user_ids ?? []).map((id) => nameOf(row, id))) || "nobody";
      return `session ${row.subject.label} now reports to ${to}`;
    }
    case "lead": return row.after.owner_role_id ? `${nameOf(row, row.after.owner_role_id)} now leads the project ${row.subject.label}` : `the project ${row.subject.label} has no lead`;
    case "initiative_owner": { const who = partyName(row, row.after.owner); return who ? `${who} now owns the initiative ${row.subject.label}` : `the initiative ${row.subject.label} has no owner`; }
    case "role_edit": { const words = (Object.keys(row.after) as Array<keyof OrgLogFields>).map((k) => EDIT_WORDS[k]).filter(Boolean) as string[]; return `change the ${andList(words) || "settings"} of ${at(handleOf(row))}`; }
    case "restore": return `bring back ${at(handleOf(row))}, with its area of work, its limits and its routines`;
    case "unseat": return `${at(handleOf(row))} gives up its standing session${row.before.standing_session ? ` ${row.before.standing_session.short_id}` : ""}; the session keeps running under its person`;
    case "routine_stop": return `${at(handleOf(row))} stops running "${row.before.routine?.title ?? ""}"`;
    case "project_remove": return `remove the project ${row.subject.label}`;
  }
}

/** The one sentence a row reads as: the History tab, a role's Scope view,
 *  the undo preview and `cast org log` all print this. Total, like changeLine. */
export function orgLogLine(row: OrgLogRow): string {
  const change = orgLogRowChange(row);
  if (change) return changeLine(change);
  // A hire and an upgrade are recorded; their way back is the host step
  // (org-staffing.md S21), so the inverse row says what the undo did do.
  if (row.kind === "hire") return `Take back the hire of ${at(handleOf(row))}${row.before.instance ? ` as ${row.before.instance.instance}` : ""}: the project lead goes back, and the instance waits for the host step`;
  if (row.kind === "upgrade") return `Withdraw the upgrade of ${row.before.upgrade?.instance ?? "the instance"}${row.before.upgrade ? ` to ${row.before.upgrade.template_id} ${row.before.upgrade.to}` : ""} before the host step runs it`;
  const line = (ORG_LOG_ONLY_KINDS as readonly string[]).includes(row.kind) ? logOnlySentence(row) : null;
  if (!line) return changeLine({ kind: row.kind } as any);
  return line.charAt(0).toUpperCase() + line.slice(1);
}

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** What the change did beyond its subject, one line per effect, for the fold
 *  under an entry. On an inverse row the same effects read as going back. */
export function orgLogEffectLines(row: OrgLogRow): string[] {
  const e = row.effects;
  const back = !!row.inverse;
  const out: string[] = [];
  if (e.takeover?.sessions.length) out.push(back ? `${n(e.takeover.sessions.length, "session")} ${e.takeover.sessions.length === 1 ? "goes" : "go"} back to where ${e.takeover.sessions.length === 1 ? "it was" : "they were"}` : takeoverPhrase(e.takeover.handle, e.takeover, true));
  if (e.seat) out.push(back ? `session ${e.seat.short_id} keeps running under its person` : `session ${e.seat.short_id} is its standing session`);
  if (e.scope_gained) { const c = e.scope_gained.project_ids.length + e.scope_gained.plan_ids.length; if (c) out.push(`${at(e.scope_gained.handle)} ${back ? "stops looking after" : "also looks after"} ${andList([...e.scope_gained.project_ids, ...e.scope_gained.plan_ids].map((id) => nameOf(row, id, id)))}`); }
  if (e.tasks_handed?.length) out.push(back ? `${n(e.tasks_handed.length, "task")} come back to it` : `${n(e.tasks_handed.length, "open task")} handed up to ${andList([...new Set(e.tasks_handed.map((t) => nameOf(row, t.to, t.to)))])}`);
  if (e.children_moved?.length) out.push(`${n(e.children_moved.length, "role")} ${back ? "report to it again" : "moved up to its parent"}`);
  if (e.sessions_released?.length) out.push(`${n(e.sessions_released.length, "session")} ${back ? "filed under it again" : "went back to their owners"}`);
  if (e.routines_started?.length) out.push(`${n(e.routines_started.length, "routine")} ${back ? "stopped" : "started"}`);
  if (e.routines_stopped?.length) out.push(`${n(e.routines_stopped.length, "routine")} ${back ? "started again" : "stopped"}`);
  if (e.tasks_closed?.length) out.push(`${n(e.tasks_closed.length, "open task")} ${back ? "reopened" : "dropped with it"}`);
  if (e.rows_moved?.length) out.push(`${n(e.rows_moved.length, "record")} moved ${back ? "back" : "with it"}`);
  return out.filter(Boolean);
}

// ── The way back ─────────────────────────────────────────────────────────────

/** The kind a row's inverse reads as. A kind that restores fields is its own
 *  inverse; a kind that makes or ends something pairs with its opposite. */
export const ORG_INVERSE_KIND: Record<OrgLogKind, OrgLogKind> = {
  role: "retire", retire: "restore", restore: "retire",
  adopt: "unseat", unseat: "adopt",
  routine: "routine_stop", routine_stop: "routine",
  projects: "project_remove", project_remove: "projects",
  move: "move", scope: "scope", budget: "budget", trust: "trust", role_edit: "role_edit",
  lead: "lead", initiative_owner: "initiative_owner", session: "session",
  file: "file", project_meta: "project_meta", plan_status: "plan_status", task_status: "task_status", project_status: "project_status",
  // Hiring from a template (org-hire.md): authority restores its list; a hire
  // and an upgrade are recorded, and their way back is the host step.
  authority: "authority", hire: "hire", upgrade: "upgrade",
};

/**
 * The inverse of a row, as a row: the same subject, `before` and `after`
 * swapped, the kind its opposite, and the effects kept as the list of what
 * goes back. The preview renders it with `orgLogLine`, and the undo applies
 * it through the cores. Inverting twice gives the row back.
 */
export function invertRow(row: OrgLogRow): OrgLogRow {
  const { undone_by: _u, skipped: _s, ...rest } = row;
  return { ...rest, kind: ORG_INVERSE_KIND[row.kind] ?? row.kind, before: row.after, after: row.before, inverse: !row.inverse, undoes: row._id };
}

/**
 * May this row's inverse apply? Undo never overwrites a later decision: every
 * field the row moved must still read as the row left it. `current` holds the
 * subject's fields as they stand now (the same keys as `row.after`), or null
 * when the subject is gone.
 */
export function undoVerdict(row: OrgLogRow, current: OrgLogFields | null): { apply: true } | { apply: false; reason: string } {
  if (!current) return { apply: false, reason: "it no longer exists" };
  const moved = (Object.keys(row.after) as Array<keyof OrgLogFields>).filter((k) => !same(current[k] ?? null, row.after[k] ?? null));
  if (moved.length === 0) return { apply: true };
  return { apply: false, reason: `its ${andList(moved.map((k) => EDIT_WORDS[k] ?? String(k).replace(/_/g, " ")))} changed after this` };
}

/** "3 of 100 records were changed after this and stay as they are". */
export function leftAloneLine(left: number, total: number): string {
  if (left === 0) return "";
  return `${left} of ${n(total, "record")} ${left === 1 ? "was" : "were"} changed after this and ${left === 1 ? "stays as it is" : "stay as they are"}`;
}

/** What an entry brought into being: undoing it takes these away, so a later
 *  entry that touches one of them cannot be left standing. */
function createdBy(rows: ReadonlyArray<OrgLogRow>): Set<string> {
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.kind === "role" || r.kind === "restore") ids.add(r.subject.id);
    if (r.kind === "projects") for (const p of r.after.projects ?? []) if (p.op === "create") ids.add(p.project_id);
    if (r.kind === "adopt" && r.after.standing_session) ids.add(r.after.standing_session.conversation_id);
  }
  return ids;
}

const mentions = (row: OrgLogRow): string[] => [
  row.subject.id, ...row.role_ids,
  ...(row.after.scope?.project_ids ?? []), ...(row.after.project_id ? [row.after.project_id] : []),
  ...(row.effects.scope_gained?.project_ids ?? []),
];

/**
 * The later entries that depend on this one, each with the reason: the
 * proposal page's rule (`orgChangeDependencies`) read backwards. There, a
 * routine needs the adopt that seats its session and an adopt needs the role
 * it seats; here, a later entry needs this one when it touches something this
 * one created (the role a hire made, the project a change created, the seat
 * an adopt gave). The person undoes them together, or not at all. Entries
 * already undone, and the undo of this entry, are never dependents.
 */
export function dependentBatches(target: { batch: string; rows: ReadonlyArray<OrgLogRow> }, later: ReadonlyArray<{ batch: string; undoes?: string; undone: boolean; rows: ReadonlyArray<OrgLogRow> }>): Array<{ batch: string; reason: string }> {
  const out: Array<{ batch: string; reason: string }> = [];
  const held = createdBy(target.rows);
  // Dependents of dependents come along: what a later entry created is held too.
  for (const entry of later) {
    if (entry.undone || entry.undoes === target.batch) continue;
    const hit = entry.rows.find((r) => mentions(r).some((id) => held.has(id)));
    // The proposal rule names the pairs a handle ties together (a role and
    // its adopt, an adopt and its routine) even where no id is shared yet.
    const changes = [...target.rows, ...entry.rows].map((r, i) => ({ seq: i, row: r, change: orgLogRowChange(r) })).filter((x): x is { seq: number; row: OrgLogRow; change: OrgChange } => !!x.change);
    const tied = Object.keys(orgChangeDependencies(changes)).map(Number).map((seq) => changes.find((c) => c.seq === seq)!).find((c) => c.row.batch === entry.batch);
    const because = hit ?? tied?.row;
    if (!because) continue;
    out.push({ batch: entry.batch, reason: `${orgLogLine(because)}: it needs what this entry made` });
    for (const id of createdBy(entry.rows)) held.add(id);
  }
  return out;
}

/** The entry's one sentence: its ask or proposal when it has one, else its
 *  first row, with the count of rows inside ("Accepted "Close the plans the
 *  work has already passed": 100 records"). */
export function orgLogEntryLine(entry: Pick<OrgLogEntry, "gesture" | "actor" | "row_count" | "lead" | "undoes_lead">): string {
  const records = entry.row_count > 1 ? `: ${n(entry.row_count, "record")}` : "";
  const first = entry.lead ? orgLogLine(entry.lead) : "";
  if (entry.gesture === "undo") return entry.undoes_lead ? `Undid "${orgLogLine(entry.undoes_lead)}"${records}` : `Undid a change${records}`;
  if (entry.gesture === "redo") return `Applied again "${first}"${records}`;
  if (entry.actor.ask) return `Accepted "${entry.actor.ask.title}"${records}`;
  if (entry.gesture === "accept_all" && entry.actor.proposal) return `Accepted all of ${entry.actor.proposal.title ? `"${entry.actor.proposal.title}"` : entry.actor.proposal.short_id}${records}`;
  return entry.row_count > 1 ? `${first}, and ${n(entry.row_count - 1, "more change")}` : first;
}
