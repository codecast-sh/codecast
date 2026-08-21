// Append-only per-scope sync action log — emission and read side.
// Design: docs/architecture/sync-log-migration.md (pl-399).
//
// The write interceptor (functions.ts → changeLog.ts wrapper) calls emitSyncActions /
// emitScopeAction on every tracked write, in the SAME serializable transaction as the
// domain write. Position allocation reads and bumps the scope's sync_heads row, so per
// scope positions are strictly increasing in commit order — that is the whole ordering
// proof. No wall clock is ever an ordering key (`ts` is retention/debug metadata).
//
// Coalescing keeps the table bounded like change_log: an entity's active upsert row is
// MOVED to the new head instead of appended again (patch position, not insert), so a
// streaming conversation contributes one row per scope, not one per counter bump. Moves
// preserve correctness: a reader either sees the row at its old position (and stage two
// fetches current state anyway) or sees it again at the new one; applies are idempotent.
// Revocations (delete in a departed scope) always land as their own ordered action.
import { v } from "convex/values";
import { query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { ChangeEntity, ChangeScope } from "./changeLog";

export type SyncScopeKey = string; // "user:<id>" | "team:<id>"
export type SyncOp = "upsert" | "delete" | "scope_added" | "scope_removed";
export type SyncAckPosition = { scope_key: SyncScopeKey; position: number };

// Emergency kill switch (no redeploy needed: `npx convex env set SYNC_LOG_DISABLED 1`).
// Emission is the only thing gated — reads keep serving whatever exists, and
// change_log dual-writes continue, so flipping this parks the log without
// breaking either client generation.
export function syncLogDisabled(): boolean {
  try {
    return process.env.SYNC_LOG_DISABLED === "1";
  } catch {
    return false;
  }
}

// Per-mutation collector: the positions this transaction appended (returned to the
// client as its write acknowledgement when dispatch opts in), a dedupe set so a
// mutation that writes the same entity repeatedly appends once per (scope, entity, op)
// — safe because the transaction commits atomically — and a per-scope head cache so a
// bulk mutation reads each head row once instead of once per row it touches. The
// collector is created per handler invocation (functions.ts), so an OCC retry starts
// clean and an ack can never carry positions from an aborted attempt.
export type SyncAckCollector = {
  positions: SyncAckPosition[];
  seen: Set<string>;
  heads: Map<SyncScopeKey, { id: any; position: number }>;
};

export function makeSyncAckCollector(): SyncAckCollector {
  return { positions: [], seen: new Set(), heads: new Map() };
}

// Patches that touch ONLY these fields do not emit sync actions (change_log still
// updates for old clients). These are the counter/liveness bumps the daemon writes
// on every message flush and heartbeat; emitting them would put every streaming
// session's flush into contention on the owner's single head row (design D1) while
// buying an away client nothing — the live snapshot floor re-delivers these fields
// on reconnect anyway. Semantic fields (title, status, dismiss stamps, work_state…)
// are never listed here.
export const CHURN_ONLY_FIELDS: Record<string, ReadonlySet<string>> = {
  conversations: new Set([
    "updated_at",
    "message_count",
    "last_message_at",
    "last_message_role",
    "last_heartbeat",
    "last_metrics_at",
    "last_active_at",
    "model",
    "effort",
    // The message-flush convPatch (messages.ts addMessage/addMessages) writes
    // these on ~every batch — inbox-card cosmetics the live snapshot floor
    // re-delivers. Without them the exemption is defeated in practice: prod
    // measured ~0.7 conversation upserts/sec on one user scope, nearly all
    // from this path. pending_api_error*/loop_state stay non-exempt on
    // purpose — the patch includes them only on genuine transitions.
    "last_user_message_at",
    "last_message_preview",
    "image_preview_url",
    "recent_files",
  ]),
};

export function isChurnOnlyPatch(table: string, fields: Record<string, any>): boolean {
  const churn = CHURN_ONLY_FIELDS[table];
  if (!churn) return false;
  const keys = Object.keys(fields);
  return keys.length > 0 && keys.every((k) => churn.has(k));
}

export function userScopeKey(userId: string): SyncScopeKey {
  return `user:${userId}`;
}
export function teamScopeKey(teamId: string): SyncScopeKey {
  return `team:${teamId}`;
}

// The scopes an entity's actions land in. Mirrors change_log semantics exactly
// (owner always; team when team_id is set; conversations owner-only — the inbox is
// owner-only and team activity is a separate axis). Pure — unit-tested.
export function scopesForChange(entityType: ChangeEntity, scope: ChangeScope): SyncScopeKey[] {
  if (!scope.owner_user_id) return [];
  const scopes = [userScopeKey(scope.owner_user_id)];
  if (entityType !== "conversations" && scope.team_id) {
    scopes.push(teamScopeKey(scope.team_id));
  }
  return scopes;
}

async function headFor(db: any, scopeKey: SyncScopeKey): Promise<any | null> {
  return db
    .query("sync_heads")
    .withIndex("by_scope", (q: any) => q.eq("scope_key", scopeKey))
    .unique();
}

// Allocate the next position for a scope (bumping or creating the head row). The
// collector's head cache saves the INDEX LOOKUP on repeat allocations, but the
// cached position is never trusted: a ctx.runMutation sub-mutation runs in the
// same transaction with its OWN collector, so the head row can be ahead of any
// one collector's cache. Re-reading by id (a transaction-local read that sees
// all in-transaction writes, including sub-mutation bumps) makes duplicate
// positions impossible by construction — strictly-increasing positions are the
// whole ordering proof, so correctness must not depend on handler write order.
async function allocatePosition(
  db: any,
  collector: SyncAckCollector | null,
  scopeKey: SyncScopeKey,
  ts: number,
): Promise<number> {
  const cached = collector?.heads.get(scopeKey);
  if (cached) {
    const row = await db.get(cached.id);
    if (row) {
      const position = row.position + 1;
      cached.position = position;
      await db.patch(cached.id, { position, updated_at: ts });
      return position;
    }
    collector?.heads.delete(scopeKey);
  }
  const head = await headFor(db, scopeKey);
  const position = (head?.position ?? 0) + 1;
  let headId = head?._id;
  if (head) {
    await db.patch(head._id, { position, updated_at: ts });
  } else {
    headId = await db.insert("sync_heads", { scope_key: scopeKey, position, floor: 0, updated_at: ts });
  }
  collector?.heads.set(scopeKey, { id: headId, position });
  return position;
}

// Append one action in one scope. For upsert/delete of a tracked entity, the entity's
// existing ACTIVE row in this scope (there is at most one, by this very rule) is moved
// to the new position and flipped to the new op; scope lifecycle actions always insert.
// `db` MUST be the raw (un-wrapped) writer so this never re-enters the interceptor.
export async function appendSyncAction(
  db: any,
  collector: SyncAckCollector | null,
  scopeKey: SyncScopeKey,
  entityType: ChangeEntity | "scope",
  entityId: string,
  op: SyncOp,
): Promise<void> {
  if (syncLogDisabled()) return;
  const dedupeKey = `${scopeKey} ${entityId} ${op}`;
  if (collector) {
    if (collector.seen.has(dedupeKey)) return;
    collector.seen.add(dedupeKey);
  }
  const ts = Date.now();
  const position = await allocatePosition(db, collector, scopeKey, ts);
  if (entityType !== "scope") {
    const existing = await db
      .query("sync_actions")
      .withIndex("by_scope_entity", (q: any) =>
        q.eq("scope_key", scopeKey).eq("entity_id", entityId))
      .first();
    if (existing) {
      await db.patch(existing._id, { position, op, ts, entity_type: entityType });
      collector?.positions.push({ scope_key: scopeKey, position });
      return;
    }
  }
  await db.insert("sync_actions", {
    scope_key: scopeKey,
    position,
    entity_type: entityType,
    entity_id: entityId,
    op,
    ts,
  });
  collector?.positions.push({ scope_key: scopeKey, position });
}

// Emit the sync-log twin of a change_log emission: one action per scope the entity is
// visible in. `previousScope` (when the write moved the entity between scopes) gets a
// revocation `delete` in each departed scope — the piece change_log's mutable row loses.
export async function emitSyncActions(
  db: any,
  collector: SyncAckCollector | null,
  entityType: ChangeEntity,
  entityId: string,
  op: "upsert" | "delete",
  scope: ChangeScope,
  previousScope?: ChangeScope | null,
): Promise<void> {
  const current = scopesForChange(entityType, scope);
  if (previousScope) {
    const currentSet = new Set(current);
    for (const departed of scopesForChange(entityType, previousScope)) {
      if (!currentSet.has(departed)) {
        await appendSyncAction(db, collector, departed, entityType, entityId, "delete");
      }
    }
  }
  for (const scopeKey of current) {
    await appendSyncAction(db, collector, scopeKey, entityType, entityId, op);
  }
}

// Scope membership lifecycle: emitted in the affected USER's own scope when a
// team_memberships row is inserted/deleted, so the member's client learns to start
// tracking (bootstrap) or purge (revoke) the team scope without a reload.
export async function emitScopeAction(
  db: any,
  collector: SyncAckCollector | null,
  userId: string,
  teamId: string,
  op: "scope_added" | "scope_removed",
): Promise<void> {
  await appendSyncAction(db, collector, userScopeKey(userId), "scope", String(teamId), op);
}

// ── Read side ────────────────────────────────────────────────────────────────

const DEFAULT_RANGE_LIMIT = 500;

async function callerScopeKeys(ctx: any, userId: any): Promise<SyncScopeKey[]> {
  const memberships = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  return [userScopeKey(String(userId)), ...memberships.map((m: any) => teamScopeKey(String(m.team_id)))];
}

// The caller's scope heads. Tiny payload — this is the live subscription that wakes the
// client applier; it re-runs on tracked writes only (never on heartbeats or messages).
export const getHeads = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { heads: [] };
    const scopes = await callerScopeKeys(ctx, userId);
    const heads: Array<{ scope_key: SyncScopeKey; position: number; floor: number }> = [];
    for (const scopeKey of scopes) {
      const head = await headFor(ctx.db, scopeKey);
      heads.push({
        scope_key: scopeKey,
        position: head?.position ?? 0,
        floor: head?.floor ?? 0,
      });
    }
    return { heads };
  },
});

// Ascending page of one scope's actions past `from`. `resync: true` means retention has
// passed the caller's cursor — the client must full-backfill and restamp (design D10).
export const getRange = query({
  args: {
    scope_key: v.string(),
    from: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { actions: [], nextFrom: args.from, hasMore: false };
    const scopes = await callerScopeKeys(ctx, userId);
    if (!scopes.includes(args.scope_key)) {
      // Not an error (a client can race a scope_removed), but it must be
      // DISTINGUISHABLE from an empty caught-up scope: the applier treats it as
      // scope revocation (purge + drop cursor), and the applier's heads-absence
      // sweep is the backstop when the scope_removed action itself was already
      // retention-pruned (design D5).
      return { actions: [], nextFrom: args.from, hasMore: false, authorized: false };
    }
    return readRangePage(ctx.db, args.scope_key, args.from, args.limit);
  },
});

// The post-auth body of getRange, extracted so the floor/resync and paging
// contract is unit-testable against a fake db (design D11).
export async function readRangePage(
  db: any,
  scopeKey: SyncScopeKey,
  from: number,
  limitArg?: number,
): Promise<{
  actions: Array<{ position: number; entity_type: string; entity_id: string; op: SyncOp }>;
  nextFrom: number;
  hasMore: boolean;
  resync?: boolean;
}> {
  const head = await headFor(db, scopeKey);
  if ((head?.floor ?? 0) > from) {
    return { actions: [], nextFrom: from, hasMore: false, resync: true };
  }
  const limit = Math.min(Math.max(limitArg ?? DEFAULT_RANGE_LIMIT, 1), 1000);
  const rows = await db
    .query("sync_actions")
    .withIndex("by_scope_position", (q: any) =>
      q.eq("scope_key", scopeKey).gt("position", from))
    .order("asc")
    .take(limit + 1);
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  return {
    actions: page.map((r: any) => ({
      position: r.position,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      op: r.op,
    })),
    nextFrom: page.length > 0 ? page[page.length - 1].position : from,
    hasMore,
  };
}
