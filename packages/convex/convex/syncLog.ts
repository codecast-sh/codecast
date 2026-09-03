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
// preserve correctness because merge patches are idempotent (E1/E2): a reader that sees
// only the coalesced row gets a patch merged from every write since its base; a reader
// that sees both applies the same assignments twice; a thin (no cargo) reader refetches
// through byIds. Revocations (delete in a departed scope) land as their own ordered action.
//
// Cargo (docs/architecture/sync-log-cargo.md): rows carry the changed fields as
// a merge patch plus an access stamp; getRange projects each row per caller.
import { v } from "convex/values";
import { query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { ChangeEntity, ChangeScope } from "./changeLog";
import { accessStampFromDoc, authorizedFor, heldKeysFor, isUserGrant, type AccessStamp } from "./lib/access";
export { accessStampFromDoc, authorizedFor, type AccessStamp };

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
  // The payload was dropped by the size guard or the cargo kill switch; the
  // client applies what is here and refetches the row (sticky until a full
  // cargo replaces it). Denylisted fields NEVER mark partial — see `omitted`.
  partial?: boolean;
  // Names of OMIT-class fields the write touched but the row never carries on a
  // list row (docs.content …): no partial, but a client that derives something
  // from the field (a plan_mode doc's display_title) can decide to refetch.
  omitted?: string[];
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

// Fields that never ride the log (E3, OMIT class): the client's LIST rows never
// carry them (stripDoc / hydrateRow shed them; detail pages fetch them on
// demand), so dropping them silently loses nothing and must NOT mark the row
// partial — a partial that never heals would put every edited doc on the byIds
// path for life (review). Their NAMES ride along in `omitted` so a client that
// derives something from one (a plan_mode doc's display_title from content) can
// choose to refetch. For docs/plans `team_id` is here because the list channels
// REWRITE it to the effective team (stampEffectiveTeam); the client derives it
// from `workspace`. From the per-collection enrichment audit (pl-498).
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

// A serialized patch past this is dropped to `partial` — anything larger is
// cheaper as one byIds fetch than as cargo re-shipped on every coalescing move.
// Also the cap on the MERGED cargo (review: hot rows never prune, so their
// merged cargo would otherwise grow toward the whole document).
export const CARGO_MAX_BYTES = 16 * 1024;

export function cargoBytes(c: Cargo | null | undefined): number {
  if (!c?.patch) return 0;
  try { return JSON.stringify(c.patch).length; } catch { return Infinity; }
}

const SYSTEM_FIELDS = new Set(["_id", "_creationTime"]);

// Pure: the cargo for a write. `fields` is the patch (or the whole document
// when `full`). Denylisted keys are dropped and their names recorded in
// `omitted` (never partial); churn-exempt keys are dropped silently; an
// oversized patch or the kill switch yields `partial`. `undefined` values
// become `unset` entries (Convex unsets on undefined, and undefined cannot ride
// JSON). Unit-tested.
export function buildCargo(
  table: string,
  fields: Record<string, any>,
  opts: { full: boolean },
): Cargo {
  if (payloadsDisabled()) return { partial: true };
  const deny = PAYLOAD_DENYLIST[table];
  // Churn-exempt fields never ride cargo (review): churn-only writes emit no
  // action, so a churn value captured on a semantic write would go stale in
  // the coalesced row and revert the live value on the next move. The live
  // window and the liveness overlay own those fields (D1).
  const churn = CHURN_ONLY_FIELDS[table];
  const patch: Record<string, any> = {};
  const unset: string[] = [];
  const omitted: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (SYSTEM_FIELDS.has(k) || churn?.has(k)) continue;
    if (deny?.has(k)) { omitted.push(k); continue; }
    if (v === undefined) unset.push(k);
    else patch[k] = v;
  }
  const base = {
    unset: unset.length ? unset : undefined,
    full: opts.full || undefined,
    omitted: omitted.length ? omitted : undefined,
  };
  if (cargoBytes({ patch }) > CARGO_MAX_BYTES) return { ...base, partial: true };
  return { patch, ...base };
}

// Pure: coalesce merge (E2). The coalesced row must carry every field changed
// since it was last pruned, so a reader at ANY cursor below the new position
// converges: patch fields overlay (new wins), an unset removes the key from the
// merged patch, a key re-set drops out of unset. A full incoming cargo replaces
// (it is the whole document). An incoming cargo with no patch (kill switch, or
// oversized) poisons the row to partial so readers refetch. Unit-tested.
export function mergeCargo(prev: Cargo | null | undefined, next: Cargo): Cargo {
  // A full cargo is the whole document: it supersedes everything, including a
  // prior partial (that is the self-heal path). Accumulated `unset` names
  // survive (minus keys the full doc carries): a reader with a base that still
  // holds a field the document dropped must learn it is gone (review).
  if (next.full) {
    const carried = (prev?.unset ?? []).filter((k) => !(next.patch && k in next.patch));
    const unsetSet = new Set([...carried, ...(next.unset ?? [])]);
    return { ...next, unset: unsetSet.size ? [...unsetSet] : undefined, omitted: mergeOmittedNames(prev?.omitted, next.omitted) };
  }
  const omittedSet = new Set([...(prev?.omitted ?? []), ...(next.omitted ?? [])]);
  const omitted = omittedSet.size ? [...omittedSet] : undefined;
  // partial is STICKY (review): a reader whose cursor sat below the old
  // position sees only the coalesced row, and must keep refetching until a full
  // cargo proves the row's contents again.
  // An EXISTING row without a patch (a pre-cargo row, or a delete tombstone the
  // entity re-enters through) cannot prove its contents: a thin patch merged
  // onto it would hide every earlier change from a reader below its position.
  // Treat it as partial — the self-heal then rebuilds a full cargo (review).
  const partial = prev?.partial || next.partial || (prev && !prev.patch ? true : undefined) || undefined;
  if (!prev || !prev.patch) return { ...next, partial, omitted };
  if (!next.patch) {
    // Poison: the row can no longer prove its own contents.
    return { partial: true, omitted };
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
    partial,
    omitted,
  };
}

// Fields a member row's cargo always carries, whether or not the write touched
// them (review): a replica that does not hold the row cannot otherwise learn
// which HELD project's joined counts a status change moved (buildCargo ships
// the patched fields only, and a status-only patch never names the project).
// Read from the post-write document the access stamp already memoizes, so this
// costs no extra read. A delete tombstone carries no cargo, so the delete and
// the move of an unheld member stay client-invisible (E8 residuals).
export const STICKY_CARGO_FIELDS: Record<string, readonly string[]> = {
  tasks: ["project_id"],
  plans: ["project_id"],
  docs: ["project_id"],
};

async function withStickyFields(extra: ActionExtra): Promise<Cargo> {
  const cargo = extra.cargo ?? { partial: true };
  const sticky = extra.table ? STICKY_CARGO_FIELDS[extra.table] : undefined;
  if (!sticky || !cargo.patch || cargo.full) return cargo;
  const missing = sticky.filter((f) => !(f in cargo.patch!));
  if (!missing.length || !extra.fullDoc) return cargo;
  const doc = await extra.fullDoc();
  if (!doc) return cargo;
  const patch = { ...cargo.patch };
  for (const f of missing) if (doc[f] !== undefined) patch[f] = doc[f];
  return { ...cargo, patch };
}

export type ActionExtra = {
  cargo?: Cargo | null;
  // The post-write access stamp. ALWAYS consulted for an upsert (review: a
  // reused stamp can outlive a scope move or a delete tombstone and ship cargo
  // to readers who lost access); the interceptor memoizes the doc read.
  access?: () => Promise<AccessStamp | null>;
  // The post-write document, for the partial self-heal: when the merged cargo
  // is partial or over the byte cap, a full cargo built from the document
  // replaces it if it fits (denylist applied), so partial is a one-time state
  // for a hot row, not a permanent one.
  fullDoc?: () => Promise<any | null>;
  table?: string;
};

export function userScopeKey(userId: string): SyncScopeKey {
  return `user:${userId}`;
}
export function teamScopeKey(teamId: string): SyncScopeKey {
  return `team:${teamId}`;
}

// The scopes an entity's actions land in — derived from ACCESS, not routing
// (sync-log-cargo E4, review): owner always; the workspace key's team when the
// stored key is a team key; each explicit grant (a task's assignee) in their
// own user scope; conversations owner-only (the inbox is owner-only and team
// activity is a separate axis). A routing team_id whose workspace is
// user:<owner> (private inside a team) therefore never enters the team scope:
// no existence leak, no projected-delete probes, and every reader who may read
// a row holds a scope it fans to — the property retiring the live lists needs.
// Pure — unit-tested.
export function scopesForChange(entityType: ChangeEntity, scope: ChangeScope): SyncScopeKey[] {
  if (!scope.owner_user_id) return [];
  const scopes = [userScopeKey(scope.owner_user_id)];
  if (entityType === "conversations") return scopes;
  const ws = scope.workspace;
  if (typeof ws === "string" && ws.startsWith("team:")) scopes.push(teamScopeKey(ws.slice(5)));
  if (entityType === "tasks" && isUserGrant(scope.assignee) && scope.assignee !== scope.owner_user_id) {
    const g = userScopeKey(scope.assignee!);
    if (!scopes.includes(g)) scopes.push(g);
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
    // Cargo: a delete clears it AND the access stamp (nothing to apply, a stale
    // patch must not resurrect on a later upsert, and a tombstone's stamp must
    // never be reused by a re-entering row); an upsert merges (E2).
    let cargoFields: Record<string, any>;
    let accessFields: Record<string, any> = {};
    if (op === "delete") {
      cargoFields = {
        patch: undefined, unset: undefined, full: undefined, partial: undefined, omitted: undefined,
        access_owner: undefined, access_key: undefined, access_grants: undefined,
      };
    } else {
      let merged = mergeCargo(existing, await withStickyFields(extra));
      // Self-heal (review): a partial or oversized merged cargo is replaced by
      // a full cargo from the post-write document when that fits, otherwise
      // poisoned to partial-without-patch (the client refetches).
      if (merged.partial || cargoBytes(merged) > CARGO_MAX_BYTES) {
        const doc = extra.fullDoc && extra.table && !payloadsDisabled() ? await extra.fullDoc() : null;
        const full = doc ? buildCargo(extra.table!, doc, { full: true }) : null;
        merged = full && full.patch && !full.partial
          ? { ...full, omitted: mergeOmitted(merged.omitted, full.omitted) }
          : { partial: true, omitted: merged.omitted };
      }
      cargoFields = cargoRowFields(merged);
      // Access stamp: always from the post-write document (never reused).
      const stamp = extra.access ? await extra.access() : null;
      accessFields = {
        access_owner: stamp?.access_owner,
        access_key: stamp?.access_key,
        access_grants: stamp?.access_grants,
      };
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
  return { patch: c.patch, unset: c.unset, full: c.full, partial: c.partial, omitted: c.omitted };
}

function mergeOmittedNames(a?: string[], b?: string[]): string[] | undefined {
  const set = new Set([...(a ?? []), ...(b ?? [])]);
  return set.size ? [...set] : undefined;
}

function mergeOmitted(a?: string[], b?: string[]): string[] | undefined {
  const set = new Set([...(a ?? []), ...(b ?? [])]);
  return set.size ? [...set] : undefined;
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

// Transitional revocation (review): before cargo the log fanned on team_id, so
// an entity can still hold an `upsert` row in a routing team scope that its
// access-derived scopes no longer include. Any write to the entity flips that
// stale row to a delete, so readers who cached it under the old fan-out drop
// it. Cheap: one indexed lookup, only when the change_log row names a team the
// current scopes do not.
export async function revokeStaleScope(
  db: any,
  collector: SyncAckCollector | null,
  entityType: ChangeEntity,
  entityId: string,
  staleScope: SyncScopeKey,
  currentScopes: readonly SyncScopeKey[],
): Promise<void> {
  if (currentScopes.includes(staleScope)) return;
  const row = await db
    .query("sync_actions")
    .withIndex("by_scope_entity", (q: any) => q.eq("scope_key", staleScope).eq("entity_id", entityId))
    .first();
  if (row && row.op === "upsert") {
    await appendSyncAction(db, collector, staleScope, entityType, entityId, "delete");
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

// The caller's scope heads. Tiny payload — this is the live subscription that wakes the
// client applier; it re-runs on tracked writes only (never on heartbeats or messages).
export const getHeads = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { heads: [] };
    // The caller's held keys ARE their scopes (fan-out is access-derived).
    const scopes = await heldKeysFor(ctx, userId);
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
    // Cargo opt-in (review): only clients that apply patches ask for them, so
    // deployed bundles that ignore cargo keep today's ~150-byte rows. Absent →
    // thin rows. Also the client-side kill switch (no env change needed).
    cargo: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { actions: [], nextFrom: args.from, hasMore: false };
    const scopes = await heldKeysFor(ctx, userId);
    if (!scopes.has(args.scope_key)) {
      // Not an error (a client can race a scope_removed), but it must be
      // DISTINGUISHABLE from an empty caught-up scope: the applier treats it as
      // scope revocation (purge + drop cursor), and the applier's heads-absence
      // sweep is the backstop when the scope_removed action itself was already
      // retention-pruned (design D5).
      return { actions: [], nextFrom: args.from, hasMore: false, authorized: false };
    }
    return readRangePage(ctx.db, args.scope_key, args.from, args.limit, {
      userId: String(userId),
      heldKeys: scopes,
    }, { cargo: !!args.cargo });
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
  omitted?: string[];
};

// Per-caller projection (E4): the row as written for a reader who may see its
// cargo; a bare `delete` for one who may not. A row with no stamp ships no
// cargo (fail closed — the client falls back to byIds). Cargo rides only when
// the caller opted in. The caller's held keys are the same vocabulary as
// workspace keys (user:<id> plus every team:<id> membership).
export function projectAction(
  row: any,
  viewer: { userId: string; heldKeys: ReadonlySet<string> } | undefined,
  includeCargo: boolean = true,
): RangeAction {
  const base = {
    position: row.position,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
  };
  if (row.op !== "upsert") return { ...base, op: row.op };
  if (!row.access_owner) return { ...base, op: "upsert" };
  if (viewer && !authorizedFor(row, viewer.userId, viewer.heldKeys)) {
    return { ...base, op: "delete" };
  }
  if (!includeCargo) return { ...base, op: "upsert" };
  return {
    ...base,
    op: "upsert",
    ...(row.patch !== undefined ? { patch: row.patch } : {}),
    ...(row.unset ? { unset: row.unset } : {}),
    ...(row.full ? { full: true } : {}),
    ...(row.partial ? { partial: true } : {}),
    ...(row.omitted ? { omitted: row.omitted } : {}),
  };
}

// Range pages are bounded by BYTES as well as rows (review: 500 rows × cargo
// can exceed Convex's return cap). A page closes at the first action that
// would push the serialized page past this; the client resumes from nextFrom.
export const RANGE_PAGE_MAX_BYTES = 1024 * 1024;

export async function readRangePage(
  db: any,
  scopeKey: SyncScopeKey,
  from: number,
  limitArg?: number,
  viewer?: { userId: string; heldKeys: ReadonlySet<string> },
  opts: { cargo?: boolean } = {},
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
  let page = rows.slice(0, limit);
  let hasMore = rows.length > limit;
  const actions: RangeAction[] = [];
  let bytes = 0;
  for (let i = 0; i < page.length; i++) {
    const a = projectAction(page[i], viewer, !!opts.cargo);
    const size = a.patch ? cargoBytes(a) + 64 : 64;
    if (actions.length > 0 && bytes + size > RANGE_PAGE_MAX_BYTES) {
      page = page.slice(0, i);
      hasMore = true;
      break;
    }
    bytes += size;
    actions.push(a);
  }
  return {
    actions,
    nextFrom: page.length > 0 ? page[page.length - 1].position : from,
    hasMore,
  };
}
