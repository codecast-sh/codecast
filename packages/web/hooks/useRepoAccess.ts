import { useAuthToken } from "@convex-dev/auth/react";
import { useConvexAuth } from "convex/react";
import { useCallback } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { repoBrowseKey, repoViewerScope } from "../lib/repoBrowseCache";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useConvexSync } from "./useConvexSync";
import { useCoarseNow } from "./useCoarseNow";

export function useRepoViewerScope() {
  const token = useAuthToken();
  const viewerId = useInboxStore((s) => s.currentUser?._id);
  return repoViewerScope(token, viewerId);
}

export function useRepoAccess(repository: string | undefined, enabled = true) {
  const scope = useRepoViewerScope();
  const { isAuthenticated } = useConvexAuth();
  const key = repoBrowseKey(scope, "access", repository ? { repository } : null);
  const { data, error } = useQueryNoThrow(api.repos.canBrowse,
    enabled && key && isAuthenticated ? { repository: repository! } : "skip");
  const now = useCoarseNow(30_000);
  useConvexSync(data, useCallback((allowed: boolean) => {
    if (!key || !scope || !repository) return;
    const store = useInboxStore.getState();
    store.syncTable("repoBrowseAccess", [{ _id: key, scope, repository, allowed, checked_at: Date.now() }]);
    if (!allowed) store.syncTable("repoBrowse", Object.values(store.repoBrowse)
      .filter((row: any) => row.scope === scope && row.repository !== repository), { isDelta: false });
  }, [key, scope, repository]));
  const cached = useInboxStore((s) => key ? s.repoBrowseAccess[key] : undefined);
  const allowed = !enabled || !scope || data === false || error ? false
    : cached?.scope === scope && (data === true || now - cached.checked_at < 60_000) ? cached.allowed : null;
  return { scope, allowed: allowed as boolean | null, error };
}
