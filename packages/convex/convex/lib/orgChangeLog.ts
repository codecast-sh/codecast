// The writer of the org log (docs/architecture/org-staffing.md S21). Every
// change to the organization goes through a few cores, and each core reports
// what it wrote here, inside its own transaction, so a change and its log row
// land together or not at all.
//
// One gesture is one row however many cores it ran through: the outermost
// core opens the row (`withOrgChange`), and what a nested core reports
// (`noteOrgChange`) folds into it (contracts/orgChange `mergeFact`). A core
// called on its own, with no row open, writes a row of its own, so no door
// can forget the log. The open row and the open batch ride the mutation's
// ctx under a symbol, the way the org wake rail's actor does (orgEvents).

import type { Id } from "../_generated/dataModel";
import {
  mergeFact,
  movedFields,
  rowChangedSomething,
  rowRoleIds,
  type OrgChangeFact,
  type OrgLogDoor,
  type OrgLogFields,
  type OrgLogGesture,
  type OrgLogKind,
  type OrgLogSubject,
  type OrgOpenRow,
  type OrgPartyRef,
  type OrgSessionParent,
} from "@codecast/shared/contracts/orgChange";
import { personName } from "../sessionOwnership";
import { computeWorkspaceKey } from "./access";
import { capsFor, trustOf } from "../orgEvents";
import { listSessionOwnerIds } from "../sessionOwners";

type Ctx = { db: any };

/** ACCESS and ROUTING of a log row, written once (CLAUDE.md "Workspace access
 *  vs routing"): `workspace` is the key readers are matched against, `team_id`
 *  only says which team's surfaces the entry flows to. */
export type OrgLogWhere = { workspace: string; team_id?: Id<"teams"> };

export type OrgBatchHead = {
  door: OrgLogDoor;
  gesture: OrgLogGesture;
  proposal?: { id: Id<"org_proposals">; short_id: string; title?: string };
  ask?: { index: number; title: string };
  /** Names a gesture that spans transactions (an accept all), so each finds the same batch. */
  key?: string;
  undoes?: Id<"org_change_batches">;
};

type State = {
  head?: OrgBatchHead;
  batchId?: Id<"org_change_batches">;
  open?: OrgOpenRow & { undoes?: Id<"org_changes">; where?: OrgLogWhere };
  seq: Map<string, number>;
};

const LOG = Symbol.for("codecast.orgChangeLog");
const stateOf = (ctx: any): State => (ctx[LOG] ??= { seq: new Map() });

/** A role's boundary is its access key: a team role is the team's, a personal role its owner's. */
export function whereOfRole(role: { team_id?: any; scope_user_id?: any; host_user_id?: any }): OrgLogWhere {
  return role.team_id ? { workspace: `team:${role.team_id}`, team_id: role.team_id } : { workspace: `user:${role.scope_user_id ?? role.host_user_id}` };
}
/** A boundary the apply core carries (orgInit `Boundary`). */
export function whereOfBoundary(boundary: { team_id?: any; scope_user_id?: any }, userId: Id<"users">): OrgLogWhere {
  return boundary.team_id ? { workspace: `team:${boundary.team_id}`, team_id: boundary.team_id } : { workspace: `user:${boundary.scope_user_id ?? userId}` };
}
/** A session's log rows are readable where the session is: the team when it
 *  is visible to its team, else its owner alone (the one writer of that rule). */
export function whereOfSession(conversation: { user_id: any; team_id?: any; is_private?: boolean; auto_shared?: boolean; team_visibility?: string }): OrgLogWhere {
  const workspace = computeWorkspaceKey(conversation, conversation);
  return { workspace, team_id: workspace.startsWith("team:") ? conversation.team_id : undefined };
}
/** A row that stores its own key (a project, a plan, a task, an initiative). */
export function whereOfRecord(record: { workspace?: string; team_id?: any; user_id?: any }): OrgLogWhere {
  return { workspace: record.workspace ?? (record.team_id ? `team:${record.team_id}` : `user:${record.user_id}`), team_id: record.team_id ?? undefined };
}

// ── Subjects and labels ──────────────────────────────────────────────────────

export const roleSubject = (role: any): OrgLogSubject => ({ type: "role", id: String(role._id), short_id: role.short_id, label: `@${role.handle}` });
export const sessionSubject = (c: any): OrgLogSubject => { const short = c.short_id ?? String(c._id).slice(0, 7); return { type: "session", id: String(c._id), short_id: short, label: short }; };
export const recordSubject = (type: "project" | "plan" | "task" | "initiative", r: any): OrgLogSubject => ({ type, id: String(r._id), short_id: r.short_id, label: r.title ?? r.short_id ?? String(r._id) });

export const partyRef = (p: any): OrgPartyRef | undefined => !p ? undefined : p.kind === "role" ? { kind: "role", role_id: String(p.role_id) } : { kind: "user", user_id: String(p.user_id) };
export const scopeRef = (scope: any) => ({ project_ids: (scope?.project_ids ?? []).map(String), plan_ids: (scope?.plan_ids ?? []).map(String) });

/** The name of each id as the product shows it now. A row keeps these so its
 *  sentence still reads after the thing is renamed or gone. */
export async function labelsOf(ctx: Ctx, ids: Array<string | null | undefined | false>, read: (id: any) => Promise<any> = (id) => ctx.db.get(id)): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const id of new Set(ids.filter(Boolean) as string[])) {
    let doc: any = null;
    try { doc = await read(id); } catch { doc = null; }
    if (!doc) continue;
    out[id] = doc.handle && doc.reports_to ? `@${doc.handle}`
      : doc.email !== undefined || doc.github_username !== undefined ? personName(doc)
      : doc.goal !== undefined && doc.short_id ? doc.short_id
      : doc.title ?? doc.short_id ?? doc.name ?? id;
  }
  return out;
}

/** Who a session reports to, as the log stores it. */
export async function sessionParent(ctx: Ctx, conversation: { _id: any; org_role_id?: any }): Promise<OrgSessionParent> {
  const owners = (await listSessionOwnerIds(ctx as any, conversation._id)).map(String);
  return { owner_user_ids: owners, ...(conversation.org_role_id ? { org_role_id: String(conversation.org_role_id) } : {}) };
}

// ── The batch: what a person did in one gesture ──────────────────────────────

/** A door names its gesture before it calls a core. Rows written in this
 *  transaction then land in one entry. The batch row is created with its
 *  first row, so a gesture that changed nothing leaves no entry. */
export function openOrgBatch(ctx: any, head: OrgBatchHead): void {
  const s = stateOf(ctx);
  s.head = head;
  s.batchId = undefined;
}

/** The batch this transaction is writing into, when a row has landed. */
export const openBatchId = (ctx: any): Id<"org_change_batches"> | undefined => stateOf(ctx).batchId;

async function batchFor(ctx: any, userId: Id<"users">, where: OrgLogWhere, fallback: { door: OrgLogDoor; gesture: OrgLogGesture }, now: number): Promise<Id<"org_change_batches">> {
  const s = stateOf(ctx);
  if (s.batchId) return s.batchId;
  const head: OrgBatchHead = s.head ?? fallback;
  if (head.key) {
    const found = await ctx.db.query("org_change_batches").withIndex("by_key", (q: any) => q.eq("workspace", where.workspace).eq("key", head.key)).first();
    if (found) return (s.batchId = found._id);
  }
  s.batchId = await ctx.db.insert("org_change_batches", {
    user_id: userId,
    team_id: where.team_id,
    workspace: where.workspace,
    door: head.door,
    gesture: head.gesture,
    proposal: head.proposal,
    ask: head.ask,
    key: head.key,
    seq: 0,
    row_count: 0,
    kinds: {},
    role_ids: [],
    undoes: head.undoes,
    created_at: now,
    updated_at: now,
  });
  return s.batchId!;
}

async function nextSeq(ctx: any, workspace: string): Promise<number> {
  const s = stateOf(ctx);
  let last = s.seq.get(workspace);
  if (last === undefined) {
    const newest = await ctx.db.query("org_changes").withIndex("by_workspace_seq", (q: any) => q.eq("workspace", workspace)).order("desc").first();
    last = newest?.seq ?? 0;
  }
  s.seq.set(workspace, last! + 1);
  return last! + 1;
}

async function writeRow(ctx: any, userId: Id<"users">, where: OrgLogWhere, row: OrgOpenRow & { undoes?: Id<"org_changes"> }, fallback: { door: OrgLogDoor; gesture: OrgLogGesture }): Promise<Id<"org_changes"> | null> {
  if (!row.subject || !row.kind || !rowChangedSomething(row)) return null;
  const now = Date.now();
  const batch = await batchFor(ctx, userId, where, fallback, now);
  const seq = await nextSeq(ctx, where.workspace);
  const role_ids = rowRoleIds(row);
  const id: Id<"org_changes"> = await ctx.db.insert("org_changes", {
    batch,
    user_id: userId,
    team_id: where.team_id,
    workspace: where.workspace,
    seq,
    kind: row.kind,
    subject: row.subject,
    before: row.before,
    after: row.after,
    effects: row.effects,
    labels: row.labels,
    role_ids,
    undoes: row.undoes,
    created_at: now,
  });
  if (row.undoes) await ctx.db.patch(row.undoes, { undone_by: id });
  const head = await ctx.db.get(batch);
  await ctx.db.patch(batch, {
    seq,
    row_count: (head?.row_count ?? 0) + 1,
    kinds: { ...(head?.kinds ?? {}), [row.kind]: (head?.kinds?.[row.kind] ?? 0) + 1 },
    role_ids: [...new Set([...(head?.role_ids ?? []), ...role_ids])],
    lead_row_id: head?.lead_row_id ?? id,
    updated_at: now,
  });
  return id;
}

// ── What a core calls ────────────────────────────────────────────────────────

export type OrgChangeHead = {
  /** Absent when the core learns it from what moved (a role update). */
  kind?: OrgLogKind;
  /** Absent for a hire: the role does not exist yet, and the first fact names it. */
  subject?: OrgLogSubject;
  /** The door and gesture when no door opened a batch first. */
  door?: OrgLogDoor;
  gesture?: OrgLogGesture;
  /** The logged row this change is the inverse of (undo, redo). */
  undoes?: Id<"org_changes">;
};

const fallbackOf = (h: { door?: OrgLogDoor; gesture?: OrgLogGesture }) => ({ door: h.door ?? "settings" as const, gesture: h.gesture ?? "save" as const });

/**
 * Run a change as ONE row. The outermost call opens the row and writes it
 * when `run` returns; a call made while a row is open only runs, and what its
 * cores report folds into the open row. A throw writes nothing (the
 * transaction is discarded with it) and closes the row.
 */
export async function withOrgChange<T>(ctx: any, userId: Id<"users">, head: OrgChangeHead, run: () => Promise<T>): Promise<T> {
  const s = stateOf(ctx);
  if (s.open) return run();
  s.open = { kind: head.kind, subject: head.subject, before: {}, after: {}, effects: {}, labels: {}, undoes: head.undoes };
  try {
    const result = await run();
    // The row lands where its first fact said: the boundary of what changed.
    if (s.open.where) await writeRow(ctx, userId, s.open.where, s.open, fallbackOf(head));
    return result;
  } finally {
    s.open = undefined;
  }
}

/** A core reports what it just wrote: folded into the open row, or a row of its own. */
export async function noteOrgChange(ctx: any, userId: Id<"users">, where: OrgLogWhere, fact: OrgChangeFact & { door?: OrgLogDoor; gesture?: OrgLogGesture }): Promise<void> {
  const s = stateOf(ctx);
  const { door, gesture, ...rest } = fact;
  if (s.open) { s.open = { ...mergeFact(s.open, rest), undoes: s.open.undoes, where: s.open.where ?? where }; return; }
  await writeRow(ctx, userId, where, mergeFact({ kind: fact.kind, before: {}, after: {}, effects: {}, labels: {} }, rest), fallbackOf({ door, gesture }));
}

/** True while a row is open, so a core can tell it runs inside another core's gesture. */
export const orgChangeIsOpen = (ctx: any): boolean => !!stateOf(ctx).open;

// ── A role as the log reads it ───────────────────────────────────────────────

/** Every field of a role a change can move, in the log's shape. A core reads
 *  it before and after its write and reports `movedFields` of the two; the
 *  undo reads it to see whether a row's fields still stand. */
export function roleLogFields(role: any): OrgLogFields {
  return {
    status: role.status ?? null,
    name: role.name,
    handle: role.handle,
    avatar: role.avatar ?? null,
    charter: role.charter ?? null,
    tenure: role.tenure ?? null,
    review_backend: role.review_backend ?? null,
    reports_to: partyRef(role.reports_to),
    scope: scopeRef(role.scope),
    caps: capsFor(role),
    trust: trustOf(role),
  };
}

/** The ids a role's fields mention, for `labelsOf`. */
export function roleFieldIds(f: OrgLogFields): string[] {
  return [...(f.scope?.project_ids ?? []), ...(f.scope?.plan_ids ?? []), ...(f.reports_to ? [f.reports_to.kind === "role" ? f.reports_to.role_id : f.reports_to.user_id] : [])];
}

/** A role core reports its write: the role as it was (null for a hire) and as it is. */
export async function noteRoleChange(ctx: any, userId: Id<"users">, kind: OrgLogKind, was: any | null, now: any, extra: Pick<OrgChangeFact, "effects"> & { door?: OrgLogDoor; gesture?: OrgLogGesture } = {}): Promise<void> {
  const moved = movedFields(was ? roleLogFields(was) : { status: null }, roleLogFields(now));
  await noteOrgChange(ctx, userId, whereOfRole(now), {
    kind,
    subject: roleSubject(now),
    ...moved,
    labels: await labelsOf(ctx, [String(now._id), ...roleFieldIds(moved.before), ...roleFieldIds(moved.after)]),
    ...extra,
  });
}
