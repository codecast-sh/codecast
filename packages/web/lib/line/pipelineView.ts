// The pipeline page's overview, read off the model (pipelineModel): each
// lane's passing path as one track of pills, a side-by-side group as a fork,
// each pill with one small line under it saying who or what does it, and its
// state as quiet marks (how many changes stand on it and how many of those have
// stalled, a proposed edit, a step with no command, the release station the last
// deploy failed at). Side routes are not drawn as routes: a station off the path
// is named, muted, under the station that sends changes to it. And the figures
// the page leads with, each one opening what it counts. Pure: no store, no React.
import type { DiagramStep, StepMark } from "./flowDiagram";
import { meaningfulCommand } from "./pipelineEdit";
import { agoWords, isLiveRun, spanWords, stationRuns, type MainTarget, type PipelineLane, type PipelineModel } from "./pipelineModel";
import type { PipelineStation } from "./pipelineTypes";

/** What a pill says it is, by its icon: a command, an agent, a person, a step that waits, a step that does nothing. */
export type PillKind = "command" | "agent" | "person" | "wait" | "none";

export type TrackPill = {
  type: "pill";
  /** The station's id (null for the change lane's opening Session, which opens no drawer). */
  id: string | null;
  label: string;
  kind: PillKind;
  /** Who or what does it, in a word or two. */
  sub: string | null;
  /** Changes standing on it now, and their names for the hover. */
  count: number;
  names: string[];
  /** A proposed edit not live yet: the words for its hover. */
  proposed: string | null;
  skipped: boolean;
  /** Of `count`, the changes that have sat here longer than STALL_MS: drawn apart, in red. */
  stalled: number;
  /** The last release failed here: "failed 2h ago · production". */
  failed: string | null;
  /** Stations off the passing path this one sends changes to (Revise, Decide): named under it, muted. */
  off: string[];
  /** A change-lane station that waits for the release: its edge runs down into main. */
  intoMain: boolean;
};

export type TrackFork = { type: "fork"; id: string; label: string; branches: TrackPill[]; count: number; names: string[]; off: string[] };

export type TrackItem = TrackPill | TrackFork;

/** A step named by its shell script: `./outreach/deploy.sh --sha $sha` reads `deploy.sh`; anything else reads as a command. */
function programOf(command: string): string | null {
  const c = meaningfulCommand(command);
  const file = c.match(/(?:^|\s|\/)([\w.-]+\.sh)\b/)?.[1];
  return file ?? null;
}

/** The small line under a pill: what it runs or who does it, when that says something beyond its name. */
export function subOf(s: PipelineStation | undefined, mark: StepMark | undefined): string | null {
  if (!s) return null;
  if (mark?.waits || s.waits) return "until it is live";
  if (mark?.passes) return "passes";
  if (s.runs) {
    if (/cast line deploy await-live/.test(s.runs)) return "waits until live";
    if (/cast line deploy watch/.test(s.runs)) return "watches it live";
    return programOf(s.runs);
  }
  if (mark?.varies) return "per target";
  if (s.who === "person") return "you decide";
  if (s.who === "agent") return s.agent ? `${s.agent} agent` : "agent";
  if (s.who === "eval") return "graded check";
  return null;
}

/** A change standing at one station this long has stalled: it is counted apart, in red. */
export const STALL_MS = 24 * 3600_000;

function kindOf(s: PipelineStation | undefined, mark: StepMark | undefined): PillKind {
  if (mark?.passes) return "none";
  if (mark?.waits || s?.waits || s?.who === "rule") return "wait";
  if (s?.who === "person") return "person";
  if (s?.who === "agent" || s?.who === "eval") return "agent";
  return "command";
}

/** The stations off the passing path a step sends changes to, by name, once each. A route back to the session the
 *  change came from is not one: the lane opens on that session. */
function offOf(step: DiagramStep, drawnLabels: ReadonlySet<string>): string[] {
  const names = [step, ...step.inner].flatMap((x) => x.side).map((r) => r.leadsTo).filter((n): n is string => !!n && n !== "this session" && !drawnLabels.has(n));
  return [...new Set(names)];
}

type TrackCtx = { lane: PipelineLane; change: boolean; drawnLabels: ReadonlySet<string>; runs: PipelineModel["change"]["runs"]; now: number; failedAt: { station: string; words: string } | null };

function pillOf(step: DiagramStep, c: TrackCtx): TrackPill {
  const s = c.lane.flow.stations.find((x) => x.id === step.id);
  const mark = c.lane.marks[step.id];
  const count = Math.max(0, (mark?.here ?? 0) - (mark?.hereInside ?? 0));
  const stalled = c.change && c.now && count ? stationRuns(c.runs, step.id, c.lane.standing[step.id] ?? []).now.filter((r) => c.now - r.at > STALL_MS).length : 0;
  const waits = c.change && !!(mark?.waits || s?.waits);
  return {
    type: "pill",
    id: step.id,
    // The change lane deploys nothing: its last station waits for the release that carries the change.
    label: waits ? "Wait for release" : step.label,
    kind: kindOf(s, mark),
    sub: c.failedAt?.station === step.id ? null : subOf(s, mark),
    count,
    names: mark?.hereNames ?? [],
    proposed: mark?.proposed ?? null,
    skipped: !!mark?.skipped,
    stalled: Math.min(stalled, count),
    failed: c.failedAt?.station === step.id ? c.failedAt.words : null,
    off: offOf(step, c.drawnLabels),
    intoMain: waits,
  };
}

/** Where the last failed release failed: the step it reported, else the station that sends that target. */
function failedAt(model: PipelineModel, now: number): TrackCtx["failedAt"] {
  const t = model.main.targets.filter((x) => x.failed).sort((a, b) => b.failed!.at - a.failed!.at)[0];
  if (!t?.failed) return null;
  const ids = new Set(model.release.diagram.steps.flatMap((x) => [x.id, ...x.inner.map((i) => i.id)]));
  const sends = model.release.flow.stations.find((x) => ids.has(x.id) && (x.targets?.some((y) => y.name === t.name && y.runs) || (!x.targets?.length && x.runs && !/cast line deploy (await-live|watch)/.test(x.runs))));
  const station = (t.failed.step && ids.has(t.failed.step) ? t.failed.step : null) ?? sends?.id ?? model.release.diagram.steps[model.release.diagram.steps.length - 1]?.id;
  return station ? { station, words: `failed ${agoWords(t.failed.at, now)} · ${t.name}` } : null;
}

/** The release station the last failed deploy failed at, with the words and the deploy to open; null when none failed. */
export function releaseFailure(model: PipelineModel, now: number): { station: string; words: string; deploy: string } | null {
  const at = failedAt(model, now);
  const t = model.main.targets.filter((x) => x.failed).sort((a, b) => b.failed!.at - a.failed!.at)[0];
  return at && t?.failed ? { ...at, deploy: t.failed.deploy } : null;
}

/** A lane's passing path as a track: the change lane opens on the session the change comes from. `now` (0: none)
 *  counts stalled changes and dates the release's failure. */
export function trackOf(model: PipelineModel, name: "change" | "release", now = 0): TrackItem[] {
  const lane = model[name];
  const change = name === "change";
  const drawnLabels = new Set(lane.diagram.steps.flatMap((x) => [x.label, ...x.inner.map((i) => i.label)]));
  const c: TrackCtx = { lane, change, drawnLabels, runs: model.change.runs, now, failedAt: change ? null : failedAt(model, now) };
  const items: TrackItem[] = change ? [{ type: "pill", id: null, label: "Session", kind: "person", sub: "you work", count: 0, names: [], proposed: null, skipped: false, stalled: 0, failed: null, off: [], intoMain: false }] : [];
  for (const st of lane.diagram.steps) {
    if (st.kind === "join") continue;
    if (st.kind === "parallel" && st.inner.length) {
      // A change counts once: on the branch it stands at, else on the frame (between the branches). The frame's own
      // count and names leave out what its branches show.
      const inside = new Set(st.inner.flatMap((b) => (lane.standing[b.id] ?? []).map((x) => x.id)));
      const between = (lane.standing[st.id] ?? []).filter((x) => !inside.has(x.id));
      items.push({ type: "fork", id: st.id, label: st.label, branches: st.inner.map((b) => ({ ...pillOf(b, c), off: [] })), count: between.length, names: between.map((x) => x.name), off: offOf(st, drawnLabels) });
    } else items.push(pillOf(st, c));
  }
  return items;
}

/** What a figure opens: a deploy's page, main's list, the station a proposed edit stands on, or the changes in flight. */
export type TileOpen = { kind: "deploy"; deploy: string } | { kind: "main" } | { kind: "station"; lane: "change" | "release"; station: string } | { kind: "flight" };

export type StatTile = { key: string; value: string; small: string | null; label: string; tone: "plain" | "bad" | "live"; open: TileOpen | null };

/** A target's state in plain words: what waits for it, and what runs there now. */
export function targetWords(t: MainTarget, now: number): string {
  if (t.going?.stuck) return `stuck ${spanWords(t.going.stuck)}`;
  if (t.going) return t.going.step ? `going out · ${t.going.step}` : "going out";
  if (t.tone === "failed") return "last deploy failed";
  const live = t.live ? `live ${agoWords(t.live.at, now)}` : null;
  if (t.reading) return ["reading what waits", live].filter(Boolean).join(" · ");
  if (t.waiting) return [`${t.waiting} to ship`, live].filter(Boolean).join(" · ");
  if (t.tone === "current") return "up to date";
  return live ?? (t.runs === "push" ? "builds on push" : "not read yet");
}

/** The figures the page leads with, each opening what it counts: changes in flight, what waits on main, the main
 *  target's state (its failed or going deploy), proposed edits (the first one's station). */
export function statTiles(model: PipelineModel, now: number): StatTile[] {
  const flight = model.change.flight;
  const tiles: StatTile[] = [
    { key: "flight", value: String(model.change.inFlight), small: null, label: `changes in flight${flight.paused ? ` · ${flight.paused} paused` : ""}`, tone: "plain", open: model.change.inFlight ? { kind: "flight" } : null },
    { key: "main", value: model.main.reading && !model.main.waiting ? "…" : String(model.main.waiting), small: null, label: model.main.reading && !model.main.waiting ? "reading what waits on main" : model.main.waiting === 1 ? "commit on main waiting to ship" : "commits on main waiting to ship", tone: "plain", open: { kind: "main" } },
  ];
  const [first, ...rest] = model.main.targets;
  if (first) {
    const others = rest.map((t) => `${t.name} ${targetWords(t, now)}`).join(" · ");
    const state: Omit<StatTile, "label"> = first.going?.stuck ? { key: "target", value: "Stuck", small: spanWords(first.going.stuck), tone: "bad", open: { kind: "deploy", deploy: first.going.deploy } }
      : first.going ? { key: "target", value: "Going out", small: first.going.step, tone: "live", open: { kind: "deploy", deploy: first.going.deploy } }
      : first.failed ? { key: "target", value: "Failed", small: agoWords(first.failed.at, now), tone: "bad", open: { kind: "deploy", deploy: first.failed.deploy } }
      : first.live ? { key: "target", value: "Live", small: agoWords(first.live.at, now), tone: "plain", open: { kind: "deploy", deploy: first.live.deploy } }
      : { key: "target", value: "Not read", small: null, tone: "plain", open: { kind: "main" } };
    tiles.push({ ...state, label: [first.name, others].filter(Boolean).join(" · ") });
  }
  const proposals = [...model.change.proposals.map((p) => ({ lane: "change" as const, p })), ...model.release.proposals.map((p) => ({ lane: "release" as const, p }))];
  const firstEdit = proposals[0];
  if (firstEdit) tiles.push({ key: "proposed", value: String(proposals.length), small: null, label: `pipeline ${proposals.length === 1 ? "edit" : "edits"} proposed · awaiting Ship`, tone: "plain", open: { kind: "station", lane: firstEdit.lane, station: firstEdit.p.edit.op === "add" ? firstEdit.p.edit.id : firstEdit.p.edit.station } });
  return tiles;
}

/** The sessions whose commits wait on main, across targets, without repeats: a colour for each avatar, and what the
 *  newest of its commits changed (its subject), which says more than a session's name. */
export function waitingSessions(model: PipelineModel): Array<{ key: string; conversationId: string | null; title: string; subject: string | null; commits: number }> {
  const by = new Map<string, { key: string; conversationId: string | null; title: string; subject: string | null; at: number; commits: number }>();
  for (const t of model.main.targets) for (const g of t.groups) {
    const key = g.session?.conversation_id ?? g.key;
    const cur = by.get(key) ?? { key, conversationId: g.session?.conversation_id ?? null, title: g.session?.title?.trim() || "commits from no session", subject: null, at: 0, commits: 0 };
    cur.commits = Math.max(cur.commits, g.commits.length);
    for (const c of g.commits) if (c.at > cur.at) { cur.at = c.at; cur.subject = c.subject; }
    by.set(key, cur);
  }
  return [...by.values()].sort((a, b) => b.commits - a.commits).map(({ at: _at, ...x }) => x);
}

/** The changes in flight by the station each stands at, in the lane's order and by the names the track draws (a fan-out
 *  by its own name, then its branches); those at no drawn station last, as `id` null. */
export function flightByStation(model: PipelineModel): Array<{ id: string | null; label: string; rows: ReturnType<typeof stationRuns>["now"] }> {
  const l = model.change;
  const spots = trackOf(model, "change").flatMap((it) => (it.type === "fork" ? [{ id: it.id, label: it.label }, ...it.branches] : it.id ? [it] : []));
  const seen = new Set<string>();
  const out: Array<{ id: string | null; label: string; rows: ReturnType<typeof stationRuns>["now"] }> = [];
  for (const sp of spots) {
    const rows = stationRuns(l.runs, sp.id!, l.standing[sp.id!] ?? []).now.filter((r) => isLiveRun(r.run) && !seen.has(r.run._id));
    rows.forEach((r) => seen.add(r.run._id));
    if (rows.length) out.push({ id: sp.id, label: sp.label, rows });
  }
  const rest = l.runs.filter((r) => isLiveRun(r) && !seen.has(r._id)).map((run) => ({ run, at: run.updated_at ?? run.created_at }));
  if (rest.length) out.push({ id: null, label: "Between stations", rows: rest });
  return out;
}
