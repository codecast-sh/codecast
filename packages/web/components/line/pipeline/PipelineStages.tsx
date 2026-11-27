"use client";
// The pipelines in the flows app (docs/architecture/pipeline.md PL6). /flows
// lands on the team's pipelines, each repo a compact live strip that opens
// its page; /flows/pipeline?repo=<owner/repo> is one pipeline whole, with
// what is live per target, what waits on main and what is in flight, and a
// panel on each station.
import { memo } from "react";
import Link from "next/link";
import { usePipelineModels } from "../../../hooks/usePipelines";
import { usePipeline, useSyncPipelines } from "../../../hooks/useSyncPipelines";
import { useCheckouts, useSyncCheckouts } from "../../../hooks/useSyncCheckouts";
import { teamWorkspaceKey } from "../../../lib/workspaceScope";
import { useInboxStore } from "../../../store/inboxStore";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { pipelineHref, type PipelineModel } from "../../../lib/line/pipelineModel";
import { PipelineDiagram } from "./PipelineDiagram";

const teamOf = (workspace: string | null) => (workspace?.startsWith("team:") ? workspace.slice(5) : null);

/** A pipeline's state in figures: changes in flight, commits waiting on main, deploys going out. */
function Figures({ model, stuckCheckouts }: { model: PipelineModel; stuckCheckouts: number }) {
  const going = model.main.targets.filter((t) => t.going && !t.going.stuck).length;
  const stuck = model.main.targets.filter((t) => t.going?.stuck).length;
  const failed = model.main.targets.filter((t) => t.tone === "failed").length;
  return (
    <span className="rpl-figs">
      <span className="rpl-fig" data-on={model.change.inFlight ? "" : undefined}><b className="lw-num">{model.change.inFlight}</b> in flight</span>
      <span className="rpl-fig" data-on={model.main.waiting ? "" : undefined}><b className="lw-num">{model.main.reading && !model.main.waiting ? "…" : model.main.waiting}</b> waiting on main</span>
      <span className="rpl-fig" data-on={going ? "" : undefined}><b className="lw-num">{going}</b> going out</span>
      {stuck ? <span className="rpl-fig" data-tone="bad"><b className="lw-num">{stuck}</b> {stuck === 1 ? "deploy" : "deploys"} stuck</span> : null}
      {failed ? <span className="rpl-fig" data-tone="bad"><b className="lw-num">{failed}</b> failed</span> : null}
      {stuckCheckouts ? <span className="rpl-fig" data-tone="bad"><b className="lw-num">{stuckCheckouts}</b> {stuckCheckouts === 1 ? "checkout" : "checkouts"} stuck</span> : null}
    </span>
  );
}

/** /flows: every pipeline of the team, each a strip that opens its page. */
export const PipelinesStage = memo(function PipelinesStage({ workspace }: { workspace: string | null }) {
  const { models, pipelines, ready, failed } = usePipelineModels(workspace);
  // Each card counts its repo's stuck checkouts: the team's checkouts feed once here.
  useSyncCheckouts(teamWorkspaceKey(teamOf(workspace)));
  const checkouts = useCheckouts(teamWorkspaceKey(teamOf(workspace)));
  const stuckIn = (repo: string) => checkouts.filter((c) => c.repository === repo.toLowerCase() && c.level.state === "stuck").length;
  if (!ready && !models.length) return <div className="lw-skeleton" aria-busy><i style={{ width: "70%" }} /><i style={{ width: "54%" }} /></div>;
  if (!models.length) return <div className="rpl-empty"><b>{failed ? `Pipelines ${failed}` : workspace?.startsWith("team:") ? "No pipelines published" : "Pipelines belong to a team"}</b></div>;
  return (
    <div className="rpl-list" data-pipelines>
      {models.map((m, i) => (
        <article key={m.repository} className="rpl-card" data-pipeline-repo={m.repository}>
          <header className="rpl-card-head">
            <Link href={pipelineHref(m.repository)} className="rpl-card-name">{m.name}</Link>
            <span className="rpl-card-repo">{m.repository}</span>
            <Figures model={m} stuckCheckouts={stuckIn(m.repository)} />
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
/** `pickSpace`: read another workspace (the flows app's switcher), for an address whose repository lives there. */
export const RepoPipelineStage = memo(function RepoPipelineStage({ workspace, repository, pickSpace }: { workspace: string | null; repository: string; pickSpace?: (key: string) => void }) {
  const { models, pipelines, ready, failed } = usePipelineModels(workspace);
  const i = models.findIndex((m) => m.repository === repository.toLowerCase());
  const model = models[i] ?? null;
  if (!model) {
    // The address names the repository: when another of the viewer's teams holds its pipeline, the page reads that one.
    const finder = pickSpace ? <PipelineFinder repository={repository} except={teamOf(workspace)} onFound={(team) => pickSpace(`team:${team}`)} /> : null;
    if (!ready) return <>{finder}<div className="lw-skeleton" aria-busy><i style={{ width: "70%" }} /></div></>;
    return <>{finder}<div className="rpl-empty"><b>{failed ? `Pipelines ${failed}` : `No pipeline for ${repository} in any of your teams`}</b><Link href="/flows" className="lw-chip">Every pipeline</Link></div></>;
  }
  // The overview carries the page's header (name, Edit pipeline, Share), its lanes, its drawer and its checkouts.
  return (
    <div className="rpl-page" data-pipeline-page={model.repository}>
      <PipelineDiagram model={model} pipeline={pipelines[i]} teamId={teamOf(workspace)} />
    </div>
  );
});

/** Looks for a repository's pipeline in each of the viewer's other teams, and names the first team that has it. */
function PipelineFinder({ repository, except, onFound }: { repository: string; except: string | null; onFound: (team: string) => void }) {
  const teams = useInboxStore((s) => (Array.isArray(s.teams) ? s.teams : Object.values((s.teams ?? {}) as Record<string, { _id?: string }>)).map((t: { _id?: string }) => t._id).filter((id): id is string => !!id && id !== except).join(","));
  return <>{teams ? teams.split(",").map((t) => <TeamPipelineProbe key={t} team={t} repository={repository} onFound={onFound} />) : null}</>;
}

function TeamPipelineProbe({ team, repository, onFound }: { team: string; repository: string; onFound: (team: string) => void }) {
  useSyncPipelines(team);
  const found = !!usePipeline(team, repository);
  useWatchEffect(() => { if (found) onFound(team); }, [found, team, onFound]);
  return null;
}
