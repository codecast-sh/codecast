// The viewer's per-session notify settings (sessionWatch.listMine) → the
// `sessionNotify` collection. Part of the useSyncCore mount set. Enrichment
// only: a client ahead of the convex deploy gets no rows and every session
// reads as "default".
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";

const api = _api as any;

const NO_ARGS = {};

export function useSyncSessionNotify() {
  return useSyncCollection("sessionNotify", api.sessionWatch.listMine, NO_ARGS);
}
