import { v } from "convex/values";
import { mutation, query } from "./functions";
import type { Id } from "./_generated/dataModel";
import { getAuthenticatedUserId } from "./pendingMessages";
import { workspaceGrantsAccess } from "./lib/access";
import { roleByHandleForRead, rolesInBoundary, userCanAdminRole } from "./lib/orgAccess";
import { checkConversationAccess } from "./privacy";
import { personName, performReparentSession } from "./sessionOwnership";
import { refuseUnlessHuman, performReparentRole, performSetCaps, performSetTrust, performUpdateRole } from "./orgRoles";
import { removeSessionOwnerRow, syncPrimaryOwnerCache } from "./sessionOwners";
import { patchTask } from "./agentTasks";
import { recalcPlanProgress } from "./tasks";
import { setTaskStatus } from "./orgInit";
import { scopeOutside, scopeIds } from "./lib/orgScope";
import { enqueueRoleEvent } from "./orgEvents";
import { noteOrgChange, openOrgBatch, openBatchId, sessionParent, withOrgChange, type OrgWrite } from "./lib/orgChangeLog";
import { canonical, dependentBatches, invertRow, type OrgLogEntry, type OrgLogRow, type OrgUndoPreview } from "@codecast/shared/contracts/orgChange";

type Ctx = { db: any; auth?: any };
type StoredRow = OrgLogRow & { workspace: string; writes?: OrgWrite[]; created_at: number };
type Step = { row: StoredRow; inverse: OrgLogRow; writes: OrgWrite[]; parent?: NonNullable<OrgLogRow["before"]["parent"]> };
const CAP = 1000;
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const fieldsMatch = (doc: any, fields: Record<string, any>) => !!doc && Object.entries(fields).every(([key, value]) => same(doc[key] ?? null, value));
const patchOf = (fields: Record<string, any>) => Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value === null ? undefined : value]));

function publicRow(row: any): OrgLogRow {
  const { _id, batch, seq, kind, subject, before, after, effects, labels, role_ids, undoes, undone_by } = row;
  return { _id, batch, seq, kind, subject, before: { ...before }, after: { ...after }, effects: { ...effects }, labels, role_ids, at: row.created_at, ...(undoes ? { undoes } : {}), ...(undone_by ? { undone_by } : {}) };
}

async function rowsOf(ctx: Ctx, batch: string): Promise<StoredRow[]> {
  return (await ctx.db.query("org_changes").withIndex("by_batch", (q: any) => q.eq("batch", batch)).take(CAP + 1)).sort((a: any, b: any) => a.seq - b.seq);
}

async function requireBatch(ctx: Ctx, userId: Id<"users">, ref: string): Promise<any> {
  const id = ctx.db.normalizeId("org_change_batches", ref);
  const batch = id ? await ctx.db.get(id) : null;
  if (!batch || !(await workspaceGrantsAccess(ctx, userId, batch.workspace))) throw new Error("Org history entry not found");
  return batch;
}

async function mayChangeRow(ctx: Ctx, userId: Id<"users">, row: any): Promise<boolean> {
  if (!(await workspaceGrantsAccess(ctx, userId, row.workspace))) return false;
  if (row.subject.type === "role") return userCanAdminRole(ctx, userId, await ctx.db.get(row.subject.id));
  if (row.subject.type === "session") {
    const c = await ctx.db.get(row.subject.id);
    if (!c) return false;
    const access = await checkConversationAccess(ctx, userId, c);
    if (access !== "owner" && access !== "team") return false;
    const roleId = row.before.parent?.org_role_id ?? row.after.parent?.org_role_id;
    return !roleId || access === "owner" || userCanAdminRole(ctx, userId, await ctx.db.get(roleId));
  }
  const record = await ctx.db.get(row.subject.id);
  return !!record && record.workspace === row.workspace;
}

async function entryOf(ctx: Ctx, userId: Id<"users">, batch: any): Promise<OrgLogEntry> {
  const lead = batch.lead_row_id ? await ctx.db.get(batch.lead_row_id) : null;
  const actor = await ctx.db.get(batch.user_id);
  const undone = batch.undone_by;
  const target = batch.gesture === "undo" && batch.undoes ? await ctx.db.get(batch.undoes) : null;
  const targetLead = target?.workspace === batch.workspace && target.lead_row_id ? await ctx.db.get(target.lead_row_id) : null;
  return {
    _id: String(batch._id), batch: String(batch._id), workspace: batch.workspace, ...(batch.team_id ? { team_id: String(batch.team_id) } : {}),
    seq: batch.seq, at: batch.created_at, door: batch.door, gesture: batch.gesture,
    actor: { user_id: String(batch.user_id), name: personName(actor ?? {}), ...(batch.proposal ? { proposal: batch.proposal } : {}), ...(batch.ask ? { ask: batch.ask } : {}) },
    row_count: batch.row_count, kinds: batch.kinds, lead: lead ? publicRow(lead) : null, role_ids: batch.role_ids,
    ...(batch.undoes ? { undoes: String(batch.undoes) } : {}),
    ...(batch.gesture === "undo" ? { undoes_lead: targetLead?.workspace === batch.workspace ? publicRow(targetLead) : null } : {}),
    ...(undone ? { undone_by: { ...undone, name: personName((await ctx.db.get(undone.user_id)) ?? {}) } } : {}),
    may_undo: !!lead && await mayChangeRow(ctx, userId, lead),
  };
}

export async function listEntries(ctx: Ctx, userId: Id<"users">, args: { team_id?: Id<"teams">; role?: string; since?: number; before?: number; limit?: number }) {
  const workspace = args.team_id ? `team:${args.team_id}` : `user:${userId}`;
  if (!(await workspaceGrantsAccess(ctx, userId, workspace))) return null;
  let role: any = null;
  if (args.role) {
    const boundary = args.team_id ? { team_id: args.team_id } : { scope_user_id: userId };
    role = await roleByHandleForRead(ctx, boundary, args.role);
    if (!role) {
      const id = ctx.db.normalizeId("org_roles", args.role);
      role = id ? await ctx.db.get(id) : await ctx.db.query("org_roles").withIndex("by_short_id", (q: any) => q.eq("short_id", args.role)).first();
    }
    if (!role) return { entries: [], has_more: false };
  }
  const limit = Math.max(1, Math.min(100, Math.floor(args.limit ?? 50)));
  const q = ctx.db.query("org_change_batches").withIndex("by_workspace", (q: any) => {
    let range = q.eq("workspace", workspace);
    if (args.since !== undefined) range = range.gte("created_at", args.since);
    if (args.before !== undefined) range = range.lt("created_at", args.before);
    return range;
  }).order("desc");
  const rows = await (role ? ctx.db.query("org_change_batches").withIndex("by_workspace", (q: any) => q.eq("workspace", workspace)).order("desc").take(CAP) : q.take(limit + 1));
  const selected = rows.filter((b: any) => (!role || b.role_ids.includes(String(role._id))) && (args.since === undefined || b.created_at >= args.since) && (args.before === undefined || b.created_at < args.before));
  return { entries: await Promise.all(selected.slice(0, limit).map((b: any) => entryOf(ctx, userId, b))), has_more: selected.length > limit };
}

export async function getEntry(ctx: Ctx, userId: Id<"users">, ref: string) {
  const batch = await requireBatch(ctx, userId, ref);
  const rows = await rowsOf(ctx, batch._id);
  if (rows.length > CAP) throw new Error("This entry is too large to open at once");
  return { entry: await entryOf(ctx, userId, batch), rows: rows.filter((r) => r.workspace === batch.workspace).map(publicRow) };
}

async function mayWrite(ctx: Ctx, userId: Id<"users">, workspace: string, write: OrgWrite, doc: any): Promise<boolean> {
  if (!doc) return false;
  if (write.table === "org_roles") return userCanAdminRole(ctx, userId, doc);
  if (write.table === "conversations") {
    const access = await checkConversationAccess(ctx, userId, doc);
    return access === "owner" || access === "team";
  }
  if (write.table === "agent_tasks") {
    const c = doc.originating_conversation_id ? await ctx.db.get(doc.originating_conversation_id) : null;
    return String(doc.user_id) === String(userId) || !!c && ["owner", "team"].includes(await checkConversationAccess(ctx, userId, c));
  }
  if (write.table === "anchors") return userCanAdminRole(ctx, userId, doc);
  if (write.table === "users") return !!doc.is_bot;
  return doc.workspace === workspace;
}

async function validateRestoredRoles(ctx: Ctx, writes: OrgWrite[], read: (id: string) => Promise<any>) {
  const roles = new Map<string, any>();
  for (const w of writes) {
    if (w.table !== "org_roles") continue;
    const restored = await read(w.id);
    if (!restored) continue;
    for (const r of [...await rolesInBoundary(ctx, restored), restored]) roles.set(String(r._id), await read(r._id));
  }
  const handles = new Set<string>();
  for (const role of roles.values()) {
    if (!role || role.status === "retired") continue;
    const handle = `${role.team_id ?? role.scope_user_id}:${role.handle}`;
    if (handles.has(handle)) return `Cannot restore @${role.handle}: that handle is now taken`;
    handles.add(handle);
    const seen = new Set<string>([String(role._id)]);
    let parent = role.reports_to;
    while (parent?.kind === "role") {
      if (seen.has(String(parent.role_id))) return "Cannot undo: the reporting line would form a cycle";
      seen.add(String(parent.role_id));
      const r = await read(parent.role_id);
      if (!r || r.status === "retired") return "Cannot undo: the previous parent role is no longer active";
      if (String(r.team_id ?? r.scope_user_id) !== String(role.team_id ?? role.scope_user_id)) return "Cannot undo across workspaces";
      const planProjectOf = new Map<string, string | null>();
      for (const id of [...(role.scope?.plan_ids ?? []), ...(r.scope?.plan_ids ?? [])]) planProjectOf.set(id, (await read(id))?.project_id ?? null);
      const outside = scopeOutside(scopeIds(r.scope), scopeIds(role.scope), planProjectOf);
      if (outside.project_ids.length || outside.plan_ids.length) return "Cannot undo: the scope no longer fits its parent";
      parent = r.reports_to;
    }
    for (const id of [...(role.scope?.project_ids ?? []), ...(role.scope?.plan_ids ?? [])]) {
      const record = await read(id);
      if (!record || record.workspace !== (role.team_id ? `team:${role.team_id}` : `user:${role.scope_user_id}`)) return "Cannot undo: a former scope record is no longer in this workspace";
    }
  }
}

function inverseFor(row: StoredRow, writes: OrgWrite[], parent?: Step["parent"]): OrgLogRow {
  const inverse = invertRow(publicRow(row));
  const ids = new Set(writes.map((w) => w.id));
  const e = { ...inverse.effects };
  if (e.takeover) e.takeover = { ...e.takeover, sessions: e.takeover.sessions.filter((c) => ids.has(c.conversation_id)) };
  for (const key of ["sessions_released", "tasks_handed", "children_moved", "routines_started", "routines_stopped", "tasks_closed", "rows_moved"] as const) {
    if (e[key]) (e as any)[key] = e[key]!.filter((r: any) => ids.has(r.conversation_id ?? r.task_id ?? r.role_id ?? r.agent_task_id ?? r.id));
  }
  if (e.scope_gained && !ids.has(e.scope_gained.role_id)) delete e.scope_gained;
  if (e.seat && !ids.has(e.seat.conversation_id)) delete e.seat;
  if (!parent && row.subject.type === "session") { delete inverse.before.parent; delete inverse.after.parent; }
  inverse.effects = e;
  if (inverse.kind === "retire" && inverse.after.status === null) inverse.after = { ...inverse.after, status: "retired" };
  return inverse;
}

async function refuseOrphans(ctx: Ctx, writes: OrgWrite[], read: (id: string) => Promise<any>) {
  for (const w of writes) {
    if (w.table !== "org_roles" || (await read(w.id))?.status !== "retired") continue;
    const role = await ctx.db.get(w.id);
    const references: any[] = [];
    for (const [table, index, field] of [["conversations", "by_org_role", "org_role_id"], ["conversations", "by_standing_role", "standing_role_id"], ["tasks", "by_assignee_updated", "assignee"]]) {
      references.push(...await ctx.db.query(table).withIndex(index, (q: any) => q.eq(field, w.id)).take(CAP + 1));
    }
    references.push(...await rolesInBoundary(ctx, role));
    const workspace = role.team_id ? `team:${role.team_id}` : `user:${role.scope_user_id}`;
    for (const table of ["projects", "plans", "initiatives"]) references.push(...await ctx.db.query(table).withIndex("by_workspace", (q: any) => q.eq("workspace", workspace)).take(CAP + 1));
    if (references.length > CAP) return "Too much later work to retire this role safely in one undo";
    for (const candidate of references) {
      const r = await read(candidate._id);
      const points = r?.org_role_id === w.id || r?.standing_role_id === w.id || (r?.assignee === w.id && !["done", "dropped"].includes(r.status)) || (r?.reports_to?.role_id === w.id && r.status !== "retired") || r?.owner_role_id === w.id || r?.owner?.role_id === w.id;
      if (points) return `Cannot retire @${role.handle}: later work still reports to it; move that work first`;
    }
  }
}

export async function planUndo(ctx: Ctx, userId: Id<"users">, ref: string, included: string[] = []) {
  const original = await requireBatch(ctx, userId, ref);
  const target = original.undone_by ? await requireBatch(ctx, userId, original.undone_by.batch) : original;
  const preview: OrgUndoPreview = { batch: String(target._id), will_change: [], left_alone: [], depends: [], cannot_take_back: [] };
  const targetRows = await rowsOf(ctx, target._id);
  const firstSeq = Math.min(target.seq, ...targetRows.map((row) => row.seq));
  const later = await ctx.db.query("org_change_batches").withIndex("by_workspace_seq", (q: any) => q.eq("workspace", target.workspace).gt("seq", firstSeq)).take(CAP + 1);
  if (later.length > CAP || targetRows.length > CAP) return { original, target, preview: { ...preview, refused: "This history window is too large to undo safely" }, steps: [] as Step[] };
  const candidates = [];
  let count = targetRows.length;
  // The entry's own chain (its undo, the redo of that, and on) is its history, never later work that depends on it.
  const chain = new Set<string>([String(target._id)]);
  for (const batch of later.filter((b: any) => b._id !== target._id).sort((a: any, b: any) => a.seq - b.seq)) {
    if (batch.undoes && chain.has(String(batch.undoes))) { chain.add(String(batch._id)); continue; }
    const rows = await rowsOf(ctx, batch._id);
    count += rows.length;
    if (count > CAP) return { original, target, preview: { ...preview, refused: "This history window is too large to undo safely" }, steps: [] as Step[] };
    candidates.push({ batch: String(batch._id), undoes: batch.undoes, undone: !!batch.undone_by, rows: rows.map(publicRow) });
  }
  const dependencies = dependentBatches({ batch: String(target._id), rows: targetRows.map(publicRow) }, candidates);
  for (const dep of dependencies) preview.depends.push(await entryOf(ctx, userId, await requireBatch(ctx, userId, dep.batch)));
  if (included.some((id) => !dependencies.some((d) => d.batch === id))) throw new Error("Only the displayed dependent entries can be undone together");
  const batches = [...preview.depends, { _id: target._id, seq: target.seq }].sort((a, b) => b.seq - a.seq);
  const virtual = new Map<string, any>();
  const read = async (id: string): Promise<any> => virtual.has(String(id)) ? virtual.get(String(id)) : ctx.db.get(id);
  const steps: Step[] = [];
  let messageCount = 0;
  const sessions = new Set<string>();
  const orderedRows = (await Promise.all(batches.map((batch) => rowsOf(ctx, batch._id)))).flat().sort((a, b) => b.seq - a.seq);
  for (const row of orderedRows) {
    if (row.undone_by) continue;
    if (!(await mayChangeRow(ctx, userId, row))) { preview.refused = "You can only undo changes you could make yourself"; continue; }
    const writes: OrgWrite[] = [];
    for (const w of row.writes ?? []) {
      const current = await read(w.id);
      if (!(await mayWrite(ctx, userId, row.workspace, w, current))) {
        preview.left_alone.push({ row: { ...publicRow(row), _id: `${row._id}:unavailable`, skipped: "a related record is no longer available in this workspace" } });
        continue;
      }
      if (!fieldsMatch(current, w.after)) {
        preview.left_alone.push({ row: { ...publicRow(row), _id: `${row._id}:${w.id}`, subject: w.id === row.subject.id ? row.subject : { type: w.table === "conversations" ? "session" : w.table === "org_roles" ? "role" : w.table === "tasks" ? "task" : w.table === "plans" ? "plan" : w.table === "initiatives" ? "initiative" : "project", id: w.id, label: current?.title ?? current?.name ?? row.subject.label }, skipped: current ? "it changed after this, or is no longer editable by you" : "it no longer exists" } });
        continue;
      }
      writes.push(w);
    }
    let parent: Step["parent"];
    if (row.subject.type === "session" && row.before.parent) {
      const c = await read(row.subject.id);
      if (c && same(await sessionParent(ctx, c), row.after.parent)) parent = row.before.parent;
      else preview.left_alone.push({ row: { ...publicRow(row), skipped: "its reporting line changed after this" } });
    }
    const subjectWrite = row.writes?.find((w) => w.id === row.subject.id);
    if (subjectWrite && !writes.includes(subjectWrite)) continue;
    const seatWrites = (row.writes ?? []).filter((w) => w.table === "anchors" || w.id === row.effects.seat?.conversation_id);
    if (seatWrites.some((w) => !writes.includes(w))) continue;
    if (!writes.length && !parent) {
      if (!row.writes?.length) preview.left_alone.push({ row: { ...publicRow(row), skipped: "this older entry has no reversible snapshot" } });
      continue;
    }
    for (const w of writes) {
      virtual.set(w.id, { ...(await read(w.id)), ...patchOf(w.before) });
      if (w.table === "conversations") sessions.add(w.id);
    }
    const inverse = inverseFor(row, writes, parent);
    steps.push({ row, inverse, writes, parent });
    preview.will_change.push(inverse);
    messageCount += row.effects.takeover?.told?.sessions ?? 0;
  }
  const refusal = await validateRestoredRoles(ctx, steps.flatMap((s) => s.writes), read) ?? await refuseOrphans(ctx, steps.flatMap((s) => s.writes), read);
  if (refusal) preview.refused = refusal;
  let wakeCount = 0;
  for (const id of new Set(steps.flatMap((s) => s.row.role_ids))) {
    const wakes = await ctx.db.query("role_wakes").withIndex("by_role_created", (q: any) => q.eq("role_id", id).gte("created_at", target.created_at)).take(CAP);
    wakeCount += wakes.filter((w: any) => w.status === "delivered").length;
  }
  if (wakeCount) preview.cannot_take_back.push({ kind: "wake_ran", count: wakeCount });
  if (messageCount) preview.cannot_take_back.push({ kind: "message_sent", count: messageCount });
  let worked = 0;
  for (const id of sessions) if ((await ctx.db.get(id))?.message_count) worked++;
  if (worked) preview.cannot_take_back.push({ kind: "session_worked", count: worked });
  return { original, target, preview, steps };
}

async function restoreWrite(ctx: Ctx, userId: Id<"users">, w: OrgWrite) {
  const current = await ctx.db.get(w.id);
  const patch = patchOf(w.before);
  if (w.table === "org_roles" && current.status !== "retired" && patch.status !== "retired") {
    if (patch.reports_to) await performReparentRole(ctx, userId, { role_id: w.id, reports_to: patch.reports_to });
    if (patch.caps) await performSetCaps(ctx, userId, { role_id: w.id, hands: patch.caps.hands_per_day, wakes: patch.caps.wakes_per_day, tokens: patch.caps.tokens_per_day });
    if (patch.trust) await performSetTrust(ctx, userId, { role_id: w.id, trust: patch.trust });
    const fields = Object.fromEntries(Object.entries(patch).filter(([k, value]) => ["name", "handle", "scope", "charter", "avatar", "status"].includes(k) && value !== undefined));
    if (Object.keys(fields).length) await performUpdateRole(ctx, userId, { role_id: w.id, ...fields, leave_sessions: true });
  }
  if (w.table === "conversations" && "org_role_id" in patch) {
    const owners = (await sessionParent(ctx, current)).owner_user_ids;
    await performReparentSession(ctx, userId, { session_id: w.id, target: patch.org_role_id ? { kind: "role", role_id: patch.org_role_id } : { kind: "user", owners: (await sessionParent(ctx, current)).owner_user_ids.length ? (await sessionParent(ctx, current)).owner_user_ids : [String(current.owner_user_id ?? current.user_id)] } });
    if (!owners.length) {
      for (const id of (await sessionParent(ctx, current)).owner_user_ids) await removeSessionOwnerRow(ctx, current._id, id as Id<"users">);
      await syncPrimaryOwnerCache(ctx, current._id);
    }
  }
  if (w.table === "tasks" && patch.status) await setTaskStatus(ctx, { team_id: current.team_id }, current, patch.status, Date.now());
  if (w.table === "anchors" && "status" in patch && current.team_id) {
    const memberships = await ctx.db.query("team_memberships").withIndex("by_user_team", (q: any) => q.eq("user_id", current.bot_user_id).eq("team_id", current.team_id)).collect();
    if (patch.status === "decommissioned") { for (const m of memberships) await ctx.db.delete(m._id); }
    else if (!memberships.length) await ctx.db.insert("team_memberships", { user_id: current.bot_user_id, team_id: current.team_id, role: "member", joined_at: Date.now(), visibility: "full" });
  }
  if (w.table === "agent_tasks") await patchTask(ctx, current, { ...patch, ...(patch.status === "scheduled" && current.interval_ms ? { run_at: Date.now() + current.interval_ms } : {}) });
  else await ctx.db.patch(w.id, patch);
  if (w.table === "tasks" && current.plan_id) await recalcPlanProgress(ctx, current.plan_id, current._id, patch.status ?? current.status);
  if (w.table === "org_roles" && patch.status !== "retired") await enqueueRoleEvent(ctx, current._id, { kind: "immediate", cause: "A person restored an earlier organization change; re-read your scope and brief" });
}

export async function performUndo(ctx: Ctx, userId: Id<"users">, args: { batch: string; with?: string[]; api_token?: string; from_session?: string }, redo = false) {
  await refuseUnlessHuman(ctx, args, "Undo and redo");
  if ((await ctx.db.get(userId))?.is_bot) throw new Error("Undo and redo are human only");
  const original = await requireBatch(ctx, userId, args.batch);
  // "Redo is undo of the undo": an undo or redo entry stands for the entry it
  // took back or applied again, so a verb on it is the matching verb on that
  // entry, and the record keeps one chain. A struck one is already answered.
  if (original.gesture === "undo" || original.gesture === "redo") {
    if (!!original.undone_by !== redo) return { batch: original._id, already_applied: true };
    let root = original;
    while ((root.gesture === "undo" || root.gesture === "redo") && root.undoes) root = await requireBatch(ctx, userId, root.undoes);
    return performUndo(ctx, userId, { ...args, batch: String(root._id) }, original.gesture === "undo" ? !redo : redo);
  }
  if (!redo && original.undone_by) return { batch: original.undone_by.batch, already_applied: true };
  if (redo && !original.undone_by) return { batch: original._id, already_applied: true };
  const plan = await planUndo(ctx, userId, args.batch, args.with);
  if (plan.preview.refused) throw new Error(plan.preview.refused);
  if (plan.preview.depends.some((e) => !args.with?.includes(e._id))) throw new Error("Include the dependent entries shown in the undo preview");
  if (!plan.steps.length) throw new Error("Nothing can be restored: the records changed after this entry");
  openOrgBatch(ctx, { door: "history", gesture: redo ? "redo" : "undo", undoes: plan.target._id });
  for (const step of plan.steps) {
    await withOrgChange(ctx, userId, { kind: step.inverse.kind, subject: step.row.subject, undoes: step.row._id as Id<"org_changes"> }, async () => {
      for (const w of [...step.writes].reverse()) await restoreWrite(ctx, userId, w);
      if (step.parent) {
        const c = await ctx.db.get(step.row.subject.id);
        await performReparentSession(ctx, userId, { session_id: c._id, target: { kind: "user", owners: step.parent.owner_user_ids, mode: "set" } });
        if (step.parent.org_role_id) await performReparentSession(ctx, userId, { session_id: c._id, target: { kind: "role", role_id: step.parent.org_role_id } });
      }
      await noteOrgChange(ctx, userId, { workspace: step.row.workspace, team_id: plan.target.team_id }, { kind: step.inverse.kind, subject: step.inverse.subject, before: step.inverse.before, after: step.inverse.after, effects: step.inverse.effects, labels: step.inverse.labels });
    });
  }
  const batch = openBatchId(ctx)!;
  for (const id of new Set(plan.steps.map((s) => s.row.batch))) await ctx.db.patch(id, { undone_by: { batch, user_id: userId, at: Date.now() } });
  if (redo) {
    for (const step of plan.steps) if (step.row.undoes) {
      const restored = await ctx.db.get(step.row.undoes);
      if (restored) {
        await ctx.db.patch(restored._id, { undone_by: undefined });
        await ctx.db.patch(restored.batch, { undone_by: undefined });
      }
    }
  }
  return { batch, changed: plan.steps.length, left_alone: plan.preview.left_alone.length };
}

/**
 * Where a record came from (initiatives-projects-role-page.md "I1, revised"):
 * the log row that brought it into being, when a proposal did. The
 * initiative page says "Proposed by the review on <date>" from this. Null
 * for a record made at any other door, one the viewer cannot read, or one
 * nothing in the log made.
 */
export async function recordOrigin(ctx: Ctx, userId: Id<"users">, subjectId: string): Promise<{ at: number; batch: string; proposal?: { short_id: string; title?: string }; undone: boolean } | null> {
  const rows: any[] = await ctx.db.query("org_changes").withIndex("by_subject", (q: any) => q.eq("subject.id", subjectId)).take(50);
  const made = rows.find((r) => r.kind === "initiative" || r.kind === "projects" || r.kind === "role");
  if (!made || !(await workspaceGrantsAccess(ctx, userId, made.workspace))) return null;
  const batch = await ctx.db.get(made.batch);
  if (!batch || batch.door !== "proposal") return null;
  return { at: made.created_at, batch: String(batch._id), ...(batch.proposal ? { proposal: { short_id: batch.proposal.short_id, ...(batch.proposal.title ? { title: batch.proposal.title } : {}) } } : {}), undone: !!made.undone_by };
}

async function caller(ctx: any, token?: string) {
  const id = await getAuthenticatedUserId(ctx, token);
  if (!id) throw new Error("Authentication required");
  return id;
}
const authArgs = { api_token: v.optional(v.string()) };
export const list = query({ args: { ...authArgs, team_id: v.optional(v.id("teams")), role: v.optional(v.string()), since: v.optional(v.number()), before: v.optional(v.number()), limit: v.optional(v.number()) }, handler: async (ctx, args) => listEntries(ctx, await caller(ctx, args.api_token), args) });
export const get = query({ args: { ...authArgs, batch: v.string() }, handler: async (ctx, args) => getEntry(ctx, await caller(ctx, args.api_token), args.batch) });
export const origin = query({ args: { subject: v.string() }, handler: async (ctx, args) => { const id = await getAuthenticatedUserId(ctx); return id ? recordOrigin(ctx, id, args.subject) : null; } });
export const previewUndo = query({ args: { ...authArgs, batch: v.string(), with: v.optional(v.array(v.string())) }, handler: async (ctx, args) => (await planUndo(ctx, await caller(ctx, args.api_token), args.batch, args.with)).preview });
const undoArgs = { ...authArgs, batch: v.string(), with: v.optional(v.array(v.string())), from_session: v.optional(v.string()) };
export const undo = mutation({ args: undoArgs, handler: async (ctx, args) => performUndo(ctx, await caller(ctx, args.api_token), args) });
export const redo = mutation({ args: undoArgs, handler: async (ctx, args) => performUndo(ctx, await caller(ctx, args.api_token), args, true) });
