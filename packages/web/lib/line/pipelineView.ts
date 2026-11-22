// The pipeline page's overview, read off the model (pipelineModel): each
// lane's passing path as one track of pills, a side-by-side group as a fork,
// each pill with one small line under it saying who or what does it, and its
// state as quiet marks (how many changes stand on it, a proposed edit, a step
// with no command). Side routes are not on the overview: they live in the
// station's drawer. And the four figures the page leads with. Pure: no store,
// no React.
import type { DiagramStep, StepMark } from "./flowDiagram";
import { meaningfulCommand } from "./pipelineEdit";
import { agoWords, spanWords, type MainTarget, type PipelineLane, type PipelineModel } from "./pipelineModel";
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
};

export type TrackFork = { type: "fork"; id: string; label: string; branches: TrackPill[]; count: number; names: string[] };

export type TrackItem = TrackPill | TrackFork;

/** A step named by its shell script: `./outreach/deploy.sh --sha $sha` reads `deploy.sh`; anything else reads as a command. */
function programOf(command: string): string | null {
  const c = meaningfulCommand(command);
  const file = c.match(/(?:^|\s|\/)([\w.-]+\.sh)\b/)?.[1];
  return file ?? null;
}

/** The small line under a pill: who does it, or what it runs, in a word or two. */
export function subOf(s: PipelineStation | undefined, mark: StepMark | undefined): string | null {
  if (!s) return null;
  if (mark?.waits || s.waits) return "waits for the deploy";
  if (mark?.passes) return null;
  if (s.runs) {
    if (/cast line deploy await-live/.test(s.runs)) return "waits until live";
    if (/cast line deploy watch/.test(s.runs)) return "watches it live";
    return programOf(s.runs) ?? "command";
  }
  if (mark?.varies) return "per target";
  if (s.who === "person") return "you decide";
  if (s.who === "agent") return s.agent ? `${s.agent} agent` : "agent";
  if (s.who === "eval") return "graded check";
  if (s.who === "command") return "command";
  return null;
}

function kindOf(s: PipelineStation | undefined, mark: StepMark | undefined): PillKind {
  if (mark?.passes) return "none";
  if (mark?.waits || s?.waits || s?.who === "rule") return "wait";
  if (s?.who === "person") return "person";
  if (s?.who === "agent" || s?.who === "eval") return "agent";
  return "command";
}

function pillOf(step: DiagramStep, lane: PipelineLane, own = 0): TrackPill {
  const s = lane.flow.stations.find((x) => x.id === step.id);
  const mark = lane.marks[step.id];
  const count = own || (mark?.here ?? 0) - (mark?.hereInside ?? 0);
  return {
    type: "pill",
    id: step.id,
    label: step.label,
    kind: kindOf(s, mark),
    sub: subOf(s, mark),
    count: Math.max(0, count),
    names: mark?.hereNames ?? [],
    proposed: mark?.proposed ?? null,
    skipped: !!mark?.skipped,
  };
}

/** A lane's passing path as a track: the change lane opens on the session the change comes from. */
export function trackOf(lane: PipelineLane, change: boolean): TrackItem[] {
  const items: TrackItem[] = change ? [{ type: "pill", id: null, label: "Session", kind: "person", sub: "you work", count: 0, names: [], proposed: null, skipped: false }] : [];
  for (const st of lane.diagram.steps) {
    if (st.kind === "join") continue;
    if (st.kind === "parallel" && st.inner.length) {
      const mark = lane.marks[st.id];
      items.push({ type: "fork", id: st.id, label: st.label, branches: st.inner.map((b) => pillOf(b, lane)), count: Math.max(0, (mark?.here ?? 0) - (mark?.hereInside ?? 0)), names: mark?.hereNames ?? [] });
    } else items.push(pillOf(st, lane));
  }
  return items;
}

/** How many of a release lane's steps run something, for its one legend line. */
export function runningOf(lane: PipelineLane): { running: number; steps: number } {
  const steps = lane.diagram.steps.filter((s) => s.kind !== "join");
  return { running: steps.filter((s) => !lane.marks[s.id]?.passes).length, steps: steps.length };
}

export type StatTile = { key: string; value: string; small: string | null; label: string; tone: "plain" | "accent" | "bad" | "live" };

/** A target's state in plain words: what waits for it, and what runs there now. */
export function targetWords(t: MainTarget, now: number): string {
  if (t.going?.stuck) return `stuck ${spanWords(t.going.stuck)}`;
  if (t.going) return t.going.step ? `going out · ${t.going.step}` : "going out";
  if (t.tone === "failed") return "last deploy failed";
  const live = t.live ? `live ${agoWords(t.live.at, now)}` : null;
  if (t.waiting) return [`${t.waiting} to ship`, live].filter(Boolean).join(" · ");
  if (t.tone === "current") return "up to date";
  return live ?? (t.runs === "push" ? "builds on push" : "not read yet");
}

/** The figures the page leads with: changes in flight, what waits on main, the main target's state, proposed edits. */
export function statTiles(model: PipelineModel, now: number): StatTile[] {
  const flight = model.change.flight;
  const tiles: StatTile[] = [
    { key: "flight", value: String(model.change.inFlight), small: null, label: `changes in flight${flight.paused ? ` · ${flight.paused} paused` : ""}`, tone: "plain" },
    { key: "main", value: String(model.main.waiting), small: null, label: model.main.waiting === 1 ? "commit on main waiting to ship" : "commits on main waiting to ship", tone: "plain" },
  ];
  const [first, ...rest] = model.main.targets;
  if (first) {
    const others = rest.map((t) => `${t.name} ${targetWords(t, now)}`).join(" · ");
    const state: StatTile = first.going?.stuck ? { key: "target", value: "Stuck", small: spanWords(first.going.stuck), label: "", tone: "bad" }
      : first.going ? { key: "target", value: "Going out", small: first.going.step, label: "", tone: "live" }
      : first.tone === "failed" ? { key: "target", value: "Failed", small: null, label: "", tone: "bad" }
      : first.live ? { key: "target", value: "Live", small: agoWords(first.live.at, now), label: "", tone: "plain" }
      : { key: "target", value: "Not read", small: null, label: "", tone: "plain" };
    tiles.push({ ...state, label: [first.name, others].filter(Boolean).join(" · ") });
  }
  const proposed = model.change.proposals.length + model.release.proposals.length;
  if (proposed) tiles.push({ key: "proposed", value: String(proposed), small: null, label: `pipeline ${proposed === 1 ? "edit" : "edits"} proposed · awaiting Ship`, tone: "accent" });
  return tiles;
}

/** The sessions whose commits wait on main, across targets, without repeats: a name and a colour for each avatar. */
export function waitingSessions(model: PipelineModel): Array<{ key: string; conversationId: string | null; title: string; commits: number }> {
  const by = new Map<string, { key: string; conversationId: string | null; title: string; commits: number }>();
  for (const t of model.main.targets) for (const g of t.groups) {
    const key = g.session?.conversation_id ?? g.key;
    const cur = by.get(key) ?? { key, conversationId: g.session?.conversation_id ?? null, title: g.session?.title?.trim() || "commits from no session", commits: 0 };
    cur.commits = Math.max(cur.commits, g.commits.length);
    by.set(key, cur);
  }
  return [...by.values()].sort((a, b) => b.commits - a.commits);
}
