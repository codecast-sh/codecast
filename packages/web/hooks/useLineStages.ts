// The line's leading stages for one project (convex lineStages.ts): its moment
// kinds with their extractors, its judges with their prompts and runs,
// withdrawn findings and the grouping rule (`lineStages`), and the trial's
// dispatcher as a dry pass sees it (`lineDispatch`). Feeders hand each answer
// to the store; readers paint from it, so a stage reopened paints at once.
import { useMemo } from "react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";
import { useTrackedStore } from "../store/inboxStore";

export type LineStagesRow = NonNullable<FunctionReturnType<typeof api.lineStages.flow>>;
export type LineKindRow = LineStagesRow["kinds"][number];
export type LineJudgeRow = LineStagesRow["judges"][number];
export type LineMomentRow = LineKindRow["recent"][number];
export type LineDispatchRow = NonNullable<FunctionReturnType<typeof api.lineStages.dispatch>>;
export type LineDueRow = LineDispatchRow["pass"]["due"][number];

/** Each query answers one project's row; the collection takes a list. */
const ONE = { select: (row: { _id: string } | null) => (row ? [row] : []) };

/** Feeder: one project's leading stages. Mounted with the Map and its stage drawers. */
export function useSyncLineStages(projectId: string | null) {
  const args = useMemo(() => (projectId ? { project: projectId } : "skip" as const), [projectId]);
  return useSyncCollection("lineStages", api.lineStages.flow, args, ONE as never);
}

/** Feeder: one trial's dispatcher. Mounted only while its drawer is open: the pass reads every problem of the project. */
export function useSyncLineDispatch(projectId: string | null) {
  const args = useMemo(() => (projectId ? { project: projectId } : "skip" as const), [projectId]);
  return useSyncCollection("lineDispatch", api.lineStages.dispatch, args, ONE as never);
}

/** A judge as the stages read it: `week_capped` when the runs read (the newest RUNS_PER_JUDGE) all fall inside the week,
 *  so its week counts are a floor ("800+"), not the week. */
export type LineJudge = LineJudgeRow & { week_capped: boolean };

/** Reader: one project's leading stages, live judges first (a later publish's removed ones after), or null until they arrive. */
export function useLineStages(projectId: string | null): (Omit<LineStagesRow, "judges"> & { judges: LineJudge[] }) | null {
  const s = useTrackedStore([(st) => (projectId ? (st as any).lineStages?.[projectId]?.at : null)]);
  const row: LineStagesRow | null = projectId ? ((s as any).lineStages?.[projectId] ?? null) : null;
  return useMemo(() => (row ? {
    ...row,
    judges: row.judges
      .map((j) => ({ ...j, week_capped: j.capped && j.week.runs === j.all.runs }))
      .sort((a, b) => Number(!!a.removed_at) - Number(!!b.removed_at)),
  } : null), [row]);
}

/** Reader: one trial's dispatcher, or null until it arrives. */
export function useLineDispatch(projectId: string | null): LineDispatchRow | null {
  const s = useTrackedStore([(st) => (projectId ? (st as any).lineDispatch?.[projectId]?.at : null)]);
  return projectId ? ((s as any).lineDispatch?.[projectId] ?? null) : null;
}

export type LineReviewsRow = NonNullable<FunctionReturnType<typeof api.lineStages.reviews>>;
export type LineReview = LineReviewsRow["recent"][number];

/** Feeder: an agent judge's reviews. Mounted only while the judge's page is open: it reads every review of the judge. */
export function useSyncLineReviews(projectId: string | null, judge: string | null) {
  const args = useMemo(() => (projectId && judge ? { project: projectId, judge } : "skip" as const), [projectId, judge]);
  return useSyncCollection("lineReviews", api.lineStages.reviews, args, ONE as never);
}

/** Reader: an agent judge's reviews, or null until they arrive. */
export function useLineReviews(projectId: string | null, judge: string | null): LineReviewsRow | null {
  const key = projectId && judge ? `${projectId}|${judge}` : null;
  const s = useTrackedStore([(st) => (key ? (st as any).lineReviews?.[key] : null)]);
  return key ? ((s as any).lineReviews?.[key] ?? null) : null;
}
