import { isDraft, original } from "mutative";
import { applySyncRecord, applySyncTable } from "./syncProtocol";
import { defaultIsServerId } from "./middleware";
import type { MergeSpec, PendingEntry, PlatformConfig, SyncOpts } from "./types";

/**
 * How one incoming value merges onto its local twin.
 *
 *   replace     — server wins outright.
 *   local_wins  — a local value beats the server echo (objects merge per key,
 *                 so a key only the server has still flows in).
 *   set_union   — union of both arrays.
 *   deep_merge  — server keys win, local keys survive where the server is silent.
 * A nested map applies one spec per field; a function is an app-supplied rule.
 */
export function applyMerge(local: any, server: any, spec: MergeSpec, initialized: boolean): any {
  if (typeof spec === "function") return spec(local, server, initialized);
  if (typeof spec === "string") {
    switch (spec) {
      case "replace": return server;
      case "local_wins":
        if (!initialized || local == null) return server;
        if (typeof local === "object" && typeof server === "object"
            && !Array.isArray(local) && !Array.isArray(server)) {
          return { ...server, ...local };
        }
        return local;
      case "set_union":
        return [...new Set([...(server ?? []), ...(local ?? [])])];
      case "deep_merge":
        if (local != null && server != null && typeof local === "object" && typeof server === "object"
            && !Array.isArray(local) && !Array.isArray(server)) {
          return { ...local, ...server };
        }
        return server ?? local;
      default: return server;
    }
  }
  const result = { ...server };
  for (const [key, fieldSpec] of Object.entries(spec as Record<string, MergeSpec>)) {
    result[key] = applyMerge(local?.[key], server?.[key], fieldSpec, initialized);
  }
  return result;
}

// Rename pending protection entries from oldId → newId so field overrides
// survive the stub-to-server-id transition. Scoped to ONE collection (field):
// pending keys are `<field>:<id>` (record) and `<field>:<id>:<name>` (field
// override). A blunt `:oldId` replace across all keys corrupts an unrelated
// collection that happens to key a row by the same id — e.g. a compose whose
// draft client id equals its optimistic thread stub id, where rekeying the
// thread would otherwise rewrite the `drafts:<clientId>` lock too.
export function rekeyPending(
  pending: Record<string, PendingEntry>,
  oldId: string,
  newId: string,
  field?: string,
): void {
  const recordKey = field ? `${field}:${oldId}` : null;
  const fieldPrefix = field ? `${field}:${oldId}:` : null;
  for (const key of Object.keys(pending)) {
    let newKey: string;
    if (field) {
      if (key === recordKey) newKey = `${field}:${newId}`;
      else if (key.startsWith(fieldPrefix!)) newKey = `${field}:${newId}:${key.slice(fieldPrefix!.length)}`;
      else continue;
    } else {
      newKey = key.replace(`:${oldId}`, `:${newId}`);
      if (newKey === key) continue;
    }
    pending[newKey] = pending[key];
    delete pending[key];
  }
}

export type SyncEngine = {
  /** Apply an incoming payload for one store key onto the draft. */
  syncTable: (draft: any, field: string, incoming: any, opts?: SyncOpts) => void;
  /** Apply one incoming record of a collection onto the draft. */
  syncRecord: (draft: any, field: string, id: string, record: any) => void;
  /**
   * Merge a small high-churn map (id → changed fields) onto a base collection's
   * existing rows, touching only changed fields so unchanged rows keep object
   * identity (React.memo holds). The base list owns the stable fields; the
   * overlay carries only the churny ones. Rows the base doesn't have yet are
   * skipped — an overlay never creates a row, it only annotates one.
   */
  syncOverlay: (draft: any, field: string, overlayById: Record<string, Record<string, any>>) => void;
};

/**
 * Build the sync recipes for one config. The store they write into must carry a
 * `pending` map — that is where the engine records which local writes are still
 * waiting for the server to agree.
 */
export function createSyncEngine(config: PlatformConfig): SyncEngine {
  const syncRegistry = config.syncRegistry ?? {};
  const isServerId = config.isServerId ?? defaultIsServerId;
  const optionalClearFields = config.optionalClearFields;
  const rekeyExtra = config.rekeyExtra;

  function syncTable(draft: any, field: string, incoming: any, opts?: SyncOpts): void {
    if (!incoming && incoming !== 0) return;
    const cfg: SyncOpts = syncRegistry[field] ? { ...syncRegistry[field], ...opts } : (opts || {});
    const kind = cfg.kind ?? "collection";

    if (kind === "scalar" || kind === "list") {
      if (cfg.normalize) incoming = cfg.normalize(incoming);
      // No-op re-pushes are common — a list-kind subscription re-emits on any
      // read-set change — and a wholesale assign registers as a change: every
      // subscriber wakes and the persistence layer re-puts the whole meta blob
      // to IDB. Bail when the payload is value-identical. Skipped when a
      // transform/extra is registered (those reconcile local pending state even
      // against an identical payload). These lists are small, so the JSON
      // compare is far cheaper than the wake + IDB put it avoids.
      if (!cfg.transform && !cfg.extra) {
        const current = draft[field];
        if (Object.is(current, incoming)) return;
        if (kind === "list" && Array.isArray(current) && Array.isArray(incoming) &&
            JSON.stringify(current) === JSON.stringify(incoming)) return;
      }
      draft[field] = incoming;
      if (cfg.transform) cfg.transform(draft, incoming, incoming, false);
      if (cfg.extra) Object.assign(draft, cfg.extra);
      return;
    }

    if (kind === "singleton") {
      if (cfg.normalize) incoming = cfg.normalize(incoming);
      const local = draft[field];
      const initKey = `${field}Initialized`;
      const initialized = draft[initKey] ?? false;
      // Same no-op bail as list-kind above: a singleton re-pushes on every
      // heartbeat that touches its document, and each accepted push is a new
      // object identity that wakes every subscriber. `local &&` keeps the first
      // real write landing (and setting the init flag below) unconditionally.
      if (!cfg.transform && !cfg.merge && !cfg.extra &&
          local && incoming && JSON.stringify(local) === JSON.stringify(incoming)) {
        return;
      }
      const result = cfg.merge
        ? applyMerge(local, incoming, cfg.merge, initialized)
        : incoming;
      draft[field] = result;
      if (cfg.transform) cfg.transform(draft, result, incoming, initialized);
      if (initKey in draft) draft[initKey] = true;
      if (cfg.extra) Object.assign(draft, cfg.extra);
      return;
    }

    // collection
    // A non-array here is a broken contract, not data: a field renamed out of
    // the registry while a stale feeder still pushes its old scalar shape, or
    // a server shape change inside a deploy window. Drop the push and keep the
    // cached rows — throwing here would unmount whatever boundary runs the
    // feeders, stopping every feeder rather than just the bad one.
    if (!Array.isArray(incoming)) {
      if (process.env.NODE_ENV !== "production") {
        console.error(`[sync] ${field}: collection push is not an array (${typeof incoming}); dropped`);
      }
      return;
    }
    // Read the previous collection and pending map from the BASE state, not
    // through the draft: applySyncTable walks every row of prev, and each read
    // through the mutative proxy allocates a child draft (a large collection
    // crawled every sync made this the top idle cost). The decision is made on
    // plain objects; only the final assignment touches the draft.
    const base: any = isDraft(draft) ? original(draft) : draft;
    const prevCollection = base[field] || {};
    let { table, pending } = applySyncTable(
      field, incoming, base.pending, prevCollection,
      (cfg.isDelta || cfg.ignoreFields || cfg.deepFields || cfg.preserveFields || cfg.pruneAbsentScope || optionalClearFields)
        ? {
            isDelta: cfg.isDelta,
            ignoreFields: cfg.ignoreFields,
            deepFields: cfg.deepFields,
            preserveFields: cfg.preserveFields,
            pruneAbsentScope: cfg.pruneAbsentScope,
            optionalClearFields,
          }
        : undefined,
    );

    if (cfg.altKey) {
      // applySyncTable hands back the BASE table/pending objects when a push
      // changed nothing. The rekey below mutates in place, so copy on first
      // write — never touch base state, and keep the untouched identity (no
      // subscriber wake) when no stub matched.
      const mutTable = () => { if (table === prevCollection) table = { ...table }; return table; };
      const mutPending = () => { if (pending === base.pending) pending = { ...pending }; return pending; };
      const incomingByAlt = new Map(
        (incoming as any[]).map((r: any) => [r[cfg.altKey!], r])
      );
      for (const [oldId, old] of Object.entries(prevCollection)) {
        if (isServerId(oldId)) continue;
        const match = incomingByAlt.get((old as any)[cfg.altKey!] || oldId);
        if (match) {
          // The app rekeys whatever else points at the stub id (open views,
          // drafts, child pointers) before the row itself moves.
          rekeyExtra?.(draft, oldId, match._id);
          rekeyPending(mutPending(), oldId, match._id, field);
          // The server sent a row matching the stub's alt key — that IS the
          // acknowledgement the stub's `include` lock was waiting for. Clear
          // it; in delta mode applySyncTable never would (absence != deletion),
          // so it would otherwise linger forever, one dead lock per create.
          if (pending[`${field}:${match._id}`] !== undefined) {
            delete mutPending()[`${field}:${match._id}`];
          }
          if (oldId !== match._id && table[oldId]) {
            mutTable();
            if (!table[match._id]) {
              table[match._id] = { ...(table[oldId] as any), _id: match._id };
            } else if (cfg.preserveFields) {
              // applySyncTable can only preserve an overlay field when prev and
              // incoming share an id. An alt-key match is the stub→real case:
              // carry those same local-only fields across before discarding the
              // old row, or a reload-time rekey drops durable post-create intent.
              for (const pf of cfg.preserveFields) {
                if (
                  (table[match._id] as any)[pf] == null &&
                  (table[oldId] as any)[pf] != null
                ) {
                  table[match._id] = {
                    ...(table[match._id] as any),
                    [pf]: (table[oldId] as any)[pf],
                  };
                }
              }
            }
            delete table[oldId];
          }
          // Reapply field overrides that applySyncTable missed (it ran
          // before the pending entries were rekeyed to the new id). Row copy,
          // not in-place write: the row object may still be base state.
          const fp = `${field}:${match._id}:`;
          for (const [key, entry] of Object.entries(pending)) {
            if (entry.type !== "field" || !key.startsWith(fp)) continue;
            if (table[match._id]) {
              mutTable()[match._id] = { ...(table[match._id] as any), [key.slice(fp.length)]: entry.value };
            }
          }
        } else if (!table[oldId]) {
          mutTable()[oldId] = old as any;
        }
      }
    }

    if (cfg.keepSelected) {
      const selectedId = draft[cfg.keepSelected];
      if (selectedId && !table[selectedId] && prevCollection[selectedId]) {
        // table !== prevCollection here (prev has the row, table doesn't).
        table[selectedId] = prevCollection[selectedId];
      }
    }

    // No-op bail: same key set and every row is the same version. A version is
    // the row's timestamp when BOTH sides carry one (snake or camel — rows are
    // usually camelized on the way in, and a comparison of a field neither side
    // has would call every patched row unchanged and drop it), else identity —
    // applySyncTable hands back the previous row object whenever nothing changed.
    // The pending map must land even when the rows didn't: an echo that CLEARS
    // a local-first field protection changes pending, not the table.
    if (!cfg.altKey && !cfg.extra && !cfg.transform && !cfg.force && base.pending === pending) {
      if (prevCollection) {
        const newKeys = Object.keys(table);
        if (newKeys.length === Object.keys(prevCollection).length &&
            newKeys.every(k => sameVersion(prevCollection[k], table[k]))) {
          return;
        }
      }
    }

    // applySyncTable returns the PREVIOUS table/pending objects untouched when
    // a push changed nothing (whole-collection identity reuse) — skip the draft
    // writes so a no-op sync produces no commit at all.
    if (base[field] !== table) draft[field] = table;
    if (base.pending !== pending) draft.pending = pending;
    if (cfg.transform) cfg.transform(draft, table, incoming, false, prevCollection);
    if (cfg.extra) Object.assign(draft, cfg.extra);
  }

  function sameVersion(prev: any, next: any): boolean {
    if (prev === next) return true;
    if (!prev || !next) return false;
    for (const f of ["updated_at", "updatedAt"]) {
      if (prev[f] !== undefined && next[f] !== undefined) return prev[f] === next[f];
    }
    return false;
  }

  function syncRecord(draft: any, field: string, id: string, record: any): void {
    // Apply pending protection: local-first field values win over server
    const { record: protectedRecord, pending: newPending } =
      applySyncRecord(field, id, record, draft.pending, optionalClearFields);
    draft.pending = newPending;

    // Exclude pending — entire record blocked from sync
    const excludeKey = `${field}:${id}`;
    if (draft.pending[excludeKey]?.type === "exclude") return;

    const collection = draft[field];
    const existing = collection?.[id];

    // Bail out if every incoming property already matches — avoids creating
    // a new state reference, which would cascade through every subscriber that
    // reads this row.
    if (existing && protectedRecord) {
      const keys = Object.keys(protectedRecord);
      if (keys.length > 0 && keys.every(k => Object.is(existing[k], protectedRecord[k]))) {
        return;
      }
    }

    // Mutate draft in-place instead of replacing the collection object.
    // This ensures mutative only marks the changed subtree as dirty.
    if (!collection) {
      draft[field] = { [id]: protectedRecord };
    } else if (!existing) {
      collection[id] = protectedRecord;
    } else {
      for (const key of Object.keys(protectedRecord)) {
        if (!Object.is(existing[key], protectedRecord[key])) {
          existing[key] = protectedRecord[key];
        }
      }
    }
  }

  function syncOverlay(
    draft: any,
    field: string,
    overlayById: Record<string, Record<string, any>>,
  ): void {
    const collection = draft[field];
    if (!collection) return;
    for (const id in overlayById) {
      const row = collection[id];
      if (!row) continue;
      const fields = overlayById[id];
      for (const key in fields) {
        if (!Object.is(row[key], fields[key])) row[key] = fields[key];
      }
    }
  }

  return { syncTable, syncRecord, syncOverlay };
}
