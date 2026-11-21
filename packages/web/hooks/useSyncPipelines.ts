// A team's repository pipelines into the store (pipeline.md PL6): one feed,
// convex pipelines.forTeam, one row per team and repository under its Convex
// id, carrying the change and release flows as contracts/pipeline Pipeline.
// The surface mounts the feeder once; the readers only read the store.
import { useCallback, useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { Pipeline } from "@codecast/shared/contracts/pipeline";
import { useSyncCollection } from "./useSyncCollection";
import { useWorkspaceCollection } from "./useWorkspaceCollection";

const api = _api as any;

/** A pipeline as the store holds it: the server's row, keyed by its Convex id, in its team's workspace. */
export type PipelineRow = Pipeline & { _id: string; workspace: string };

/**
 * Feeder: a team's pipelines. `ready` once the server answered, failed or refused, so a page says what happened
 * instead of loading forever; `error` is why it failed (a backend without pipelines yet, a saturated host).
 */
export function useSyncPipelines(teamId: string | null | undefined): { ready: boolean; error: Error | null; refused: boolean } {
  const workspace = teamId ? `team:${teamId}` : null;
  const r = useSyncCollection("pipelines", api.pipelines.forTeam, teamId ? { team_id: teamId } : "skip", {
    // Each answer is the team's whole set: a repository it no longer publishes leaves this window's store.
    dropAbsent: useCallback((row: PipelineRow) => row?.workspace === workspace, [workspace]),
  });
  return useMemo(() => ({ ready: r.ready || !!r.error || r.refused, error: r.error ?? null, refused: r.refused }), [r.ready, r.error, r.refused]);
}

const pipelineSig = (p: PipelineRow) => `${p._id}|${p.repository}|${p.published_at}|${p.head_sha ?? ""}|${p.device_id ?? ""}`;

/** Reader: a team's pipelines from the store, by repository. */
export function usePipelines(teamId: string | null | undefined): PipelineRow[] {
  const rows = useWorkspaceCollection<PipelineRow>("pipelines", pipelineSig, teamId ? `team:${teamId}` : null);
  return useMemo(() => [...rows].sort((a, b) => a.repository.localeCompare(b.repository)), [rows]);
}

/** Reader: one repository's pipeline in a team (`owner/name`, any case), or null when none is published. */
export function usePipeline(teamId: string | null | undefined, repository: string | null | undefined): PipelineRow | null {
  const pipelines = usePipelines(teamId);
  const key = repository?.toLowerCase() ?? null;
  return useMemo(() => (key ? pipelines.find((p) => p.repository === key) ?? null : null), [pipelines, key]);
}
