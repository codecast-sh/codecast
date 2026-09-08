// The viewer's per-session read marks (sessionReads.listMine) → the
// `sessionReads` collection. Part of the useSyncCore mount set, so web and
// mobile light the same cards from the same rows.
//
// useSyncCollection means useQueryNoThrow: the backend and the client ship on
// different clocks, so a client that is ahead of the convex deploy gets no
// rows and every card falls back to this device's local "last opened" record
// (isSessionUnread's localViewedAt) instead of throwing into an ErrorBoundary.
// Unread ENRICHES the inbox; it is never what the inbox is for.
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";

const api = _api as any;

const NO_ARGS = {};

export function useSyncSessionReads() {
  return useSyncCollection("sessionReads", api.sessionReads.listMine, NO_ARGS);
}
