// The model-written change guide for a pull request (prGuides.forPr), stored
// under the pull request's Convex id so the Guide tab paints from cache. The
// feeder returns readiness only; the tab reads the store (usePrGuide).
import { useCallback, useMemo } from "react";
import { useAction } from "convex/react";
import { toast } from "sonner";
import type { ChangeGuideStep } from "@codecast/shared/contracts/changeGuide";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useSyncCollection } from "./useSyncCollection";

const api = _api as any;

/**
 * One row per pull request: the latest attempt's state (`status`, `error`,
 * `created_at`, `attempt_id`) beside the newest finished guide (`steps` and the
 * rest, empty when none was ever written), so a rewrite in flight or a failed
 * one leaves the written guide on screen.
 */
export type PrGuideRow = {
  _id: string;
  attempt_id?: string;
  status: "writing" | "ready" | "failed";
  error?: string;
  created_at: number;
  guide_id?: string;
  head_sha?: string;
  summary?: string;
  steps?: ChangeGuideStep[];
  model?: string;
  cost_usd?: number;
  finished_at?: number;
};

/** A row still writing after this long belongs to a call that died (prGuides PR_GUIDE_WRITING_STALE_MS). */
export const PR_GUIDE_WRITING_STALE_MS = 5 * 60_000;

/** forPr's answer as one row keyed by the pull request. Every field gets a value, because a store write
 *  merges fields: a new guide must overwrite the last one's summary, and a new attempt the last error. */
const selectRow = (r: any): PrGuideRow[] => {
  if (!r?.pr_id || !r.latest) return [];
  const { latest, guide } = r;
  return [{
    _id: String(r.pr_id),
    attempt_id: String(latest._id),
    status: latest.status,
    error: latest.error ?? "",
    created_at: latest.created_at,
    guide_id: guide ? String(guide._id) : "",
    head_sha: guide?.head_sha ?? "",
    summary: guide?.summary ?? "",
    steps: guide?.steps ?? [],
    model: guide?.model ?? latest.model,
    cost_usd: guide?.cost_usd ?? 0,
    finished_at: guide?.finished_at ?? 0,
  }];
};

export function useSyncPrGuide(prId: string | null | undefined) {
  return useSyncCollection("prGuides", api.prGuides.forPr, prId ? { pr_id: prId } : "skip", useMemo(() => ({ select: selectRow }), []));
}

export function usePrGuide(prId: string | null | undefined): PrGuideRow | undefined {
  return useInboxStore((s) => (prId ? ((s as any).prGuides?.[prId] as PrGuideRow | undefined) : undefined));
}

/**
 * Start writing a guide. The tab shows "Writing" at once from a local row; the
 * server's own writing row, then the finished one, replace it through the feed.
 * A refusal (cap, no files) puts back what was there and says why.
 */
export function useWritePrGuide(prId: string | null | undefined) {
  const write = useAction(api.prGuides.write);
  return useCallback(() => {
    if (!prId) return;
    const store = useInboxStore.getState();
    const before = (store as any).prGuides?.[prId] as PrGuideRow | undefined;
    store.syncRecord("prGuides", prId, { _id: prId, status: "writing", error: "", created_at: Date.now() });
    void write({ pr_id: prId }).catch((error: unknown) => {
      const message = String((error as any)?.data ?? (error instanceof Error ? error.message : error));
      const now = (useInboxStore.getState() as any).prGuides?.[prId] as PrGuideRow | undefined;
      // No new attempt on the server: the write was refused before it began, so put back what was there.
      // A write that began and failed arrives as its own failed attempt through the feed.
      if (now?.attempt_id === before?.attempt_id) {
        useInboxStore.getState().syncRecord("prGuides", prId, before
          ? { status: before.status, error: before.error ?? "", created_at: before.created_at }
          : { status: "failed", error: message });
      }
      toast.error(message);
    });
  }, [prId, write]);
}
