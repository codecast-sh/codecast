// A repo's pipeline as one drawing reads it (docs/architecture/pipeline.md
// PL2, PL6, PL7): the change lane (the change flow's diagram), main (what
// waits on each target, by session), and the release lane (the release
// flow's diagram with the deploy going out now). Each station carries a mark:
// who does it, whether it is the project's own or inherited, when it runs,
// and how many changes stand on it now. The pipeline is config; what is on it
// now joins the store's runs and deploys here, at read time. Pure: no store,
// no React, so the phone can draw the same model.
import { foldFlow, segmentTopOf } from "@codecast/shared/contracts/flowPool";
import { LINE_DEPLOY_STEP_LABELS, type LineDeployStep } from "@codecast/shared/contracts/lineDeploy";
import type { QueueGroup } from "@codecast/shared/contracts/deployTargets";
import { flowDiagram, type DiagramStep, type FlowDiagramModel, type SideRoute, type StepMark } from "./flowDiagram";
import type { ShippedFlow } from "./flowPool";
import { sourceWord, targetNow, targetTone, type DeployTargetRow, type TargetTone, type TeamDeployRow } from "../deploys/targets";
import type { Pipeline, PipelineFlow, PipelineStation, PipelineTarget } from "./pipelineTypes";
import { applyEdit, editLive, editsOfMessage, editStation, meaningfulCommand, type PipelineEdit } from "./pipelineEdit";
import { recentFiles } from "@codecast/shared/contracts/pipeline";

/** An edit a session was started to make, not live yet: drawn as a ghost on its lane. */
export type PendingEdit = { flow: string; edit: PipelineEdit; session: { id: string; title: string } };

/** A run as the pipeline reads it: which flow, where it stands, in which checkout. */
export type PipelineRun = {
  _id: string;
  status: string;
  workflow_slug?: string | null;
  workflow_name?: string | null;
  project_path?: string | null;
  current_node_id?: string | null;
  task_title?: string | null;
  task_short_id?: string | null;
  node_statuses?: ReadonlyArray<{ node_id: string; status: string; outcome?: string; session_id?: string; started_at?: number; completed_at?: number }> | null;
  created_at: number;
  updated_at?: number;
};

export type Flight = { working: number; waiting: number; paused: number; elsewhere: number };

export type PipelineLane = {
  flow: PipelineFlow;
  /** Where most steps go when they fail (a release's "Back to the line"): said once on the lane, not under each step. */
  shared: SideRoute | null;
  /** The flow in the diagram's terms (FlowDiagram draws it). */
  drawn: ShippedFlow;
  diagram: FlowDiagramModel;
  marks: Record<string, StepMark>;
  /** Edits proposed and not live yet, drawn in as ghosts. */
  proposals: PendingEdit[];
  /** What each drawn station's count stands for: the changes counted on it, by station id. */
  standing: Record<string, Standing[]>;
  own: number;
  inherited: number;
};

export type MainTarget = {
  name: string;
  policy: PipelineTarget["policy"];
  /** `push`: it builds itself when main moves; `here`: a command sends it. */
  runs: PipelineTarget["runs"];
  /** `stuck`: a deploy has sat open too long without going live (STUCK_*_MS). */
  tone: TargetTone | "stuck";
  /** Commits on main not live there yet, and whose sessions wrote them. */
  waiting: number;
  /** What waits is being read again (deploys/targets readQueue): `waiting` is not a count yet. */
  reading?: true;
  groups: QueueGroup[];
  live: { deploy: string; version: string | null; at: number } | null;
  /** `stuck`: how long it has been open without going live, when that is too long. */
  going: { deploy: string; step: string | null; outside: boolean; stuck: number | null } | null;
  /** The last deploy, when it failed: when it ended, and the step it failed on when it reported steps (a release station's id). */
  failed: { deploy: string; at: number; step: string | null } | null;
};

export type PipelineModel = {
  repository: string;
  /** The repo's own name, as a person says it. */
  name: string;
  /** `inFlight`: this repo's change runs not finished. `flight` splits them so the parts add up to it: working at a
   *  station, waiting for the deploy that carries them (a station that waits), paused, and not at any station. */
  change: PipelineLane & { inFlight: number; flight: Flight; runs: PipelineRun[] };
  /** `reading`: a target's queue is being read again, so `waiting` may be short. */
  main: { targets: MainTarget[]; waiting: number; reading: boolean };
  release: PipelineLane & {
    /** The deploy going out now, as a run of the release flow; null when none is. */
    run: { status: string; current_node_id: string | null; node_statuses: Array<{ node_id: string; status: string }> } | null;
    /** A deploy going out whose steps this flow did not follow, in words ("by GitHub", "outside this flow"). */
    outside: string | null;
    targets: PipelineTarget[];
    /** An open deploy that has sat too long without going live; `outside`: it reported no steps. */
    stuck: { deploy: string; for: number; outside: boolean } | null;
  };
};

const LIVE = new Set(["running", "pending", "paused"]);
/** A run still in flight: running, waiting its turn, or paused. */
export const isLiveRun = (r: Pick<PipelineRun, "status">) => LIVE.has(r.status);

/** The repo's own name: `example-app` of `example-org/example-app`. */
export const repoName = (repository: string) => repository.split("/").pop() ?? repository;

/** Whether a run ran in this repo's checkout (a worktree of it included). */
/** Whether a run or session ran in this repo: its git remote names it, its folder sits under a known checkout of it
 *  (the published pipeline's `root`), or its folder is named after the repo (a checkout or a worktree of one). */
export function runInRepo(run: Pick<PipelineRun, "project_path"> & { repository?: string | null }, repository: string, roots: ReadonlyArray<string | null | undefined> = []): boolean {
  if (run.repository && run.repository.toLowerCase() === repository.toLowerCase()) return true;
  const path = (run.project_path ?? "").replace(/\/+$/, "");
  if (roots.some((r) => !!r && (path === r.replace(/\/+$/, "") || path.startsWith(`${r.replace(/\/+$/, "")}/`)))) return true;
  const name = repoName(repository).toLowerCase();
  return path.toLowerCase().split("/").includes(name);
}

/** A pipeline flow in the drawing's terms. */
export function drawnFlow(f: PipelineFlow): ShippedFlow {
  return { slug: f.slug, name: f.slug, kind: "line", label: f.label, description: null, takes: [], ...foldFlow(f.graph.nodes, f.graph.edges), nodes: f.graph.nodes, edges: f.graph.edges };
}

/** A station's `when` as a chip: its first path, and how many more. */
export function whenWords(when: readonly string[] | undefined): string | null {
  if (!when?.length) return null;
  return when.length > 1 ? `${when[0]} +${when.length - 1}` : when[0];
}

/** A change standing on a station: its name, and the run (or deploy) it is. */
export type Standing = { name: string; id: string };

function markOf(s: PipelineStation, here: readonly Standing[], release: boolean): StepMark {
  return {
    own: s.own === "inherited" ? null : s.own,
    ...(s.changed?.length ? { changed: s.changed } : {}),
    ...(whenWords(s.when) ? { when: whenWords(s.when)! } : {}),
    // A release step with no command passes; say so rather than draw it as work.
    ...(release && s.runs === null ? { passes: true } : {}),
    ...(s.varies ? { varies: true } : {}),
    ...(s.waits ? { waits: true } : {}),
    ...(here.length ? { here: here.length, hereNames: here.map((x) => x.name) } : {}),
  };
}

function lane(published: PipelineFlow, here: Map<string, Standing[]>, release: boolean, pending: readonly PendingEdit[] = []): PipelineLane {
  // Proposals not live yet are drawn in, each marked as the proposal it is.
  const open = pending.filter((x) => x.flow === published.slug && !editLive(published, x.edit));
  const flow = open.reduce((f, x) => applyEdit(f, x.edit), published);
  const drawn = drawnFlow(flow);
  const { diagram, shared } = sharedRoutes(flowDiagram(drawn));
  // A station off the passing path (a fix, a brief) is not drawn: what stands there counts on the step whose route leads to it.
  const drawnIds = new Set(diagram.steps.flatMap((st) => [st.id, ...st.inner.map((x) => x.id)]));
  const on = new Map<string, Standing[]>();
  for (const [id, names] of here) {
    const from = drawnIds.has(id) ? id : diagram.steps.flatMap((st) => [st, ...st.inner]).find((st) => st.side.some((r) => r.toId === id))?.id ?? drawnBefore(flow, id, drawnIds);
    if (from) on.set(from, [...(on.get(from) ?? []), ...names]);
  }
  // A frame drawn folded counts what stands on the steps inside it.
  const counts = new Map(on);
  const insideOf = new Map<string, number>();
  for (const st of diagram.steps) {
    const inside = st.inner.flatMap((x) => on.get(x.id) ?? []);
    if (inside.length && !st.inner.some((x) => x.id === st.id)) { counts.set(st.id, [...(on.get(st.id) ?? []), ...inside]); insideOf.set(st.id, inside.length); }
  }
  // A flow the repo wrote whole is all its own: the lane says so once, and no step is singled out.
  const whole = flow.base === null;
  const marks: Record<string, StepMark> = {};
  for (const s of flow.stations) {
    const m = { ...markOf(s, counts.get(s.id) ?? [], release), ...(insideOf.get(s.id) ? { hereInside: insideOf.get(s.id) } : {}) };
    marks[s.id] = whole ? { ...m, own: null } : m;
  }
  for (const x of open) {
    const id = editStation(x.edit);
    if (!marks[id]) continue;
    marks[id] = { ...marks[id], proposed: `proposed · ${x.session.title}`, ...(x.edit.op === "skip" ? { skipped: true as const } : {}) };
  }
  const own = published.stations.filter((s) => s.own !== "inherited").length;
  return { flow, drawn, diagram, shared, marks, standing: Object.fromEntries(counts), own, inherited: published.stations.length - own, proposals: open };
}

/** The nearest drawn station before one that is not drawn (a fan-out's join, a station off the path behind it), walking
 *  the graph's edges back: what stands there counts on it. */
function drawnBefore(flow: PipelineFlow, id: string, drawn: ReadonlySet<string>): string | undefined {
  const into = new Map<string, string[]>();
  for (const e of flow.graph.edges) {
    const from = segmentTopOf(e.from), to = segmentTopOf(e.to);
    if (from !== to) into.set(to, [...(into.get(to) ?? []), from]);
  }
  const seen = new Set([id]);
  let wave = [id];
  for (let d = 0; d < 6 && wave.length; d++) {
    const next: string[] = [];
    for (const x of wave) for (const p of into.get(x) ?? []) {
      if (drawn.has(p)) return p;
      if (!seen.has(p)) { seen.add(p); next.push(p); }
    }
    wave = next;
  }
  return undefined;
}

/** The fewest steps that must share a route before the lane says it once instead of under each. */
const SHARED_MIN = 3;

/** A route most steps share (each failing step goes back to one station) taken off the steps and said once. */
export function sharedRoutes(model: FlowDiagramModel): { diagram: FlowDiagramModel; shared: SideRoute | null } {
  const all = (steps: DiagramStep[]): DiagramStep[] => steps.flatMap((st) => [st, ...all(st.inner)]);
  const by = new Map<string, { route: SideRoute; n: number }>();
  for (const st of all(model.steps)) for (const toId of new Set(st.side.map((r) => r.toId))) {
    const r = st.side.find((x) => x.toId === toId)!;
    by.set(toId, { route: r, n: (by.get(toId)?.n ?? 0) + 1 });
  }
  const top = [...by.values()].filter((x) => x.n >= SHARED_MIN).sort((a, b) => b.n - a.n)[0];
  if (!top) return { diagram: model, shared: null };
  const strip = (st: DiagramStep): DiagramStep => ({ ...st, side: st.side.filter((r) => r.toId !== top.route.toId), inner: st.inner.map(strip) });
  return { diagram: { ...model, steps: model.steps.map(strip) }, shared: top.route };
}

/** The changes standing on each station of a flow now, by what each is (a segment's steps count on the segment). */
export function changesHere(flow: PipelineFlow, runs: readonly PipelineRun[]): Map<string, Standing[]> {
  const ids = new Set(flow.stations.map((s) => s.id));
  const out = new Map<string, Standing[]>();
  for (const r of runs) {
    if (!LIVE.has(r.status) || !r.current_node_id) continue;
    const at = ids.has(r.current_node_id) ? r.current_node_id : segmentTopOf(r.current_node_id);
    if (ids.has(at)) out.set(at, [...(out.get(at) ?? []), { name: r.task_title || "a change", id: r._id }]);
  }
  return out;
}

/** The live runs split so the parts add up to them all. */
function flightOf(flow: PipelineFlow, live: readonly PipelineRun[]): Flight {
  const ids = new Set(flow.stations.map((s) => s.id));
  const waits = new Set(flow.stations.filter((s) => s.waits).map((s) => s.id));
  const f: Flight = { working: 0, waiting: 0, paused: 0, elsewhere: 0 };
  for (const r of live) {
    const at = r.current_node_id ? (ids.has(r.current_node_id) ? r.current_node_id : segmentTopOf(r.current_node_id)) : null;
    if (r.status === "paused") f.paused++;
    else if (!at || !ids.has(at)) f.elsewhere++;
    else if (waits.has(at)) f.waiting++;
    else f.working++;
  }
  return f;
}

/** A deploy open this long with nothing reported: stuck, not going out. One with steps reporting gets the length of a
 *  slow gate (hours) before it is called stuck. */
const STUCK_SILENT_MS = 2 * 3600_000;
const STUCK_REPORTING_MS = 8 * 3600_000;

/** A stretch of time in a glance: "45m", "3h", "1d 16h". */
export function spanWords(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** The step of a deploy going out, by its label. */
const stepLabel = (id: string | null | undefined) => (id ? LINE_DEPLOY_STEP_LABELS[id as LineDeployStep | "watch"] ?? null : null);

/**
 * The pipeline with what is on it now. `runs` are the workspace's runs (this repo's change runs are picked out);
 * `targets` and `deploys` are the team's (this repo's are picked out).
 */
export function pipelineModel(p: Pipeline, runs: readonly PipelineRun[] = [], targets: readonly DeployTargetRow[] = [], deploys: readonly TeamDeployRow[] = [], now: number = 0, pending: readonly PendingEdit[] = []): PipelineModel {
  /** An open deploy that has sat too long without going live, and for how long; null while it is still moving. */
  const stuckFor = (d: TeamDeployRow | null) => {
    if (!d || !now) return null;
    const open = now - d.created_at;
    return open > (d.steps?.length ? STUCK_REPORTING_MS : STUCK_SILENT_MS) ? open : null;
  };
  const repo = p.repository.toLowerCase();
  const changeRuns = runs.filter((r) => (r.workflow_slug ?? r.workflow_name) === p.change.slug && runInRepo(r, repo, [p.root]));
  const change = lane(p.change, changesHere(p.change, changeRuns), false, pending);
  const live = changeRuns.filter((r) => LIVE.has(r.status));

  const mine = targets.filter((t) => t.repository.toLowerCase() === repo);
  const mainTargets: MainTarget[] = p.release.targets.map((cfg) => {
    const row = mine.find((t) => t.name === cfg.name);
    const at = targetNow({ name: cfg.name, repository: row?.repository ?? p.repository }, deploys.filter((d) => !d.repository || d.repository.toLowerCase() === repo));
    const running = at.open?.steps?.find((s) => s.status === "running") ?? null;
    const stuck = stuckFor(at.open);
    return {
      name: cfg.name,
      policy: cfg.policy,
      runs: cfg.runs,
      tone: stuck ? "stuck" : row ? targetTone(row, at) : at.open ? "going" : at.failed ? "failed" : "unknown",
      waiting: row?.queue.known ? row.queue.commits : 0,
      ...(row?.queue.reading ? { reading: true as const } : {}),
      groups: row?.queue.groups ?? [],
      // A version that is only a commit hash says nothing a person reads: the age says it.
      live: at.live ? { deploy: at.live.short_id, version: at.live.version && !/^[0-9a-f]{7,40}$/i.test(at.live.version) ? at.live.version : null, at: at.live.live_at ?? at.live.created_at } : null,
      going: at.open ? { deploy: at.open.short_id, step: stepLabel(running?.id), outside: !at.open.steps?.length, stuck } : null,
      failed: at.failed ? { deploy: at.failed.short_id, at: at.failed.finished_at ?? at.failed.created_at, step: at.failed.steps?.find((x) => x.status === "failed")?.id ?? null } : null,
    };
  });

  // The release lane draws the deploy going out now, step by step, when codecast sent it.
  const open = mainTargets.map((t) => (t.going ? deploys.find((d) => d.short_id === t.going!.deploy) ?? null : null)).filter((d): d is TeamDeployRow => !!d).sort((a, b) => b.created_at - a.created_at)[0] ?? null;
  const steps = open?.steps ?? [];
  const run = open && steps.length
    ? { status: "running", current_node_id: steps.find((s) => s.status === "running")?.id ?? null, node_statuses: steps.filter((s) => s.status !== "pending").map((s) => ({ node_id: s.id, status: s.status })) }
    : null;
  // A stuck deploy is what the lane says: one a target is still going out on (newer than its live deploy) that sat too long.
  const stuckOpen = mainTargets.map((t) => (t.going?.stuck ? { deploy: t.going.deploy, for: t.going.stuck, outside: t.going.outside } : null)).find(Boolean) ?? null;
  const here = new Map<string, Standing[]>();
  if (run?.current_node_id) here.set(run.current_node_id, [{ name: open!.short_id, id: open!._id }]);
  const release = lane(p.release, here, true, pending);

  return {
    repository: p.repository,
    name: repoName(p.repository),
    change: { ...change, inFlight: live.length, flight: flightOf(p.change, live), runs: changeRuns },
    main: { targets: mainTargets, waiting: Math.max(0, ...mainTargets.map((t) => t.waiting)), reading: mainTargets.some((t) => !!t.reading) },
    release: { ...release, run, outside: open && !steps.length ? outsideWords(open) : null, stuck: stuckOpen, targets: p.release.targets },
  };
}

/** Who sent a deploy whose steps this flow did not follow: the tool that reported it, when not codecast itself. */
function outsideWords(d: TeamDeployRow): string {
  const who = sourceWord(d);
  return who && who !== "codecast" ? `by ${who}` : "outside this flow";
}

/** One station of a pipeline by id, in whichever lane holds it. */
export function pipelineStation(p: Pipeline, lane: "change" | "release", id: string): PipelineStation | null {
  const flow = lane === "change" ? p.change : p.release;
  return flow.stations.find((s) => s.id === id) ?? flow.stations.find((s) => s.id === segmentTopOf(id)) ?? null;
}

/** A station's runs on the change lane: the changes counted on it now (`standing`, the same ones its count shows), and
 *  the ones that passed through it, each with when it was here (its visit's end, else its start), newest first. */
export function stationRuns(runs: readonly PipelineRun[], id: string, standing: readonly Standing[] = [], limit = 5): { now: Array<{ run: PipelineRun; at: number }>; passed: Array<{ run: PipelineRun; at: number }> } {
  const atStation = (nodeId: string | null | undefined) => !!nodeId && (nodeId === id || segmentTopOf(nodeId) === id);
  const counted = new Set(standing.map((x) => x.id));
  const now: Array<{ run: PipelineRun; at: number }> = [];
  const passed: Array<{ run: PipelineRun; at: number }> = [];
  for (const r of runs) {
    const visits = (r.node_statuses ?? []).filter((n) => atStation(n.node_id));
    const last = visits[visits.length - 1];
    if (counted.has(r._id) || (LIVE.has(r.status) && atStation(r.current_node_id))) now.push({ run: r, at: last?.started_at ?? r.updated_at ?? r.created_at });
    else if (visits.some((n) => n.status === "completed" || n.status === "failed")) {
      const done = [...visits].reverse().find((n) => n.completed_at)?.completed_at;
      passed.push({ run: r, at: done ?? r.updated_at ?? r.created_at });
    }
  }
  const newest = (a: { at: number }, b: { at: number }) => b.at - a.at;
  return { now: now.sort(newest), passed: passed.sort(newest).slice(0, limit) };
}

/** A lane's stations' words and settings by node id, for the station panel (stationView): its prompt and the project's
 *  guidance apart, its command, who runs it. A segment of one step lends them to that step, which is what the drawing picks. */
export function laneStationDetails(flow: PipelineFlow): Record<string, { prompt?: string; guide?: string; script?: string; agent?: string; model?: string }> {
  const out: Record<string, { prompt?: string; guide?: string; script?: string; agent?: string; model?: string }> = {};
  for (const s of flow.stations) {
    // A release step with a command per target says each one in the panel's own list, never as one script.
    const d = { ...(s.prompt ? { prompt: s.prompt } : {}), ...(s.guide ? { guide: s.guide } : {}), ...(s.runs && !s.targets?.length ? { script: meaningfulCommand(s.runs) } : {}), ...(s.agent ? { agent: s.agent } : {}), ...(s.model ? { model: s.model } : {}) };
    if (!Object.keys(d).length) continue;
    out[s.id] = d;
    const inner = flow.graph.nodes.filter((n) => n.id !== s.id && segmentTopOf(n.id) === s.id && n.type !== "exit" && !n.segment_exit);
    if (inner.length === 1) out[inner[0].id] = d;
  }
  return out;
}

/** A station's scope and settings in a glance: who, every change or every release, own or inherited, when. */
export const WHO_WORDS: Record<PipelineStation["who"], string> = { agent: "Agent", command: "Command", person: "Person", rule: "Routes the change", eval: "Graded check", deploy: "Deploy" };

/** How long ago, in a glance: "now", "5m", "3h", "2d". */
export function agoWords(ts: number, now: number): string {
  const m = Math.max(0, Math.round((now - ts) / 60_000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/** One pipeline's own address (pipeline.md PL6). */
export const pipelineHref = (repository: string) => `/flows/pipeline?repo=${encodeURIComponent(repository)}`;

/** The edits sessions in this repo were started to make: each session's first message opens with its `cast flow edit`
 *  commands (editSessionMessage). A session ended without shipping them stops proposing. */
export function pendingEdits(
  repository: string,
  sessions: ReadonlyArray<{ id: string; title: string | null | undefined; project_path?: string | null; repository?: string | null; ended?: boolean }>,
  firstMessage: (id: string) => string | null | undefined,
  roots: ReadonlyArray<string | null | undefined> = [],
): PendingEdit[] {
  const out: PendingEdit[] = [];
  for (const s of sessions) {
    if (s.ended || !runInRepo({ project_path: s.project_path, repository: s.repository }, repository, roots)) continue;
    for (const x of editsOfMessage(firstMessage(s.id))) out.push({ ...x, session: { id: s.id, title: s.title?.trim() || "a new session" } });
  }
  return out;
}

/** The repo's checkout on the machine that publishes its pipeline, and the last changes on its default branch with
 *  their files (contracts/pipeline `root`, `recent`). Rows published before them read no checkout and no changes. */
export function pipelineCheckout(p: Pipeline): { root: string | null; device: string | null; recent: Array<{ files: string[] }> | null } {
  const r = p.recent;
  return { root: p.root ?? null, device: p.device_id, recent: r?.commits?.length ? r.commits.map((c) => ({ files: recentFiles(r, c) })) : null };
}
