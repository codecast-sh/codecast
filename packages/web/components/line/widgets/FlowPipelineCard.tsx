"use client";
// A repository's pipeline in a conversation (docs/architecture/pipeline.md PL6):
// ```flow {"pipeline":"owner/repo"} draws the pipelines landing's compact live
// strip (PipelineStrip), the whole of it opening the pipeline's page.
import { memo } from "react";
import Link from "next/link";
import { PipelineStrip } from "../pipeline/PipelineDiagram";
import { usePipelineModels, usePipelineWorkspace } from "../../../hooks/usePipelines";
import { useActiveWorkspaceKey } from "../../../hooks/useWorkspaceCollection";
import { pipelineHref, repoName } from "../../../lib/line/pipelineModel";
import "../workspace/workspace.css";
import "../pipeline/pipeline.css";
import "./flowEdit.css";

export const FlowPipelineCard = memo(function FlowPipelineCard({ repository, title = null }: { repository: string; title?: string | null }) {
  // The team that publishes it, which need not be the one the viewer has open.
  const { workspace: found, feeders } = usePipelineWorkspace(repository);
  const active = useActiveWorkspaceKey();
  const { models, ready, failed } = usePipelineModels(found ?? active);
  const model = models.find((m) => m.repository === repository.toLowerCase()) ?? null;
  if (!model && !ready) return <div className="lw-widget lw-flow lw-flow-cold" aria-busy data-flow-pipeline={repository}>{feeders}</div>;
  return (
    <div className="lw-widget lw-flow fe" data-flow-pipeline={repository}>
      {feeders}
      <div className="lw-flow-head">
        <span className="lw-flow-kind" data-kind="line">Pipeline</span>
        <Link className="lw-flow-name" href={pipelineHref(repository)}>{title ?? model?.name ?? repoName(repository)}</Link>
        <span className="fe-repo-quiet">{repository}</span>
      </div>
      {model ? (
        <Link href={pipelineHref(repository)} className="fe-strip" aria-label={`Open ${model.name}'s pipeline`}>
          <PipelineStrip model={model} />
        </Link>
      ) : (
        <div className="lw-fence-fallback" data-flow-pipeline-missing={repository}>{failed ? `Pipelines ${failed}` : <>No pipeline published for <b>{repository}</b></>}</div>
      )}
    </div>
  );
});
