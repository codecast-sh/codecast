// The feeders of a session's owners under the session_owners model, mounted
// with the conversation's header (store/sessionOwnersSlice):
//  - the owners read (sessionOwnership.listOwners) fills `sessionOwners`,
//    which also releases a change painted on it.
// A read off the model (the flag off, or turned off) drops the session's
// cached owners read, so it draws exactly what it drew before the model.
import { useCallback } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { HIDDEN_OVERRIDE_SETTLE_MS, useInboxStore } from "../store/inboxStore";
import { noteEvictedRows } from "../store/idbCollectionDiff";
import { type OwnerPersonInfo, type SessionOwnersRow } from "../store/sessionOwnersSlice";
import { shouldQueryOwners } from "./useOwners";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useConvexSync } from "./useConvexSync";
import { useServerAuthSettled } from "./useServerAuthSettled";

/** The `sessionOwners` row an owners read means, or null off the model. */
export function sessionOwnersRowOf(conversationId: string, read: any): SessionOwnersRow | null {
  if (!read?.session_owners) return null;
  return {
    _id: conversationId,
    people_ids: (read.people ?? []).map((p: { user_id: string }) => String(p.user_id)),
    people_info: Object.fromEntries((read.people ?? []).map((p: OwnerPersonInfo) => [String(p.user_id), p])),
    role: read.role ?? null,
    parent_session: read.parent_session ?? null,
    implicit_starter: read.implicit_starter ?? null,
    starter_id: read.starter_id ?? read.implicit_starter?.user_id ?? null,
    role_started: !!read.role_started,
    can_edit: !!read.can_edit,
    owners_changed_at: read.owners_changed_at ?? null,
  };
}

export function applySessionOwnersRead(conversationId: string, read: any): void {
  applySessionOwnersReads({ [conversationId]: read });
}

/** Several reads at once (listOwnersFor): one sync of the collection, of the
 *  rows that changed. A read off the model drops a cached read. */
export function applySessionOwnersReads(reads: Record<string, any>): void {
  const store = useInboxStore.getState();
  const rows: SessionOwnersRow[] = [];
  const off: string[] = [];
  for (const [id, read] of Object.entries(reads ?? {})) {
    const row = sessionOwnersRowOf(id, read);
    if (row) rows.push(row);
    else if (read && (store as any).sessionOwners?.[id]) off.push(id);
  }
  // A lock the change's acknowledgement never settled (its window closed)
  // gives way past the triage bound, as a heal releases one.
  const now = Date.now();
  const ids = new Set(rows.map((row) => row._id));
  const settled = Object.entries(store.pending ?? {}).some(([key, entry]: [string, any]) =>
    entry?.type === "field" && ids.has(key.split(":")[1]) && entry.ts != null && now - entry.ts >= HIDDEN_OVERRIDE_SETTLE_MS);
  if (settled) store.releaseSettledFieldLocks([...ids]);
  if (off.length) {
    // Off disk too, where this window is the one that writes it (the sync host).
    if (store.syncRole === "host") noteEvictedRows("sessionOwners", off);
    store.dropRows("sessionOwners", off);
  }
  // A push repeats every visible session's read; write only what it changes.
  const locked = new Set(Object.keys(store.pending ?? {}).filter((k) => k.startsWith("sessionOwners:")).map((k) => k.split(":")[1]));
  const cached = (store as any).sessionOwners ?? {};
  const changed = rows.filter((row) => locked.has(row._id) || !cached[row._id] || JSON.stringify(cached[row._id]) !== JSON.stringify(row));
  if (changed.length) store.syncTable("sessionOwners", changed);
}

export function useSyncSessionOwners(conversationId: string): void {
  const currentUser = useInboxStore((s) => s.currentUser);
  const authSettled = useServerAuthSettled();
  const { data } = useQueryNoThrow(
    api.sessionOwnership.listOwners,
    authSettled && shouldQueryOwners(conversationId, currentUser) ? { session_id: conversationId } : "skip",
  );
  useConvexSync(data, useCallback((read: any) => applySessionOwnersRead(conversationId, read), [conversationId]));
}
