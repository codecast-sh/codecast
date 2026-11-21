// A team's pipelines and what is on them now (docs/architecture/pipeline.md
// PL6): the published pipelines (config, the store's `pipelines`), joined at
// read time with the store's runs and deploy targets into the model the
// pipeline page draws. The page mounts this once; it holds the feeder.
import { useMemo } from "react";
import { useDeployTargets } from "./useSyncDeployTargets";
import { useSyncRuns, useWorkspaceRuns } from "./useSyncRuns";
import { usePipelines, useSyncPipelines } from "./useSyncPipelines";
import { pipelineModel, type PipelineModel, type PipelineRun } from "../lib/line/pipelineModel";
import type { Pipeline } from "../lib/line/pipelineTypes";

const teamOf = (workspace: string | null | undefined) => (workspace?.startsWith("team:") ? workspace.slice(5) : null);

/** Every pipeline of the workspace's team, live: `models[i]` draws `pipelines[i]`. `failed`: why the feed did not answer. */
export function usePipelineModels(workspace: string | null | undefined): { models: PipelineModel[]; pipelines: Pipeline[]; ready: boolean; failed: string | null } {
  const teamId = teamOf(workspace);
  const { ready, error, refused } = useSyncPipelines(teamId);
  const pipelines = usePipelines(teamId);
  useSyncRuns({ limit: 100 }, !!teamId, workspace);
  const runs = useWorkspaceRuns(workspace) as unknown as PipelineRun[];
  const { targets, deploys } = useDeployTargets(teamId);
  const models = useMemo(() => pipelines.map((p) => pipelineModel(p, runs, targets, deploys)), [pipelines, runs, targets, deploys]);
  const failed = refused ? "not allowed in this workspace" : error ? "could not be read" : null;
  return { models, pipelines, ready: ready || !teamId, failed };
}
