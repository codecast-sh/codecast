"use client";
// The pipelines in the flows app (docs/architecture/pipeline.md PL6). /flows
// lands on the team's pipelines, each repo a compact live strip that opens
// its page; /flows/pipeline?repo=<owner/repo> is one pipeline whole, with
// what is live per target, what waits on main and what is in flight, and a
// panel on each station.
import { memo } from "react";
import Link from "next/link";
import { ShareControl } from "../../ShareControl";
import { usePipelineModels } from "../../../hooks/usePipelines";
import { pipelineHref, type PipelineModel } from "../../../lib/line/pipelineModel";
import { PipelineDiagram } from "./PipelineDiagram";

const teamOf = (workspace: string | null) => (workspace?.startsWith("team:") ? workspace.slice(5) : null);

/** A pipeline's state in figures: changes in flight, commits waiting on main, deploys going out. */
function Figures({ model }: { model: PipelineModel }) {
  const going = model.main.targets.filter((t) => t.going && !t.going.stuck).length;
  const stuck = model.main.targets.filter((t) => t.going?.stuck).length;
  const failed = model.main.targets.filter((t) => t.tone === "failed").length;
  return (
    <span className="rpl-figs">
      <span className="rpl-fig" data-on={model.change.inFlight ? "" : undefined}><b className="lw-num">{model.change.inFlight}</b> in flight</span>
      <span className="rpl-fig" data-on={model.main.waiting ? "" : undefined}><b className="lw-num">{model.main.waiting}</b> waiting on main</span>
      <span className="rpl-fig" data-on={going ? "" : undefined}><b className="lw-num">{going}</b> going out</span>
      {stuck ? <span className="rpl-fig" data-tone="bad"><b className="lw-num">{stuck}</b> stuck</span> : null}
      {failed ? <span className="rpl-fig" data-tone="bad"><b className="lw-num">{failed}</b> failed</span> : null}
    </span>
  );
}

/** /flows: every pipeline of the team, each a strip that opens its page. */
export const PipelinesStage = memo(function PipelinesStage({ workspace }: { workspace: string | null }) {
  const { models, pipelines, ready, failed } = usePipelineModels(workspace);
  if (!ready && !models.length) return <div className="lw-skeleton" aria-busy><i style={{ width: "70%" }} /><i style={{ width: "54%" }} /></div>;
  if (!models.length) return <div className="rpl-empty"><b>{failed ? `Pipelines ${failed}` : workspace?.startsWith("team:") ? "No pipelines published" : "Pipelines belong to a team"}</b></div>;
  return (
    <div className="rpl-list" data-pipelines>
      {models.map((m, i) => (
        <article key={m.repository} className="rpl-card" data-pipeline-repo={m.repository}>
          <header className="rpl-card-head">
            <Link href={pipelineHref(m.repository)} className="rpl-card-name">{m.name}</Link>
            <span className="rpl-card-repo">{m.repository}</span>
            <Figures model={m} />
          </header>
          <Link href={pipelineHref(m.repository)} className="rpl-card-body" aria-label={`Open ${m.name}'s pipeline`}>
            <PipelineDiagram model={m} pipeline={pipelines[i]} teamId={teamOf(workspace)} compact />
          </Link>
        </article>
      ))}
    </div>
  );
});

/** /flows/pipeline?repo=: one pipeline, whole. */
export const RepoPipelineStage = memo(function RepoPipelineStage({ workspace, repository }: { workspace: string | null; repository: string }) {
  const { models, pipelines, ready, failed } = usePipelineModels(workspace);
  const i = models.findIndex((m) => m.repository === repository.toLowerCase());
  const model = models[i] ?? null;
  if (!model) {
    if (!ready) return <div className="lw-skeleton" aria-busy><i style={{ width: "70%" }} /></div>;
    return <div className="rpl-empty"><b>{failed ? `Pipelines ${failed}` : `No pipeline for ${repository}`}</b><Link href="/flows" className="lw-chip">Every pipeline</Link></div>;
  }
  return (
    <div className="rpl-page" data-pipeline-page={model.repository}>
      <header className="rpl-page-head">
        <Link href="/flows" className="rpl-up">Pipelines</Link>
        <span aria-hidden className="rpl-sep">/</span>
        <h2 className="rpl-page-name">{model.name}</h2>
        <Figures model={model} />
        <ShareControl label="pipeline" path={pipelineHref(model.repository)} className="ml-auto" />
      </header>
      <PipelineDiagram model={model} pipeline={pipelines[i]} teamId={teamOf(workspace)} />
    </div>
  );
});
