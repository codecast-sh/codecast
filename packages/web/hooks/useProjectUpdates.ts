// The project page's Updates tab: projectUpdates.webList feeds the store's
// projectUpdates collection for the project on screen, and the tab reads the
// collection. webList answers with the project's complete set, so a row of
// this project missing from it was deleted (a stub not yet created is kept).
import { useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection, type SyncCollectionResult } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";
import { isConvexId } from "../store/inboxStore";
import type { ProjectUpdateRow } from "../store/projectUpdatesSlice";

const api = _api as any;

const updateSig = (u: ProjectUpdateRow) =>
  `${u.body.length}|${u.body.slice(0, 32)}|${u.title ?? ""}|${u.edited_at ?? 0}|${u.short_id ?? ""}|${u.comments?.length ?? 0}|${u.comments?.at(-1)?._id ?? ""}`;
const newestFirst = (a: ProjectUpdateRow, b: ProjectUpdateRow) => b.created_at - a.created_at;

export function useProjectUpdates(projectId: string): SyncCollectionResult & { updates: ProjectUpdateRow[] } {
  const feed = useMemo(
    () => ({
      select: (data: any) =>
        Array.isArray(data) ? data.map((u: any) => ({ ...u, _id: String(u._id), project_id: String(u.project_id) })) : null,
      syncOpts: { isDelta: true, pruneAbsentScope: (r: any) => r.project_id === projectId && isConvexId(String(r._id)) },
    }),
    [projectId],
  );
  const result = useSyncCollection(
    "projectUpdates",
    api.projectUpdates.webList,
    projectId && isConvexId(projectId) ? { project_id: projectId } : "skip",
    feed,
  );
  const where = useMemo(() => (u: ProjectUpdateRow) => u.project_id === projectId, [projectId]);
  const updates = useCollectionRows<ProjectUpdateRow>("projectUpdates", { where, sig: updateSig, sort: newestFirst });
  return { ...result, updates };
}
