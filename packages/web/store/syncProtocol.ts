// Codecast's binding of the @platform/engine sync protocol. The pending
// machinery (exclude / include / field locks, identity reuse, delta semantics,
// scoped pruning) lives in the engine; this module injects the one codecast
// specific: which fields treat a server-omitted value and a local null as the
// same acknowledgement. The exported surface is unchanged.
import {
  applySyncTable as engineApplySyncTable,
  applySyncRecord as engineApplySyncRecord,
  applySyncPatch as engineApplySyncPatch,
  applyShapeLocks as engineApplyShapeLocks,
  type PendingEntry,
} from "@platform/engine";

export type { PendingEntry } from "@platform/engine";

// Convex omits optional conversation inbox stamps when they are clear, while
// optimistic bridge transitions retain the local `null` spelling.  That is
// the same server acknowledgement for these fields only; all other fields
// keep strict null/undefined semantics.  inbox_stash_hidden is the stash's
// mode flag and clears the same way.  inbox_killed_at belongs here
// for the same reason as the rest: the /sessions restore gesture nulls it
// (an un-kill patch clears all three stamps), and the server acknowledges by
// dropping the field — without the equivalence that pending lock would never
// retire and would keep re-asserting the clear. inbox_snoozed_until clears
// the same way (defer, pin, rest and every hide null it; the server unsets
// it). The set is every stamp inboxVisibilityFields (convex inboxProjection.ts)
// spells `?? null`. The undo guard reads the same set (mutativeMiddleware's
// optionalClearFields), so a lock and an undo never disagree about a clear.
// The four pinned thread state fields clear the same way: a human's send
// takes the pin down as undefined, the panel's clear writes null, and the
// server echoes either spelling depending on the feed. Without the
// equivalence a send's lock outlived its echo and masked every pin the agent
// declared afterwards, so a finished session read as Working until a reload.
export const OPTIONAL_INBOX_TIMESTAMPS: ReadonlySet<string> = new Set([
  "inbox_dismissed_at",
  "inbox_stashed_at",
  "inbox_snoozed_until",
  "inbox_stash_hidden",
  // The stash's cause clears with the stamp (shared stashCause).
  "inbox_stash_cause",
  "inbox_pinned_at",
  "inbox_killed_at",
  // A Close's marker: written by the close, cleared by its undo, unset by the server.
  "inbox_closed_at",
  "inbox_adopted_at",
  "thread_state",
  "thread_state_at",
  // An ack's clear (clearAssignedPing): the inbox feeds omit the ping when
  // none waits, so an absent echo is the acknowledgement. Without it the null
  // lock outlived the ack and hid every later "assigned to you" ping.
  "assigned_ping",
  "thread_state_msg_count",
  "thread_state_status",
]);

/**
 * A whole conversation doc from the server, with each inbox stamp it left out
 * spelled as a clear. syncRecord merges field by field, so a stamp cleared on
 * the server (a restore on another device) would otherwise keep its old value
 * in the meta while the inbox row shows it clear.
 */
export function withClearedInboxStamps<T extends Record<string, unknown>>(doc: T): T {
  const missing = [...OPTIONAL_INBOX_TIMESTAMPS].filter((f) => !(f in doc));
  return missing.length ? { ...doc, ...Object.fromEntries(missing.map((f) => [f, null])) } : doc;
}

// An owners lock its change's acknowledgement marked (store settleOwnersAck)
// retires on the first server value for its field after the ack: the value
// lands. A row that does not carry the field leaves the lock to the next,
// except an owners stamp a whole inbox row under the model (owners_model:
// true) leaves out: the server omits a clear one, so the row says it is null.
const OWNERS_ROW_FIELDS: Readonly<Record<string, readonly string[]>> = {
  sessions: ["owned_by_me", "implicit_owner", "org_role_id", "owner_session_id"],
};

// Whether any acked lock may exist: set by each mark (noteAckedLock), cleared
// by a scan that finds none, and unknown at load (locks persist), so a window
// that never acks (the flag off) scans once and then pays nothing.
let ackedHint = true;
let ackedScans = 0;
export function noteAckedLock(): void {
  ackedHint = true;
}
/** Test seam: how many times an apply scanned the pending map for acked locks. */
export function _ackedScanCount(): number {
  return ackedScans;
}
/** The multiplayer sim's per-window seam (sim/windowSlots.ts): each window holds its own hint. */
export function __syncProtocolSimSlots() {
  type Slots = { ackedHint: boolean; ackedScans: number };
  return {
    fresh: (): Slots => ({ ackedHint: true, ackedScans: 0 }),
    get: (): Slots => ({ ackedHint, ackedScans }),
    set: (s: object) => ({ ackedHint, ackedScans } = s as Slots),
  };
}
function hasAcked(pending: Record<string, PendingEntry>, prefix: string): boolean {
  if (!ackedHint) return false;
  ackedScans++;
  let any = false;
  for (const key in pending) {
    if (!(pending[key] as { acked?: boolean }).acked) continue;
    if (key.startsWith(prefix)) return true;
    any = true;
  }
  if (!any) ackedHint = false;
  return false;
}
function releaseAckedFields(pending: Record<string, PendingEntry>, tableName: string, id: string, fields: Iterable<string>): Record<string, PendingEntry> {
  let out = pending;
  for (const field of fields) {
    const key = `${tableName}:${id}:${field}`;
    if (!(pending[key] as { acked?: boolean } | undefined)?.acked) continue;
    if (out === pending) out = { ...pending };
    delete out[key];
  }
  return out;
}
function releaseAckedRows<T extends Record<string, any>>(pending: Record<string, PendingEntry>, tableName: string, rows: T[]): { pending: Record<string, PendingEntry>; rows: T[] } {
  if (!hasAcked(pending, `${tableName}:`)) return { pending, rows };
  let out = pending;
  let outRows = rows;
  const omittable = OWNERS_ROW_FIELDS[tableName] ?? [];
  rows.forEach((row, i) => {
    if (!row || row._id == null) return;
    const id = String(row._id);
    out = releaseAckedFields(out, tableName, id, Object.keys(row));
    // Only an inbox row under the owners model spells its stamps: a feed whose
    // rows carry no owners_model (a team, crawl or killed-shelf row) says
    // nothing of them by leaving them out.
    if (row.owners_model !== true) return;
    const cleared = omittable.filter((f) => !(f in row) && (out[`${tableName}:${id}:${f}`] as { acked?: boolean } | undefined)?.acked);
    if (!cleared.length) return;
    out = releaseAckedFields(out, tableName, id, cleared);
    if (outRows === rows) outRows = [...rows];
    outRows[i] = { ...row, ...Object.fromEntries(cleared.map((f) => [f, null])) };
  });
  return { pending: out, rows: outRows };
}

export function applySyncTable<T extends { _id: string }>(
  tableName: string,
  incoming: T[],
  pending: Record<string, PendingEntry>,
  prev?: Record<string, T>,
  opts?: {
    isDelta?: boolean;
    ignoreFields?: readonly string[];
    deepFields?: readonly string[];
    // Readonly on purpose: the sessions preserve list derives from the shared
    // INBOX_FACT_FIELDS `as const` tuple. The engine only iterates the list,
    // so the cast below is sound.
    preserveFields?: readonly string[];
    pruneAbsentScope?: (record: T) => boolean;
  },
): { table: Record<string, T>; pending: Record<string, PendingEntry> } {
  ({ pending, rows: incoming } = releaseAckedRows(pending, tableName, incoming));
  return engineApplySyncTable(tableName, incoming, pending, prev, {
    ...opts,
    ignoreFields: opts?.ignoreFields as string[] | undefined,
    deepFields: opts?.deepFields as string[] | undefined,
    preserveFields: opts?.preserveFields as string[] | undefined,
    optionalClearFields: OPTIONAL_INBOX_TIMESTAMPS,
  });
}

export function applySyncRecord(
  tableName: string,
  id: string,
  incoming: Record<string, any>,
  pending: Record<string, PendingEntry>,
): { record: Record<string, any>; pending: Record<string, PendingEntry> } {
  if (hasAcked(pending, `${tableName}:${id}:`)) pending = releaseAckedFields(pending, tableName, id, Object.keys(incoming ?? {}));
  return engineApplySyncRecord(tableName, id, incoming, pending, OPTIONAL_INBOX_TIMESTAMPS);
}

/** What an action locked on a local-first list or singleton, held over a
 *  push; same optional-clear rule. */
export function applyShapeLocks(
  tableName: string,
  kind: "list" | "singleton",
  incoming: any,
  pending: Record<string, PendingEntry>,
  local: any,
  keys?: { rowKey?: string; altKey?: string },
): { value: any; pending: Record<string, PendingEntry> } {
  return engineApplyShapeLocks(tableName, kind, incoming, pending, local, { ...keys, optionalClearFields: OPTIONAL_INBOX_TIMESTAMPS });
}

/** Partial-patch pending protection (sync-log cargo); same optional-clear rule. */
export function applySyncPatch(
  tableName: string,
  id: string,
  patch: Record<string, any>,
  unset: readonly string[],
  pending: Record<string, PendingEntry>,
): { fields: Record<string, any>; unset: string[]; pending: Record<string, PendingEntry> } {
  if (hasAcked(pending, `${tableName}:${id}:`)) pending = releaseAckedFields(pending, tableName, id, [...Object.keys(patch), ...unset]);
  return engineApplySyncPatch(tableName, id, patch, unset, pending, OPTIONAL_INBOX_TIMESTAMPS);
}
