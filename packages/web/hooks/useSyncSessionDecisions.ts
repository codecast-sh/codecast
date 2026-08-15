import { useCallback } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";
import { useQueryNoThrow } from "./useQueryNoThrow";

const api = _api as any;

// The decision queue (cast decide): pending questions + a short window of
// resolved ones. Personal scope. useQueryNoThrow because the queue only
// enriches the inbox — the app must keep rendering if the function is
// missing (deploy gap) or errors.
export function useSyncSessionDecisions() {
  const { data: result } = useQueryNoThrow(api.sessionDecisions.listForUser, {});
  const syncTable = useInboxStore((s) => s.syncTable);

  useConvexSync(result, useCallback((data: any) => {
    if (!data) return;
    syncTable("sessionDecisions", data);
  }, [syncTable]));
}
