import { useCallback, useMemo } from "react";
import { useConvex } from "convex/react";
import { applyCollectionFeed, useSyncCollection } from "./useSyncCollection";
import { useWorkspaceCollection } from "./useWorkspaceCollection";
import { useWatchEffect } from "./useWatchEffect";
import { lookup } from "../lib/liveEntities";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useBootstrapCollection } from "./useBootstrapCollection";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useWorkspaceArgs, type WorkspaceArgs } from "./useWorkspaceArgs";
import { useConvexSync } from "./useConvexSync";

const api = _api as any;

export function useSyncPlansWithArgs(wsArgs: WorkspaceArgs, statusFilter?: string, includeAll?: boolean) {
  // Bootstrap floor, one-shot per workspace (sync-log-cargo E8); steady-state
  // freshness rides the sync log's cargo. See useBootstrapCollection.
  const { ready } = useBootstrapCollection(
    "plans",
    api.plans.webList,
    wsArgs === "skip" ? "skip" : {
      status: statusFilter || undefined,
      // include_all lifts webList's default done/abandoned filter — for
      // surfaces that read the whole workspace (orchestration).
      include_all: includeAll || undefined,
      ...wsArgs,
    },
    { liveLoadingScope: "plans" },
  );
  return { ready };
}

export function useSyncPlans(statusFilter?: string) {
  return useSyncPlansWithArgs(useWorkspaceArgs(), statusFilter);
}

/** Seed the store's plans row from a plans.webGet payload, the page joins
 *  stripped (tasks, sessions, doc_content, comments and author are computed
 *  for the page, not row fields) so the persisted row keeps the list's shape.
 *  The plan page mounts no list feeder and updatePlan writes the draft only
 *  when the row exists: without this seed, a deep link's first charter edit
 *  would paint only after the round trip. syncRecord runs the pending filter,
 *  so an edit in flight is kept over the snapshot. Keyed by the row's own
 *  _id, never the URL param (a short id would store a second copy). */
export function ingestPlanDetail(d: any): void {
  if (!d || typeof d._id !== "string") return;
  const { tasks, sessions, doc_content, comments, author, ...row } = d;
  useInboxStore.getState().syncRecord("plans", String(row._id), row);
}

/**
 * Cross-team mention index for plans — see useSyncMentionTasks for context.
 */
export function useSyncMentionPlans() {
  const syncMentionIndex = useInboxStore((s) => s.syncMentionIndex);
  const result = useQueryNoThrow(api.plans.webMentionList, { workspace: "all" } as any).data;

  useConvexSync(result, useCallback((data: any) => {
    syncMentionIndex("plans", data?.items ?? []);
  }, [syncMentionIndex]));
}

// A plan's page joins, apart from its row (one home per fact): webGet's
// answer splits into the `plans` row (ingestPlanDetail's shape) and its
// `planDetails` row. plan_updated_at says which version of the plan the joins
// were read at, so the read-ahead knows a stale one.
const planJoins = (d: any) => {
  if (!d || typeof d._id !== "string") return [];
  const { tasks, sessions, doc_content, comments, author } = d;
  return [{ _id: String(d._id), tasks, sessions, doc_content, comments, author, plan_updated_at: d.updated_at ?? 0 }];
};
const planRow = (d: any) => {
  if (!d || typeof d._id !== "string") return [];
  const { tasks, sessions, doc_content, comments, author, ...row } = d;
  return [row];
};
const PLAN_DETAIL = { select: planJoins };
const PLAN_ROW = { select: planRow };

/** One plan as its page reads it, from the store: the row with its joins laid
 *  on. undefined until both are held, null when the server refuses the
 *  viewer (an access verdict outranks the cache). Feeds both while mounted. */
export function usePlanDetail(ref: string | undefined): any | null | undefined {
  const args = ref ? (ref.startsWith("pl-") ? { short_id: ref } : { id: ref }) : "skip";
  const { refused } = useSyncCollection("planDetails", api.plans.webGet, args, PLAN_DETAIL);
  useSyncCollection("plans", api.plans.webGet, args, PLAN_ROW);
  const row = useInboxStore((s) => (ref ? (lookup(s.plans, ref) as any) : undefined));
  const detail = useInboxStore((s) => (row?._id ? (s as any).planDetails?.[String(row._id)] : undefined));
  return useMemo(() => (refused ? null : row && detail ? { ...row, ...detail } : undefined), [refused, row, detail]);
}

/** Active plans whose page joins the sync host reads ahead. */
const PREFETCHED_PLAN_DETAILS = 40;
const planDetailRead = new Map<string, number>();
const isOpenPlan = (p: any) => p?._id && p.status !== "done" && p.status !== "abandoned";

/** Feeder, sync host: the joins of the workspace's most recently updated
 *  open plans, read once per plan update, so a plan opened from the inbox,
 *  a hover card or the palette shows its charter and comments at once. */
export function useSyncPlanDetailsAhead(): void {
  const convex = useConvex();
  const plans = useWorkspaceCollection<any>("plans", (p) => `${p.status}|${p.updated_at ?? 0}`);
  const wanted = useMemo(
    () => plans.filter(isOpenPlan).sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0)).slice(0, PREFETCHED_PLAN_DETAILS),
    [plans],
  );
  useWatchEffect(() => {
    const held = ((useInboxStore.getState() as any).planDetails ?? {}) as Record<string, any>;
    const need = wanted.filter((p) => {
      const id = String(p._id);
      const at = p.updated_at ?? 0;
      return planDetailRead.get(id) !== at && (held[id]?.plan_updated_at ?? -1) < at;
    });
    if (!need.length) return;
    let cancelled = false;
    void (async () => {
      for (const p of need) {
        if (cancelled) return;
        const id = String(p._id);
        planDetailRead.set(id, p.updated_at ?? 0);
        try {
          const d = await convex.query(api.plans.webGet, { id });
          if (cancelled || !d) continue;
          applyCollectionFeed("planDetails", d, planJoins);
        } catch {
          planDetailRead.delete(id);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [convex, wanted]);
}
