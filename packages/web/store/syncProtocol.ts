// Codecast's binding of the @platform/engine sync protocol. The pending
// machinery (exclude / include / field locks, identity reuse, delta semantics,
// scoped pruning) lives in the engine; this module injects the one codecast
// specific: which fields treat a server-omitted value and a local null as the
// same acknowledgement. The exported surface is unchanged.
import {
  applySyncTable as engineApplySyncTable,
  applySyncRecord as engineApplySyncRecord,
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
// retire and would keep re-asserting the clear.
const OPTIONAL_INBOX_TIMESTAMPS: ReadonlySet<string> = new Set([
  "inbox_dismissed_at",
  "inbox_stashed_at",
  "inbox_stash_hidden",
  "inbox_pinned_at",
  "inbox_killed_at",
]);

export function applySyncTable<T extends { _id: string }>(
  tableName: string,
  incoming: T[],
  pending: Record<string, PendingEntry>,
  prev?: Record<string, T>,
  opts?: {
    isDelta?: boolean;
    ignoreFields?: readonly string[];
    // Readonly on purpose: the sessions preserve list derives from the shared
    // INBOX_FACT_FIELDS `as const` tuple. The engine only iterates the list,
    // so the cast below is sound.
    preserveFields?: readonly string[];
    pruneAbsentScope?: (record: T) => boolean;
  },
): { table: Record<string, T>; pending: Record<string, PendingEntry> } {
  return engineApplySyncTable(tableName, incoming, pending, prev, {
    ...opts,
    ignoreFields: opts?.ignoreFields as string[] | undefined,
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
  return engineApplySyncRecord(tableName, id, incoming, pending, OPTIONAL_INBOX_TIMESTAMPS);
}
