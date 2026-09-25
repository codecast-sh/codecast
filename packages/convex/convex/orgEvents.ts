// The wake rail's write side (docs/architecture/org-roles-standing.md T3).
//
// Every event a standing role should hear about is one `role_wake_outbox` row,
// inserted from the chokepoint that produced it: a person's message, a hand
// stalling, a task in scope moving, a decision on the ladder, a routine
// firing, a charter edit. Rows never reach the agent one by one; a per role
// flush (orgWakes.ts) folds the due rows into ONE frame. This file decides
// whether a row is inserted at all (the loop rules) and when the flush runs
// (the kind): modeled on pushRouter.enqueuePush.
//
// Loop rules, in order: a role's own writes (its standing session or one of
// its hands) never wake it; a subordinate role's writes never wake its parent
// (the parent reads the subordinate's brief line); a parent's writes inside a
// subordinate's scope do wake the subordinate.
//
// Leaf module on purpose: it is imported from pendingMessages, functions.ts
// and every write path, so it must not import any of them back.

import { DEFAULT_ROLE_CAPS } from "@codecast/shared/contracts/orgCapacity";
import { autonomyOn } from "@codecast/shared/contracts/roleAutonomy";
import { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { conversationActsForRole, roleOfConversation } from "./lib/actor";
import { isWholeWorkspace } from "./lib/orgScope";
import { workspaceHasFeature } from "./lib/teamFeatureGuard";

export type WakeKind = "immediate" | "fold" | "passive";
export type WakeRef = { table: string; id: string; short_id?: string };

export type EnqueueRoleEventOpts = {
  kind: WakeKind;
  cause: string;
  ref?: WakeRef;
  actorConversationId?: Id<"conversations"> | null;
  // A person's message already queued into the standing session; the flush
  // folds the frame into that row rather than adding a turn.
  pendingMessageId?: Id<"pending_messages">;
};

export const DEFAULT_COALESCE_MS = 120_000;
// The numbers live in the shared capacity model (org-staffing.md S2), which
// the analyzer prompt and org.health read too.
export const DEFAULT_CAPS = DEFAULT_ROLE_CAPS;
export const DEFAULT_TRUST = "understand" as const;
// The restart marker: a row whose cause starts with this asks for the full
// charter and brief in the next frame.
export const RESTART_CAUSE = "restart:";
// A cause line is one line of the frame; a person's message may be long, so
// the cap is generous, but a pasted document still cannot swallow the frame.
export const MAX_CAUSE_CHARS = 8_000;
// Bounded read of a role's unflushed rows: a role with more than this waiting
// is capped or paused, and the flush handles them in batches.
export const OUTBOX_READ_CAP = 200;
// Up the reporting chain this far when testing "does this role report to X".
const MAX_CHAIN = 32;

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export type RoleCounters = { day: string; hands: number; wakes: number; tokens: number };

// Today's counters, reset when the stored day is not today. Every reader and
// writer of `counters` goes through this so a stale row never leaks yesterday.
export function countersFor(role: { counters?: RoleCounters | null }, now: number): RoleCounters {
  const day = utcDay(now);
  const c = role.counters;
  if (c && c.day === day) return { ...c };
  return { day, hands: 0, wakes: 0, tokens: 0 };
}

export function capsFor(role: { caps?: { hands_per_day: number; wakes_per_day: number; tokens_per_day: number } | null }) {
  return { ...DEFAULT_CAPS, ...(role.caps ?? {}) };
}

export function trustOf(role: { trust?: string | null }): "understand" | "decide" | "direct" {
  return (role.trust as any) ?? DEFAULT_TRUST;
}

// The switch (org-staffing.md S23.1): does the role start work on its own? The
// stored stage maps through the shared helper, so this file, the gates and
// every surface read one answer.
export function roleStartsOnItsOwn(role: { trust?: string | null }): boolean {
  return autonomyOn(trustOf(role));
}

export function coalesceOf(role: { coalesce_ms?: number | null }): number {
  return role.coalesce_ms ?? DEFAULT_COALESCE_MS;
}

// Milliseconds until the next UTC midnight: when a cap held a wake, that is
// the earliest the counters clear.
export function msToNextUtcDay(now: number): number {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1_000, next - now);
}

export function clipCause(text: string): string {
  const t = text.trim();
  return t.length > MAX_CAUSE_CHARS ? t.slice(0, MAX_CAUSE_CHARS - 1) + "…" : t;
}

// Does `role` report (directly or through role parents) to `ancestorId`?
export async function roleReportsTo(ctx: { db: any }, role: any, ancestorId: string): Promise<boolean> {
  let cur: any = role;
  for (let depth = 0; cur && depth < MAX_CHAIN; depth++) {
    if (cur.reports_to?.kind !== "role") return false;
    if (String(cur.reports_to.role_id) === ancestorId) return true;
    cur = await ctx.db.get(cur.reports_to.role_id);
  }
  return false;
}

// The NEWEST waiting rows. A flush decides from this window alone, so the row
// that just arrived (a person's mention) must always be in it; oldest-first let
// a backlog past the cap hide every new row, and nothing ever woke the role
// again. Rows older than the window are drained by the flush that fills it
// (orgWakes.drainOverflow).
export async function unflushedRowsFor(ctx: { db: any }, roleId: Id<"org_roles">): Promise<any[]> {
  return await ctx.db
    .query("role_wake_outbox")
    .withIndex("by_role_flushed", (q: any) => q.eq("role_id", roleId).eq("flushed_at", undefined))
    .order("desc")
    .take(OUTBOX_READ_CAP);
}

// The loop rules. True when the actor's write must NOT wake `roleId`.
export async function actorIsExcluded(ctx: { db: any }, roleId: string, actorConversation: any | null): Promise<boolean> {
  if (!actorConversation) return false;
  if (conversationActsForRole(actorConversation, roleId)) return true;
  const actorRole = await roleOfConversation(ctx, actorConversation);
  if (actorRole && String(actorRole._id) !== roleId && (await roleReportsTo(ctx, actorRole, roleId))) return true;
  return false;
}

export async function scheduleFlush(ctx: any, roleId: Id<"org_roles">, delayMs: number, attempt = 0): Promise<void> {
  if (!ctx.scheduler) return;
  await ctx.scheduler.runAfter(Math.max(0, delayMs), internal.orgWakes.flush, { role_id: roleId, attempt });
}

// Insert one row and arm the flush the kind calls for. Returns the row id, or
// null when the role cannot be woken (retired, no standing session) or a loop
// rule excluded the actor.
export async function enqueueRoleEvent(
  ctx: any,
  roleId: Id<"org_roles">,
  opts: EnqueueRoleEventOpts,
): Promise<Id<"role_wake_outbox"> | null> {
  const role = await ctx.db.get(roleId);
  if (!role || role.status === "retired" || !role.anchor_id) return null;
  // The org feature is per team, default off (teams.features.org). A role in
  // a workspace with it off is not woken: nothing shows it, so nothing should
  // run under its name either. Turning the feature on resumes wakes from the
  // next event; nothing queued in between is replayed.
  if (!(await workspaceHasFeature(ctx, { team_id: role.team_id, user_id: role.scope_user_id }, "org"))) return null;
  const actor = opts.actorConversationId ? await ctx.db.get(opts.actorConversationId) : null;
  if (await actorIsExcluded(ctx, String(roleId), actor)) return null;

  const now = Date.now();
  const dueAt = opts.kind === "fold" ? now + coalesceOf(role) : now;
  const cause = opts.ref?.table === "agent_tasks" ? opts.cause : clipCause(opts.cause);
  const waiting = await unflushedRowsFor(ctx, roleId);

  // One row per (table, id) per window (ct-51491). A task moved seven times
  // by seven mutations is one change to the role, not seven: the waiting row
  // for that ref takes the newest cause and keeps its FIRST due time, so a
  // work item that keeps moving cannot push its own wake forever, and the
  // frame carries one line for it. Immediate rows never fold this way: each
  // is a person's message or a decision that must reach the role as itself.
  if (opts.kind !== "immediate" && opts.ref) {
    const same = waiting.find((r: any) =>
      r.kind === opts.kind && r.ref?.table === opts.ref!.table && String(r.ref?.id) === String(opts.ref!.id));
    if (same) {
      await ctx.db.patch(same._id, { cause, count: (same.count ?? 1) + 1, actor_conversation_id: actor?._id ?? same.actor_conversation_id });
      return same._id;
    }
  }

  const id: Id<"role_wake_outbox"> = await ctx.db.insert("role_wake_outbox", {
    role_id: roleId,
    kind: opts.kind,
    cause,
    ref: opts.ref,
    actor_conversation_id: actor?._id,
    pending_message_id: opts.pendingMessageId,
    created_at: now,
    due_at: dueAt,
  });

  // A paused role holds its rows; resume flushes them as one wake.
  if (role.status === "paused") return id;
  if (opts.kind === "immediate") {
    await scheduleFlush(ctx, roleId, 0);
  } else if (opts.kind === "fold") {
    // One flush per coalesce window: arm it only when no earlier unflushed
    // row already has one coming (the flush takes every waiting row).
    const earlier = waiting.some((r: any) => r.kind !== "passive" && r.due_at <= dueAt);
    if (!earlier) await scheduleFlush(ctx, roleId, dueAt - now);
  }
  return id;
}

// ── Scope changes (the fold source) ────────────────────────────────────────

// Live roles with a standing session inside a work item's boundary.
async function standingRolesInBoundary(ctx: { db: any }, row: { team_id?: any; user_id?: any }): Promise<any[]> {
  const rows: any[] = row.team_id
    ? await ctx.db.query("org_roles").withIndex("by_team", (q: any) => q.eq("team_id", row.team_id)).collect()
    : row.user_id
      ? await ctx.db.query("org_roles").withIndex("by_scope_user", (q: any) => q.eq("scope_user_id", row.user_id)).collect()
      : [];
  return rows.filter((r) => r.status !== "retired" && r.anchor_id);
}

// Is a task or plan inside a role's scope: by project, by plan, or (a task)
// by its plan's project. `planProject` is read lazily, once per call.
export async function rowInScope(
  ctx: { db: any },
  role: { scope: { project_ids: any[]; plan_ids: any[] } },
  table: "tasks" | "plans",
  row: any,
): Promise<boolean> {
  const scope = role.scope ?? { project_ids: [], plan_ids: [] };
  if (isWholeWorkspace(scope)) return true;
  const projects = new Set(scope.project_ids.map(String));
  const plans = new Set(scope.plan_ids.map(String));
  if (row.project_id && projects.has(String(row.project_id))) return true;
  if (table === "plans") return plans.has(String(row._id));
  if (row.plan_id) {
    if (plans.has(String(row.plan_id))) return true;
    const plan = await ctx.db.get(row.plan_id);
    if (plan?.project_id && projects.has(String(plan.project_id))) return true;
  }
  return false;
}

export function describeWorkItem(table: "tasks" | "plans", row: any): string {
  const kind = table === "tasks" ? "task" : "plan";
  const id = row.short_id ? `${row.short_id} ` : "";
  return `${kind} ${id}"${(row.title ?? "").slice(0, 80)}" is ${row.status ?? "updated"}`;
}

// A task handed to a role in this transaction (org-roles-run-work.md R5).
export type OrgAssignment = { role_id: string; cause: string };

// A task or plan changed: one fold row per role whose scope holds it. A role
// the task was just assigned to gets its row whether or not the task sits in
// its scope, and that row says so: the assignment is the news, and a second
// row for the same task would fold over it with "task ct-N is open".
export async function enqueueForScopeChange(
  ctx: any,
  table: "tasks" | "plans",
  row: any,
  opts: { actorConversationId?: Id<"conversations"> | null; cause?: string; assigned?: OrgAssignment } = {},
): Promise<number> {
  if (!row) return 0;
  const roles = await standingRolesInBoundary(ctx, row);
  let n = 0;
  for (const role of roles) {
    const assigned = opts.assigned && String(role._id) === opts.assigned.role_id ? opts.assigned : null;
    if (!assigned && !(await rowInScope(ctx, role, table, row))) continue;
    const id = await enqueueRoleEvent(ctx, role._id, {
      kind: "fold",
      cause: assigned?.cause ?? opts.cause ?? describeWorkItem(table, row),
      ref: { table, id: String(row._id), short_id: row.short_id },
      actorConversationId: opts.actorConversationId ?? null,
    });
    if (id) n++;
  }
  return n;
}

// ── Per transaction collection (functions.ts post write hook) ───────────────
//
// The mutation wrapper records every insert or patch to tasks and plans and,
// once the handler returns, resolves the roles whose scope holds each touched
// row and inserts fold rows. That is the single chokepoint the contract asks
// for: no task or plan writer has to remember to call anything.

const ORG_WRITES = Symbol.for("codecast.orgWrites");
const ORG_ACTOR = Symbol.for("codecast.orgActor");
const SCOPE_TABLES = new Set(["tasks", "plans"]);

export type OrgWriteCollector = Map<string, { table: "tasks" | "plans"; id: any; assigned?: OrgAssignment }>;

export function makeOrgWriteTrackedDb(db: any, collector: OrgWriteCollector): any {
  if (typeof db?.normalizeId !== "function") return db;
  const tableOf = (id: any): "tasks" | "plans" | null => {
    for (const table of SCOPE_TABLES) {
      try { if (db.normalizeId(table, String(id))) return table as any; } catch { /* not an id */ }
    }
    return null;
  };
  // A Proxy rather than a spread: the inner db may keep its methods on a
  // prototype, and only insert/patch need to be seen.
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "insert") {
        return async (table: string, doc: any) => {
          const id = await target.insert(table, doc);
          if (SCOPE_TABLES.has(table)) collector.set(String(id), { ...collector.get(String(id)), table: table as any, id });
          return id;
        };
      }
      if (prop === "patch") {
        return async (id: any, fields: any) => {
          const res = await target.patch(id, fields);
          const table = tableOf(id);
          if (table) collector.set(String(id), { ...collector.get(String(id)), table, id });
          return res;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function attachOrgWriteCollector(ctx: any): OrgWriteCollector {
  const collector: OrgWriteCollector = new Map();
  ctx[ORG_WRITES] = collector;
  return collector;
}

// A write path that knows which session made the call names it here, so the
// post write hook can apply the loop rules. Cheap and idempotent.
export function markOrgActor(ctx: any, conversation: any | null | undefined): void {
  if (conversation) ctx[ORG_ACTOR] = conversation;
}

// The task writer that hands a task to a role names it here, and the post
// write hook delivers it as that role's one row for the task. Outside a
// wrapped mutation (no collector) there is nothing to record on, so the row
// is enqueued directly.
export async function noteOrgAssignment(ctx: any, task: any, assigned: OrgAssignment): Promise<void> {
  const collector: OrgWriteCollector | undefined = ctx?.[ORG_WRITES];
  if (!collector) {
    await enqueueForScopeChange(ctx, "tasks", task, { actorConversationId: orgActorOf(ctx)?._id ?? null, assigned });
    return;
  }
  const key = String(task._id);
  collector.set(key, { ...collector.get(key), table: "tasks", id: task._id, assigned });
}

export function orgActorOf(ctx: any): any | null {
  return ctx?.[ORG_ACTOR] ?? null;
}

export async function flushOrgWrites(ctx: any): Promise<number> {
  const collector: OrgWriteCollector | undefined = ctx?.[ORG_WRITES];
  if (!collector || collector.size === 0) return 0;
  const actor = orgActorOf(ctx);
  let n = 0;
  for (const { table, id, assigned } of collector.values()) {
    const row = await ctx.db.get(id);
    if (!row) continue;
    n += await enqueueForScopeChange(ctx, table, row, { actorConversationId: actor?._id ?? null, assigned });
  }
  collector.clear();
  return n;
}
