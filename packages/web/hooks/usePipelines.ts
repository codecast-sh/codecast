// A team's pipelines and what is on them now (docs/architecture/pipeline.md
// PL6): the published pipelines (config, the store's `pipelines`), joined at
// read time with the store's runs and deploy targets into the model the
// pipeline page draws. The page mounts this once; it holds the feeder.
import { createElement, Fragment, useMemo, type ReactElement } from "react";
import { useDeployTargets } from "./useSyncDeployTargets";
import { useSyncRuns, useWorkspaceRuns } from "./useSyncRuns";
import { usePipelines, useSyncPipelines, type PipelineRow } from "./useSyncPipelines";
import { useWorkspacesCollection } from "./useWorkspaceCollection";
import { activeTeamIdOf } from "../lib/activeTeam";
import { useCoarseNow } from "./useCoarseNow";
import { pendingEdits, pipelineCheckout, pipelineModel, type PipelineModel, type PipelineRun } from "../lib/line/pipelineModel";
import { useInboxStore } from "../store/inboxStore";
import { repositoryKeyOfRemote } from "@codecast/shared/contracts";
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
  // A deploy's "stuck" reads the clock: a coarse minute is enough.
  const now = useCoarseNow(60_000);
  // Edits sessions were started to make, from their first messages (EditComposer): drawn as ghosts until live.
  const proposalSig = useInboxStore(proposalsSig);
  const models = useMemo(() => {
    const rows = JSON.parse(proposalSig) as ProposalRow[];
    const first = new Map(rows.map((r) => [r.id, r.first]));
    return pipelines.map((p) => pipelineModel(p, runs, targets, deploys, now, pendingEdits(p.repository, rows, (id) => first.get(id))));
  }, [pipelines, runs, targets, deploys, now, proposalSig]);
  const failed = refused ? "not allowed in this workspace" : error ? "could not be read" : null;
  return { models, pipelines, ready: ready || !teamId, failed };
}

type ProposalRow = { id: string; title: string | null; project_path: string | null; ended: boolean; first: string };
type State = ReturnType<typeof useInboxStore.getState>;
type MessageRow = { role?: string; content?: string | null };
type SessionRow = { title?: string | null; project_path?: string | null; git_root?: string | null; inbox_killed_at?: number | null };

/** The sessions whose first message opens with a `cast flow edit` command, as a string so a store push that changes
 *  none of them re-renders nothing. */
function proposalsSig(s: State): string {
  const messages = (s as unknown as { messages?: Record<string, MessageRow[]> }).messages ?? {};
  const rows: ProposalRow[] = [];
  for (const id in messages) {
    const first = messages[id]?.find((m) => m.role === "user")?.content;
    if (!first?.startsWith("cast flow edit ")) continue;
    const row = ((s.sessions as Record<string, SessionRow>)[id] ?? (s.conversations as Record<string, SessionRow>)[id]) as SessionRow | undefined;
    rows.push({ id, title: row?.title ?? null, project_path: row?.project_path ?? row?.git_root ?? null, ended: !!row?.inbox_killed_at, first });
  }
  return JSON.stringify(rows);
}

type RosterRow = { device_id: string; display_name?: string | null; label?: string | null; hostname?: string | null };
type CheckoutRow = { git_remote_url?: string | null; git_root?: string | null; project_path?: string | null; updated_at?: number };

/**
 * Where an edit session for this pipeline starts: the checkout that publishes it, when that machine is the viewer's
 * own; else the viewer's own most recent checkout of the repo. Null when the viewer has no checkout of it.
 */
export function useEditWhere(p: Pipeline | null): { root: string; device: string | null; machine: string | null } | null {
  const sig = useInboxStore((s) => {
    if (!p) return "";
    const roster = (s.machineRoster ?? []) as RosterRow[];
    const name = (id: string | null) => { const d = id ? roster.find((x) => x.device_id === id) : null; return d ? d.display_name || d.label || d.hostname || null : null; };
    const { root, device } = pipelineCheckout(p);
    if (root && device && roster.some((d) => d.device_id === device)) return JSON.stringify({ root, device, machine: name(device) });
    let best: CheckoutRow | null = null;
    for (const row of Object.values(s.sessions as Record<string, CheckoutRow>)) {
      if (!row?.git_root || repositoryKeyOfRemote(row.git_remote_url) !== p.repository) continue;
      if (!best || (row.updated_at ?? 0) > (best.updated_at ?? 0)) best = row;
    }
    return best?.git_root ? JSON.stringify({ root: best.git_root, device: null, machine: null }) : "";
  });
  return useMemo(() => (sig ? JSON.parse(sig) : null), [sig]);
}

/** One team's pipelines fed into the store, drawing nothing. */
function TeamPipelinesFeeder({ teamId }: { teamId: string }) {
  useSyncPipelines(teamId);
  return null;
}

/** The viewer's teams, the active one first. */
function useViewerTeamIds(): string[] {
  const sig = useInboxStore((s) => {
    const active = activeTeamIdOf(s as any);
    const ids = ((s as any).teams ?? []).map((t: { _id: string }) => String(t._id)) as string[];
    return [...(active ? [active] : []), ...ids.filter((id) => id !== active)].join(",");
  });
  return useMemo(() => (sig ? sig.split(",") : []), [sig]);
}

const rowSig = (p: PipelineRow) => `${p._id}|${p.repository}|${p.published_at}`;

/**
 * Where a repository's pipeline is published among the viewer's teams (a conversation in one team can name a repo
 * another team ships): its workspace, or null until a team is found to publish it. `feeders` must be rendered: one
 * feed per team, each drawing nothing.
 */
export function usePipelineWorkspace(repository: string): { workspace: string | null; feeders: ReactElement } {
  const teams = useViewerTeamIds();
  const keys = useMemo(() => teams.map((id) => `team:${id}`), [teams]);
  const rows = useWorkspacesCollection<PipelineRow>("pipelines", rowSig, keys);
  const repo = repository.toLowerCase();
  // The active team's copy wins when two teams publish the same repository.
  const found = keys.find((k) => rows.some((r) => r.workspace === k && r.repository === repo)) ?? null;
  const feeders = createElement(Fragment, null, ...teams.map((id) => createElement(TeamPipelinesFeeder, { key: id, teamId: id })));
  return { workspace: found, feeders };
}
