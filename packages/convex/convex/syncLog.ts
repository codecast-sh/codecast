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
//
// Cargo (docs/architecture/sync-log-cargo.md): rows carry the changed fields as
// a merge patch plus an access stamp; getRange projects each row per caller.
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

// ── Cargo (docs/architecture/sync-log-cargo.md E1–E3) ────────────────────────

export type Cargo = {
  patch?: Record<string, any>;
  unset?: string[];
  full?: boolean;
  partial?: boolean;
};

// Kill switch for cargo only (`npx convex env set SYNC_LOG_PAYLOADS_DISABLED 1`):
// actions keep flowing without patches, so every client falls back to the
// byIds fetch — absence of `patch` IS the fallback signal.
export function payloadsDisabled(): boolean {
  try {
    return process.env.SYNC_LOG_PAYLOADS_DISABLED === "1";
  } catch {
    return false;
  }
}

// Fields that never ride the log (E3): heavy bodies with their own channels,
// unbounded arrays, and — for docs/plans — `team_id`, which the list channels
// REWRITE to the effective team (stampEffectiveTeam); a raw routing team_id
// would flap a stamped row back. The client derives team_id from `workspace`
// for those two. From the per-collection enrichment audit (pl-498).
export const PAYLOAD_DENYLIST: Record<string, ReadonlySet<string>> = {
  tasks: new Set([
    "drive", "steps", "files_changed", "acceptance_criteria",
    "verification_evidence", "execution_concerns", "last_session_summary",
  ]),
  docs: new Set(["content", "embedding", "entries", "team_id"]),
  plans: new Set([
    "progress_log", "decision_log", "discoveries", "entries",
    "context_pointers", "session_ids", "team_id",
  ]),
  projects: new Set([]),
  conversations: new Set([
    "title_embedding", "recent_files", "stable_context", "draft_message",
    "cli_flags", "available_skills", "fork_daemon_args", "git_status",
  ]),
};

// A serialized patch past this is dropped to `partial` (protects the 1 MB
// document ceiling and keeps range pages cheap).
export const CARGO_MAX_BYTES = 64 * 1024;

const SYSTEM_FIELDS = new Set(["_id", "_creationTime"]);

// Pure: the cargo for a write. `fields` is the patch (or the whole document
// when `full`). Denylisted keys are dropped and flagged partial; `undefined`
// values become `unset` entries (Convex unsets on undefined, and undefined
// cannot ride JSON). Unit-tested.
export function buildCargo(
  table: string,
  fields: Record<string, any>,
  opts: { full: boolean },
): Cargo {
  if (payloadsDisabled()) return { partial: true };
  const deny = PAYLOAD_DENYLIST[table];
  const patch: Record<string, any> = {};
  const unset: string[] = [];
  let partial = false;
  for (const [k, v] of Object.entries(fields)) {
    if (SYSTEM_FIELDS.has(k)) continue;
    if (deny?.has(k)) { partial = true; continue; }
    if (v === undefined) unset.push(k);
    else patch[k] = v;
  }
  let size = 0;
  try { size = JSON.stringify(patch).length; } catch { size = Infinity; }
  if (size > CARGO_MAX_BYTES) {
    return { unset: unset.length ? unset : undefined, full: opts.full || undefined, partial: true };
  }
  return {
    patch,
    unset: unset.length ? unset : undefined,
    full: opts.full || undefined,
    partial: partial || undefined,
  };
}

// Pure: coalesce merge (E2). The coalesced row must carry every field changed
// since it was last pruned, so a reader at ANY cursor below the new position
// converges: patch fields overlay (new wins), an unset removes the key from the
// merged patch, a key re-set drops out of unset. A full incoming cargo replaces
// (it is the whole document). An incoming cargo with no patch (kill switch, or
// oversized) poisons the row to partial so readers refetch. Unit-tested.
export function mergeCargo(prev: Cargo | null | undefined, next: Cargo): Cargo {
  if (!prev || !prev.patch) {
    // Nothing usable before (fresh row, or already partial without patch):
    // the new cargo stands, inheriting a prior partial flag only when the new
    // one is not full (a full doc supersedes everything).
    return next.full ? next : { ...next, partial: (prev?.partial && !next.patch) || next.partial || undefined };
  }
  if (next.full) return next;
  if (!next.patch) {
    // Poison: the row can no longer prove its own contents.
    return { unset: undefined, full: undefined, partial: true };
  }
  const patch = { ...prev.patch, ...next.patch };
  const unsetSet = new Set([...(prev.unset ?? []), ...(next.unset ?? [])]);
  for (const k of Object.keys(next.patch)) unsetSet.delete(k);
  for (const k of next.unset ?? []) delete patch[k];
  const unset = [...unsetSet];
  return {
    patch,
    unset: unset.length ? unset : undefined,
    full: prev.full || undefined,
    partial: prev.partial || next.partial || undefined,
  };
}

// ── Access stamp (E4) ────────────────────────────────────────────────────────

export type AccessStamp = {
  access_owner?: string;
  access_key?: string;
  access_grants?: string[];
};

// Document fields whose change can change WHO may read the row. A patch that
// touches none of these reuses the coalesced row's existing stamp (no doc
// read on the hot path); otherwise the stamp is re-read from the post-write
// document. Mirrors lib/access.ts: owner, assignee grant, workspace key.
export const ACCESS_FIELDS: ReadonlySet<string> = new Set(["user_id", "workspace", "assignee"]);

export function touchesAccessFields(fields: Record<string, any>): boolean {
  for (const k of Object.keys(fields)) if (ACCESS_FIELDS.has(k)) return true;
  return false;
}

// Pure: the access stamp of a document. Conversations carry only the owner
// (they are owner-scope-only; their real rule is not owner-or-team and never
// needs evaluating here). Unit-tested.
export function accessStampFromDoc(table: string, doc: any): AccessStamp | null {
  if (!doc?.user_id) return null;
  const stamp: AccessStamp = { access_owner: String(doc.user_id) };
  if (table !== "conversations" && doc.workspace) stamp.access_key = String(doc.workspace);
  if (table === "tasks" && doc.assignee) stamp.access_grants = [String(doc.assignee)];
  return stamp;
}

// Pure: may this caller read the row's cargo? A row with no stamp is a
// pre-cargo row: it carries no cargo either, so passing it through is safe
// (the client fetches through the authorized byIds path). Unit-tested.
export function authorizedFor(
  row: { access_owner?: string; access_key?: string; access_grants?: string[] },
  userId: string,
  heldKeys: ReadonlySet<string>,
): boolean {
  if (!row.access_owner) return true;
  if (row.access_owner === userId) return true;
  if (row.access_grants?.includes(userId)) return true;
  if (row.access_key && heldKeys.has(row.access_key)) return true;
  return false;
}

export type ActionExtra = {
  cargo?: Cargo | null;
  // Lazily read the post-write access stamp (one memoized doc get); consulted
  // only when `accessMayChange` or the coalesced row has no stamp yet.
  access?: () => Promise<AccessStamp | null>;
  accessMayChange?: boolean;
};

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
  extra: ActionExtra = {},
): Promise<void> {
  if (syncLogDisabled()) return;
  // Dedupe is per (scope, entity, op) within the transaction, but a second
  // write to the same entity in one transaction still carries NEW cargo, so
  // dedupe only skips the position allocation — the cargo merges onto the row.
  const dedupeKey = `${scopeKey} ${entityId} ${op}`;
  const dedupeHit = !!collector && collector.seen.has(dedupeKey);
  collector?.seen.add(dedupeKey);
  const ts = Date.now();
  const position = dedupeHit ? null : await allocatePosition(db, collector, scopeKey, ts);
  if (entityType !== "scope") {
    const existing = await db
      .query("sync_actions")
      .withIndex("by_scope_entity", (q: any) =>
        q.eq("scope_key", scopeKey).eq("entity_id", entityId))
      .first();
    // Cargo: a delete clears it (nothing to apply, and a stale patch must not
    // resurrect on a later upsert); an upsert merges (E2).
    const cargoFields: Record<string, any> =
      op === "delete"
        ? { patch: undefined, unset: undefined, full: undefined, partial: undefined }
        : cargoRowFields(mergeCargo(existing, extra.cargo ?? { partial: true }));
    // Access stamp: reuse the coalesced row's stamp on the hot path; re-read
    // when the write could have changed who may read, or when no stamp exists.
    let accessFields: Record<string, any> = {};
    if (op !== "delete" && (extra.accessMayChange || !existing?.access_owner)) {
      const stamp = extra.access ? await extra.access() : null;
      if (stamp) {
        accessFields = {
          access_owner: stamp.access_owner,
          access_key: stamp.access_key,
          access_grants: stamp.access_grants,
        };
      }
    }
    if (existing) {
      await db.patch(existing._id, {
        ...(position === null ? {} : { position }),
        op, ts, entity_type: entityType, ...cargoFields, ...accessFields,
      });
      if (position !== null) collector?.positions.push({ scope_key: scopeKey, position });
      return;
    }
    if (position === null) return; // deduped but no row — nothing to merge onto
    await db.insert("sync_actions", {
      scope_key: scopeKey,
      position,
      entity_type: entityType,
      entity_id: entityId,
      op,
      ts,
      ...stripUndefined(cargoFields),
      ...stripUndefined(accessFields),
    });
    collector?.positions.push({ scope_key: scopeKey, position });
    return;
  }
  if (position === null) return;
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

function cargoRowFields(c: Cargo): Record<string, any> {
  return { patch: c.patch, unset: c.unset, full: c.full, partial: c.partial };
}

function stripUndefined(o: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
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
  extra: ActionExtra = {},
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
    await appendSyncAction(db, collector, scopeKey, entityType, entityId, op, extra);
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
    return readRangePage(ctx.db, args.scope_key, args.from, args.limit, {
      userId: String(userId),
      heldKeys: new Set(scopes),
    });
  },
});

// The post-auth body of getRange, extracted so the floor/resync and paging
// contract is unit-testable against a fake db (design D11).
export type RangeAction = {
  position: number;
  entity_type: string;
  entity_id: string;
  op: SyncOp;
  patch?: Record<string, any>;
  unset?: string[];
  full?: boolean;
  partial?: boolean;
};

// Per-caller projection (E4): the row as written for a reader who may see its
// cargo; a bare `delete` for one who may not. The caller's held keys are the
// same vocabulary as workspace keys (user:<id> plus every team:<id> membership).
export function projectAction(
  row: any,
  viewer: { userId: string; heldKeys: ReadonlySet<string> } | undefined,
): RangeAction {
  const base = {
    position: row.position,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
  };
  if (row.op !== "upsert") return { ...base, op: row.op };
  if (viewer && !authorizedFor(row, viewer.userId, viewer.heldKeys)) {
    return { ...base, op: "delete" };
  }
  return {
    ...base,
    op: "upsert",
    ...(row.patch !== undefined ? { patch: row.patch } : {}),
    ...(row.unset ? { unset: row.unset } : {}),
    ...(row.full ? { full: true } : {}),
    ...(row.partial ? { partial: true } : {}),
  };
}

export async function readRangePage(
  db: any,
  scopeKey: SyncScopeKey,
  from: number,
  limitArg?: number,
  viewer?: { userId: string; heldKeys: ReadonlySet<string> },
): Promise<{
  actions: RangeAction[];
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
    actions: page.map((r: any) => projectAction(r, viewer)),
    nextFrom: page.length > 0 ? page[page.length - 1].position : from,
    hasMore,
  };
}
