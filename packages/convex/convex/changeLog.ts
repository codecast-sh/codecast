// Cross-entity change feed — emission side.
//
// The write interceptor in functions.ts calls into here on every insert / patch
// / replace / delete to a tracked table. We keep ONE row per entity in
// `change_log` (keyed by entity_id) and bump its `seq` to now on each change, so
// the table is bounded by entity count, not change volume — a conversation
// touched on every message batch updates a single row in place.
//
// The pure helpers (scopeFromDoc / decidePatchScope) are unit-tested without a
// db; the db-touching emit/lookup are thin shells around them.
import {
  accessStampFromDoc,
  buildCargo,
  emitScopeAction,
  emitSyncActions,
  isChurnOnlyPatch,
  touchesAccessFields,
  type SyncAckCollector,
} from "./syncLog";

// One memoized post-write document read per tracked write, consulted by the
// sync log only when the access stamp must be (re)computed (sync-log-cargo E4).
function lazyAccess(rawDb: any, table: string, id: any, known?: any) {
  let cached: Promise<any> | null = known !== undefined ? Promise.resolve(known) : null;
  return async () => accessStampFromDoc(table, await (cached ??= rawDb.get(id)));
}

export type ChangeEntity =
  | "conversations"
  | "tasks"
  | "docs"
  | "plans"
  | "projects";

// The tables whose writes feed the change log. A table is tracked iff its rows
// carry the uniform { user_id, team_id? } scope shape every catch-up query relies
// on. Keep in sync with the change_log.entity_type union in schema.ts.
export const TRACKED_TABLES: ReadonlySet<ChangeEntity> = new Set([
  "conversations",
  "tasks",
  "docs",
  "plans",
  "projects",
]);

export type ChangeScope = {
  owner_user_id: string | undefined;
  team_id: string | undefined;
};

// The owner/team scope of an entity, read straight off its document. Every
// tracked table uses these exact field names (verified against schema.ts), so
// one extractor covers them all. Pure — unit-tested.
export function scopeFromDoc(doc: any): ChangeScope {
  return {
    owner_user_id: doc?.user_id ? String(doc.user_id) : undefined,
    team_id: doc?.team_id ? String(doc.team_id) : undefined,
  };
}

// Whether a patch needs a fresh document read to resolve scope, or can reuse the
// scope already recorded on the entity's change_log row. A read is needed when
// the patch could MOVE the entity between scopes (touches user_id/team_id) or
// when there's no prior row to reuse. Pure — unit-tested. Keeps the hot path
// (e.g. a message batch bumping a conversation) to one indexed lookup, no extra
// document get, in the common "ordinary field changed" case.
export function patchNeedsDocRead(
  patchFields: Record<string, any>,
  hasExistingRow: boolean,
): boolean {
  return !hasExistingRow || "user_id" in patchFields || "team_id" in patchFields;
}

// Identify which tracked table an id belongs to. `db.normalizeId(table, id)` is a
// pure string check (no document read) that returns the id iff it belongs to
// that table's id space, so this costs at most one cheap check per tracked table
// and never a query. Returns null for untracked ids (the interceptor then skips
// emission).
export function trackedTableOf(db: any, id: any): ChangeEntity | null {
  for (const table of TRACKED_TABLES) {
    if (db.normalizeId(table, id)) return table;
  }
  return null;
}

// The single existing change_log row for an entity (or null). first() not
// unique(): a rare concurrent double-insert leaves a duplicate that is harmless
// (catch-up dedups by entity id) rather than throwing on read.
export async function lookupChangeRow(db: any, entityId: string): Promise<any | null> {
  return db
    .query("change_log")
    .withIndex("by_entity", (q: any) => q.eq("entity_id", entityId))
    .first();
}

// Upsert the entity's change_log row to { op, seq=now, scope }. `db` MUST be the
// raw (un-wrapped) writer so this never re-enters the interceptor. Skips silently
// if the scope has no owner — a tracked row always has user_id, so a missing one
// means the document was already gone (e.g. delete of an absent id).
export async function emitChange(
  db: any,
  entityType: ChangeEntity,
  entityId: string,
  op: "upsert" | "delete",
  scope: ChangeScope,
  existing?: any | null,
): Promise<void> {
  if (!scope.owner_user_id) return;
  const seq = Date.now();
  const row = existing !== undefined ? existing : await lookupChangeRow(db, entityId);
  const fields = {
    entity_type: entityType,
    entity_id: entityId,
    op,
    owner_user_id: scope.owner_user_id as any,
    team_id: scope.team_id as any,
    seq,
  };
  if (row) {
    await db.patch(row._id, { op, seq, owner_user_id: fields.owner_user_id, team_id: fields.team_id, entity_type: entityType });
  } else {
    await db.insert("change_log", fields);
  }
}

// Wrap a raw Convex DatabaseWriter so every insert/patch/replace/delete to a
// tracked table also upserts the entity's change_log row AND appends the entity's
// sync-log actions (syncLog.ts — the ordered per-scope log that supersedes this
// table's Date.now() heuristic for new clients; both are written until deployed
// bundles roll off getChangesSince). Reads and id helpers pass straight through.
// The interceptor's own change_log/sync_log writes go through the RAW db handed in
// here, so they never re-enter the wrapper (no recursion; both tables are
// untracked regardless). functions.ts builds the custom mutation ctx from this;
// tests drive it with a fake in-memory db. Pure factory — it loads without the
// Convex runtime.
//
// `collector` (optional) accumulates the sync positions this transaction appended;
// dispatch returns them to an opting-in client as its write acknowledgement.
export function makeChangeTrackedDb(rawDb: any, collector: SyncAckCollector | null = null): any {
  // Only wrap a real Convex DatabaseWriter, detected via normalizeId — the
  // table-from-id primitive the interceptor relies on. A partial test mock that
  // lacks it is returned untouched, so the interceptor never changes a mock's
  // behaviour. In production ctx.db always has normalizeId, so this always wraps.
  if (typeof rawDb.normalizeId !== "function") return rawDb;
  return {
    get: (...args: any[]) => rawDb.get(...args),
    query: (...args: any[]) => rawDb.query(...args),
    normalizeId: (...args: any[]) => rawDb.normalizeId(...args),
    system: rawDb.system,

    async insert(table: string, doc: any) {
      const id = await rawDb.insert(table, doc);
      if (TRACKED_TABLES.has(table as any)) {
        const scope = scopeFromDoc(doc);
        await emitChange(rawDb, table as ChangeEntity, String(id), "upsert", scope, null);
        await emitSyncActions(rawDb, collector, table as ChangeEntity, String(id), "upsert", scope, null, {
          cargo: buildCargo(table, doc, { full: true }),
          access: lazyAccess(rawDb, table, id, doc),
          accessMayChange: true,
        });
      } else if (table === "team_memberships" && doc?.user_id && doc?.team_id) {
        await emitScopeAction(rawDb, collector, String(doc.user_id), String(doc.team_id), "scope_added");
      }
      return id;
    },

    async patch(id: any, fields: any) {
      const table = trackedTableOf(rawDb, id);
      // A patch that touches scope fields can MOVE the entity between scopes; the
      // departed scope needs a revocation action, which requires the pre-write doc.
      const movesScope = !!table && ("user_id" in fields || "team_id" in fields);
      const preDoc = movesScope ? await rawDb.get(id) : null;
      const res = await rawDb.patch(id, fields);
      if (table) {
        const entityId = String(id);
        const existing = await lookupChangeRow(rawDb, entityId);
        let scope: ChangeScope;
        if (patchNeedsDocRead(fields, !!existing)) {
          const doc = await rawDb.get(id);
          scope = doc
            ? scopeFromDoc(doc)
            : { owner_user_id: existing?.owner_user_id, team_id: existing?.team_id };
        } else {
          scope = { owner_user_id: existing.owner_user_id, team_id: existing.team_id };
        }
        await emitChange(rawDb, table, entityId, "upsert", scope, existing);
        // Churn exemption (design D1): counter/liveness-only patches never touch
        // the sync log — emitting them would serialize every streaming session of
        // a user on one head row and wake every online client per message flush.
        // The live snapshot floor re-delivers these fields on reconnect.
        if (!isChurnOnlyPatch(table, fields)) {
          await emitSyncActions(
            rawDb, collector, table, entityId, "upsert", scope,
            preDoc ? scopeFromDoc(preDoc) : null,
            {
              cargo: buildCargo(table, fields, { full: false }),
              access: lazyAccess(rawDb, table, id),
              accessMayChange: touchesAccessFields(fields),
            },
          );
        }
      }
      return res;
    },

    async replace(id: any, doc: any) {
      const table = trackedTableOf(rawDb, id);
      const preDoc = table ? await rawDb.get(id) : null;
      const res = await rawDb.replace(id, doc);
      if (table) {
        // `undefined` (not null): a replaced entity usually already has a
        // change_log row from its insert — look it up and flip it, don't add one.
        await emitChange(rawDb, table, String(id), "upsert", scopeFromDoc(doc));
        await emitSyncActions(
          rawDb, collector, table, String(id), "upsert", scopeFromDoc(doc),
          preDoc ? scopeFromDoc(preDoc) : null,
          {
            cargo: buildCargo(table, doc, { full: true }),
            access: lazyAccess(rawDb, table, id, doc),
            accessMayChange: true,
          },
        );
      }
      return res;
    },

    async delete(id: any) {
      const table = trackedTableOf(rawDb, id);
      const membershipDoc =
        !table && typeof rawDb.normalizeId === "function" && rawDb.normalizeId("team_memberships", id)
          ? await rawDb.get(id)
          : null;
      // Read scope BEFORE the row is gone.
      const scope = table ? scopeFromDoc(await rawDb.get(id)) : null;
      const res = await rawDb.delete(id);
      if (table && scope) {
        // `undefined`: find the entity's existing upsert row and flip it to a
        // delete tombstone, rather than inserting a duplicate.
        await emitChange(rawDb, table, String(id), "delete", scope);
        await emitSyncActions(rawDb, collector, table, String(id), "delete", scope);
      } else if (membershipDoc?.user_id && membershipDoc?.team_id) {
        await emitScopeAction(
          rawDb, collector, String(membershipDoc.user_id), String(membershipDoc.team_id), "scope_removed",
        );
      }
      return res;
    },
  };
}
