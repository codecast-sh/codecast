// The line workspace's one model (docs/architecture/line-workspace.md LW2):
// a project's line as every view reads it. The Graph, the Notebook, Replay
// and Chat all render this one value, so a step, a run or a decision reads the
// same in each. Pure: no store, no React. It builds on lineGraphs (which
// graphs a project runs, who does a step, what it is for), runReport (a
// station's words, a run's outcome, a session's report) and lineMap (a run's
// visits, loops included); nothing here is computed a second time.
//
// ── The stable API ──────────────────────────────────────────────────────────
//
//   buildLineModel(rows: LineModelRows, graphKey: string): LineModel
//
//   LineModel
//     graphKey, title          the graph drawn, and its name as a reader says it
//     graphs: ProjectGraph[]   every graph this project's causes run (lineGraphs)
//     graph: LineGraphModel    { nodes, edges, stages, halves }
//     steps: Record<id, LineStep>, order: string[]   every step, in reading order
//     runs: LineRunModel[]     newest first, each a path of LineVisit
//     issues: LineIssue[]      the causes these runs worked, and the project's
//                              causes no run has taken yet; newest activity first
//     labels: { right, wrong } how many decisions people have labeled
//
//   LineIssue.history: CauseHistory (causeHistory.ts), the cause's life for the
//   Timeline and for the next attempt (LW5):
//     occurrences [{ at, reopened }] oldest first, for bucketing
//     attempts    each run: start, end, outcome, found/proposed/built, card
//                 and its answer, diff, merge { sha, into, at, prUrl }
//     ships       each shipped run: its merge, the deploys that carried it,
//                 liveAt and its basis (deploy | merge | ship), in words
//     deploys     every deploy that carried one of its merges, and how
//                 (same commit | deployed after the merge)
//     coverage    what codecast knows about deploys (unread | none | known)
//     watches     each watch window: start, end, watching|quiet|reopened
//     regressions occurrences after a fix went live, until the next fix
//     regressed   the newest fix did not hold
//   historyBrief(history): the earlier attempts in words, for the next one.
//
//   LineStep      kind agent|script|person|end, label, purpose, prompt,
//                 outcomes (where it sends work, how often), decisions
//   StepDecision  one visit's record: received, decided, reasoning, label
//   LineVisit     one visit of a run: received, decided, why, duration, status
//
//   Helpers: edgeWords, conditionWords, decisionId, lineLabelKey, historyBrief.
//
// Hooks over it (hooks/useLineWorkspace.ts): useLineWorkspace(projectId,
// graphKey), useLineSelection(), useStationInput(sessionId, runId), and the
// store action labelDecision(runId, nodeId, verdict, note).
//
// Station words: a visit's received/decided/why come from its station
// session's pinned report (runReport stationReport, fed by withAgentSessions);
// the full brief a station was handed is read on demand (useStationInput).
import { CARD_GATE_NODE_ID } from "@codecast/shared/contracts/changeCard";
import type { LineCauseTask } from "../lineFlow";
import {
  CODECAST_LINE, backEdgeSet, fileStepLabel, gateAnswers, graphForMap, graphFromIds, graphKeyOf, graphTitle, guessPhase, isCodecastLine,
  projectGraphs, readableTemplate, stationPurpose, stationWho, stepLabel,
  type GraphEdgeIn, type GraphEnd, type GraphNodeIn, type GraphRun, type ProjectGraph,
} from "./lineGraphs";
import { runVisits, type LineGraph, type MapDecision, type MapRun, type MapSignal, type RunVisit } from "./lineMap";
import { EARLIER_ROUND_WORDS, plainWords } from "./lineTrace";
import {
  LINE_PHASES, causeWhere, choiceWords, isLiveRun, phaseOfStation, plainStepWords, runOutcome, runPath, stationReport,
  type LinePhaseKey, type ReportNode, type ReportRun, type ReportStep, type ReportTask, type RunOutcome, type StepState,
} from "./runReport";
import { SHIPPED_LINE } from "./shippedLine.generated";
import { causeHistory, type CauseHistory, type DeployRow, type OccurrenceRow } from "./causeHistory";
import { reportFieldWords, saidSlot, signalQuotes } from "@codecast/shared/contracts/causeHistory";
import { halfOfPhase } from "@codecast/shared/contracts/linePhases";
import type { LabelVerdict } from "./lineLabels";

export { lineLabelKey, type LabelVerdict } from "./lineLabels";

export {
  historyBrief, carryingDeploys, closesSummary,
  type CauseHistory, type DeployRow, type OccurrenceRow, type Occurrence, type HistoryAttempt, type AttemptCard, type AttemptMerge,
  type HistoryShip, type HistoryDeploy, type HistoryWatch, type HistoryRegression, type DeployCoverage, type FixBasis, type CarriedHow, type WatchState,
  type HistoryClose, type HistoryRecurrence, type CloseKind,
} from "./causeHistory";

// ── what the model reads ─────────────────────────────────────────────────────

/** A person's verdict on one decision (line_labels, lineWorkspace.labels). */
export type LineLabelRow = {
  _id: string;
  key: string;
  workspace?: string;
  team_id?: string;
  project_id?: string;
  run_id: string;
  node_id: string;
  verdict: LabelVerdict;
  note?: string;
  by: string;
  at: number;
};

/** The graph's own row (workflows): its stations with their prompts and scripts, and the .cast source naming their files. */
export type LineGraphSource = { nodes: ReadonlyArray<GraphNodeIn>; edges: ReadonlyArray<GraphEdgeIn>; source?: string | null; name?: string | null };

/** The rows one project's line is read from: scope them to the project first (lineFlow scopeLine). */
export type LineModelRows = {
  runs: ReadonlyArray<MapRun>;
  tasks: ReadonlyArray<LineCauseTask>;
  signals?: ReadonlyArray<MapSignal>;
  decisions?: ReadonlyArray<MapDecision>;
  labels?: ReadonlyArray<LineLabelRow>;
  /** The drawn graph's row. Without one: codecast's shipped line, else the stations its runs recorded. */
  graph?: LineGraphSource | null;
  /** Shared prompt sections by name, when the caller has their text. */
  shared?: Readonly<Record<string, string>>;
  /** Whose label a decision shows first. */
  viewerId?: string | null;
  /** A person's name by user id, for who labeled a decision. */
  names?: ReadonlyMap<string, string>;
  now?: number;
  /** Each cause's occurrences over the history window (lineWorkspace.occurrences); a cause without a row reads its recent signals. */
  occurrences?: ReadonlyArray<OccurrenceRow>;
  /** The project's recorded deploys (lineWorkspace.deploys); undefined until read. */
  deploys?: ReadonlyArray<DeployRow>;
  /** The line profile's watch days, for a watch window whose end the cause no longer holds. */
  watchDays?: number | null;
};

// ── what the model is ────────────────────────────────────────────────────────

export type StepKind = "agent" | "script" | "person" | "end";
/** The two halves of a line: finding what is wrong, then fixing it. */
export type LineHalf = "diagnose" | "fix";
export type EdgeKind = "flow" | "branch" | "loop";

export type ModelNode = {
  id: string;
  label: string;
  /** The graph file's own label when the step shows a plain word instead. */
  fileLabel: string | null;
  kind: StepKind;
  stage: LinePhaseKey;
  half: LineHalf;
  /** Column, left to right: the longest path from the start, loops left out. */
  col: number;
  /** How a terminal step ends a run, for kind "end". */
  end: GraphEnd | null;
  /** Visits across the runs read, loops counted; runs that reached it. */
  visits: number;
  runs: number;
  /** Its decisions that decided the step failed, and its sessions that were cut off (killed, timed out): the step's tally (LineStep.tally). */
  failed: number;
  cutOff: number;
  /** Median time a timed visit took. */
  medianMs: number | null;
};

export type ModelEdge = {
  /** "from->to". */
  id: string;
  from: string;
  to: string;
  /** The branch in plain words ("not reproduced", "Revise"); null for a plain hand-on. */
  words: string | null;
  /** A person's answer's effect ("Your note goes back to the builder"). */
  does: string | null;
  /** The graph's own condition, for a reader who wants the rule. */
  condition: string | null;
  kind: EdgeKind;
  /** A person's answer at a gate. */
  gate: boolean;
  /** How many times runs took it, loops counted. */
  count: number;
  /** Of the runs that took it to an end, how many closed a problem that came back. */
  back: number;
};

export type ModelStage = { key: LinePhaseKey; label: string; half: LineHalf; nodes: string[] };
export type ModelHalf = { key: LineHalf; label: string; stages: LinePhaseKey[] };
export type LineGraphModel = { nodes: ModelNode[]; edges: ModelEdge[]; stages: ModelStage[]; halves: ModelHalf[] };

/** A shared section a prompt pulls in ("$shared.json.rulings"). `text` is null when the caller has not read it. */
export type PromptInclude = { name: string; from: string; text: string | null };
/** The run of recent runs that ran this step's current text: its hash, since when, how many runs. */
export type StepVersion = { hash: string; since: number; runs: number; earlier: boolean };
/** One text a step ran with: its hash, its first and newest run, how many runs read it. */
export type StepTextVersion = { hash: string; since: number; until: number; runs: number };
export type StepPrompt = {
  kind: "prompt" | "script";
  /** The text as the graph holds it. */
  text: string;
  /** The text with inserted values said in words, linked to their steps (lineGraphs readableTemplate). */
  readable: string;
  includes: PromptInclude[];
  /** The file the graph reads it from ("outreach/line/agentwatch/build.md"). */
  file: string | null;
  version: StepVersion | null;
  /** Every text the runs read, newest first; `version` is the first. */
  versions: StepTextVersion[];
};

/** Where a step sends work, and how often runs went there. */
/** One way out of a step: `count` runs took it, `back` of them closed a problem that came back (its edge's own count, which the graph's "can end" reads). */
export type StepOutcome = { key: string; words: string; to: string; toLabel: string; count: number; back: number; kind: EdgeKind; does: string | null };

/** What a visit was handed: the step before it and what that step decided, and the session that holds the full brief (useStationInput). */
export type StepReceived = {
  from: string | null; fromLabel: string | null; summary: string;
  /** The step before said something of its own ("Investigate: Found why it happens"); false when it only handed the run on, which a header naming it already says. */
  said: boolean;
  sessionId: string | null; href: string | null;
};
/** What a visit decided: its outcome key, in words, the structured result it reported, and where the run went next. */
export type StepDecided = { outcome: string | null; words: string; result: Record<string, unknown> | null; to: string | null; toLabel: string | null; toWords: string | null };
export type DecisionLabel = { verdict: LabelVerdict; note: string | null; by: string; byName: string | null; at: number; mine: boolean };

export type StepDecision = {
  /** decisionId(runId, stepId). */
  id: string;
  runId: string;
  caseId: string | null;
  caseRef: string | null;
  caseTitle: string;
  at: number | null;
  durationMs: number | null;
  status: StepState;
  received: StepReceived;
  decided: StepDecided;
  /** The step's own reasoning: the prose of the report its session pinned, or a person's note. */
  reasoning: string | null;
  /** The viewer's label, else the newest. */
  label: DecisionLabel | null;
  labels: DecisionLabel[];
  /** When this decision closed its problem (a dissolve, a drop, a fix going live): whether the close held. */
  closed?: DecisionClose | null;
};

/** A close a decision made and whether it held: `count` occurrences came back after it ("Came back 3 times after attempt 2 dissolved it"). */
export type DecisionClose = { held: boolean; count: number; words: string | null };

/** How many of a step's decisions closed a problem that came back: the graph's badge, its "can end" words and the Notebook's outline all count this. */
export const stepCameBack = (s: Pick<LineStep, "tally">) => s.tally.rows.reduce((n, r) => n + r.back, 0);

/** One outcome in a step's tally: how many of its decisions reached it, how many of those closed a problem that came back, and where they sent the run. */
export type StepTallyRow = { key: string; n: number; back: number; to: string | null; toLabel: string | null };

/**
 * A step's decisions counted once, by one key per decision (decisionKey): the
 * drawer's header, its outcome chips, the Decisions filters, the Notebook and
 * the chat's widgets all read this, so a step's counts agree everywhere.
 * "failed" is a step that decided it failed; "cut off" is a session that was
 * killed or timed out before it decided anything.
 */
export type StepTally = { total: number; rows: StepTallyRow[]; failed: number; cutOff: number; live: number };

export type LineStep = {
  id: string;
  kind: StepKind;
  label: string;
  fileLabel: string | null;
  purpose: string;
  stage: LinePhaseKey;
  half: LineHalf;
  prompt: StepPrompt | null;
  outcomes: StepOutcome[];
  /** A person's answers at a gate. */
  answers: Array<{ answer: string; does: string | null }>;
  /** Newest first. */
  decisions: StepDecision[];
  /** Its decisions counted by outcome (tallyDecisions). */
  tally: StepTally;
  model: string | null;
  maxVisits: number | null;
  timeoutS: number | null;
};

export type LineVisit = {
  index: number;
  node: string;
  label: string;
  kind: StepKind;
  at: number | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  status: StepState;
  /** An earlier round of a loop: the run row keeps details for the newest visit only. */
  inferred: boolean;
  received: StepReceived;
  decided: StepDecided;
  why: string | null;
  sessionId: string | null;
};

export type LineRunModel = {
  id: string;
  caseId: string | null;
  caseRef: string | null;
  caseTitle: string;
  status: string;
  live: boolean;
  outcome: RunOutcome;
  at: number;
  updatedAt: number;
  durationMs: number | null;
  /** The step it is at now, or stopped at. */
  at_node: string | null;
  graphHash: string | null;
  visits: LineVisit[];
};

export type IssueQuote = { text: string; source: string; ref: string | null };
export type LineIssue = {
  id: string;
  ref: string | null;
  title: string;
  status: string;
  /** Reports the cause holds (signals). */
  findings: number;
  quotes: IssueQuote[];
  /** Its runs on this graph, newest first; empty for a cause no run has taken yet. */
  runs: string[];
  /** Its newest run's start, 0 when none. */
  lastRunAt: number;
  where: RunOutcome;
  history: CauseHistory;
};

export type LineModel = {
  graphKey: string;
  title: string;
  graphs: ProjectGraph[];
  graph: LineGraphModel;
  steps: Record<string, LineStep>;
  order: string[];
  runs: LineRunModel[];
  issues: LineIssue[];
  labels: { right: number; wrong: number };
};

// ── helpers every view shares ────────────────────────────────────────────────

/** One decision's id: the run and the step. */
export const decisionId = (runId: string, stepId: string) => `${runId}:${stepId}`;

const FAILED_OUTCOME = /^(fail|failed|failure)$/i;

/** A decision's key in a tally: what it reported, else "failed" when the step
 *  decided it failed, "cut off" when its session failed (killed, timed out)
 *  before reporting anything, "running" and "waiting" while it is; a step that
 *  finished without reporting an outcome decided the branch its run took
 *  ("open"), and "handed on" when that branch has no words. A session that
 *  reported and then failed still decided what it reported. */
export function decisionKey(d: { status: StepState; decided: { outcome: string | null; toWords?: string | null } }): string {
  const own = d.decided.outcome;
  if (d.status === "live") return "running";
  if (d.status === "waiting") return "waiting";
  if (own && FAILED_OUTCOME.test(own)) return "failed";
  if (d.status === "failed") return own ?? "cut off";
  return own ?? d.decided.toWords ?? "handed on";
}

/** A case's decisions at one step: the newest, and the earlier runs on the same case under it. */
export type CaseDecisions = {
  key: string; latest: StepDecision; earlier: StepDecision[];
  /** Of the earlier runs, the closes the problem came back after (their `closed`, as the step's tally counts): a newest run that was cut off does not hide them. */
  earlierBack: number;
};

/** Decisions (newest first) grouped by case, each case where its newest run
 *  falls: a case run five times reads as one case with four earlier runs. A
 *  decision without a case stands alone. */
export function decisionsByCase(decisions: ReadonlyArray<StepDecision>): CaseDecisions[] {
  const by = new Map<string, CaseDecisions>();
  for (const d of decisions) {
    const key = d.caseId ?? `run:${d.runId}`;
    const had = by.get(key);
    if (had) { had.earlier.push(d); if (d.closed && !d.closed.held) had.earlierBack++; }
    else by.set(key, { key, latest: d, earlier: [], earlierBack: 0 });
  }
  return [...by.values()];
}

/** Each run whose close the problem came back after, with what came back: the same closes a decision's `closed` reads, by run. */
export function cameBackByRun(issues: ReadonlyArray<Pick<LineIssue, "history">>): Map<string, DecisionClose> {
  const out = new Map<string, DecisionClose>();
  for (const { history: h } of issues) for (const c of h.closes) if (c.back) out.set(c.runId, { held: false, count: c.back.count, words: c.back.words });
  return out;
}

/** What a run actually found at a step, in its own words: the first line of
 *  its reasoning when it gave one (the outcome's tag already says the generic
 *  "Found why it happens"), else the finding its report put in words
 *  (`statement`, `evidence`), else what it decided. The history's "Found" reads
 *  the same words, so the next attempt is handed the argument, not the label. */
export function decisionSaid(d: { reasoning: string | null; decided: Pick<LineVisit["decided"], "words" | "result"> }): string {
  const line = (d.reasoning ?? "").split("\n").map((l) => plainWords(l.replace(/^\s*(?:#+|[-*>]|\d+\.)\s*/, "")).trim()).find((l) => l.length > 12)
    ?? reportFieldWords(d.decided.result)?.replace(/\s+/g, " ");
  if (!line) return d.decided.words;
  return line.length > 240 ? `${line.slice(0, 239).trimEnd()}…` : line;
}

/** Decisions counted by key, the most first; each row names where most of them sent the run. */
export function tallyDecisions(decisions: ReadonlyArray<Pick<StepDecision, "status" | "decided" | "closed">>): StepTally {
  const rows = new Map<string, StepTallyRow & { tos: Map<string, number> }>();
  let live = 0;
  for (const d of decisions) {
    const key = decisionKey(d);
    if (key === "running" || key === "waiting") live++;
    const row = rows.get(key) ?? { key, n: 0, back: 0, to: null, toLabel: null, tos: new Map() };
    row.n++;
    if (d.closed && !d.closed.held) row.back++;
    if (d.decided.to) {
      const n = (row.tos.get(d.decided.to) ?? 0) + 1;
      row.tos.set(d.decided.to, n);
      if (!row.to || n > (row.tos.get(row.to) ?? 0)) { row.to = d.decided.to; row.toLabel = d.decided.toLabel; }
    }
    rows.set(key, row);
  }
  const list = [...rows.values()].map(({ tos: _tos, ...r }) => r).sort((a, b) => b.n - a.n);
  return { total: decisions.length, rows: list, failed: rows.get("failed")?.n ?? 0, cutOff: rows.get("cut off")?.n ?? 0, live };
}

const HALVES: ModelHalf[] = [
  { key: "diagnose", label: "Diagnose", stages: ["understand", "prove"] },
  { key: "fix", label: "Fix", stages: ["build", "check", "decide", "ship"] },
];
const halfOf = (stage: LinePhaseKey): LineHalf => halfOfPhase(stage);
const isStartOrExit = (n: Pick<GraphNodeIn, "id" | "type">) => n.id === "start" || n.id === "exit" || n.type === "start" || n.type === "exit";
const humanize = (s: string) => s.replace(/_/g, " ").trim();

/** A step that passed hands on without words; one that failed says so. */
const VALUE_WORDS: Record<string, string | null> = { success: null, failure: "failed" };
const REVIEW_WORDS: Record<string, string> = { approve: "review approved", changes: "review asked for changes", reject: "review rejected" };

/** One clause of a condition in words, or null for a qualifier a reader does not need ("category != line"). */
function clauseWords(clause: string): string | null {
  const c = clause.trim().replace(/^\(|\)$/g, "");
  const bare = c.match(/^(not\s+)?([\w.]+)$/);
  if (bare) {
    const field = bare[2].split(".").pop()!;
    if (field === "goal_ref") return bare[1] ? "no goal" : null;
    return bare[1] ? `not ${humanize(field)}` : humanize(field);
  }
  const m = c.match(/^([\w.]+)\s*(!=|=)\s*(.+)$/);
  if (!m) return humanize(c);
  const [, lhs, op, raw] = m;
  const value = raw.trim().replace(/^["']|["']$/g, "");
  const not = op === "!=";
  const field = lhs.split(".").pop()!;
  if (field === "exit_code") return null;
  if (lhs === "outcome" || field === "outcome") {
    const w = value in VALUE_WORDS ? VALUE_WORDS[value] : humanize(value);
    if (!not) return w;
    return value === "success" ? "failed" : value === "failure" ? null : `not ${w}`;
  }
  if (lhs === "review_verdict") return not ? null : REVIEW_WORDS[value] ?? `review ${humanize(value)}`;
  if (lhs === "handoff") return not ? null : `handed off ${humanize(value)}`;
  if (lhs === "category") return not ? null : `a ${humanize(value)} cause`;
  if (lhs === "risk") return not ? null : value === "plan" ? "needs a plan" : `${humanize(value)} risk`;
  if (lhs === "readiness") return not ? `not ${humanize(value)}` : humanize(value);
  if (lhs === "goal_ref") return value === "none" ? (not ? null : "no goal") : null;
  if (value === "true" || value === "false") {
    const yes = (value === "true") !== not;
    return yes ? humanize(field) : `not ${humanize(field)}`;
  }
  return not ? `${humanize(field)} not ${humanize(value)}` : `${humanize(field)} ${humanize(value)}`;
}

/** A graph condition in words: "prove.json.reproduced = false" reads "not
 *  reproduced", "readiness != ready or goal_ref = none" reads "not ready or
 *  no goal". Qualifiers a reader does not need drop out; null when nothing is left. */
export function conditionWords(condition: string | null | undefined): string | null {
  if (!condition?.trim()) return null;
  const alts = condition.split(/\s+or\s+/i).map((alt) => {
    const words = alt.split(/\s+and\s+/i).map(clauseWords).filter((w): w is string => !!w);
    return [...new Set(words)].join(" and ");
  }).filter(Boolean);
  const unique = [...new Set(alts)];
  return unique.length ? unique.join(" or ") : null;
}

/** An edge in plain words: a gate's answer or the graph's own label (the map's
 *  wording), else its condition in words; null for a plain hand-on. */
export function edgeWords(e: Pick<GraphEdgeIn, "label" | "condition">): string | null {
  if (e.label) return plainStepWords(choiceWords(e.label));
  return conditionWords(e.condition);
}

/** The file a step's prompt or script is read from: its "@path" in the .cast source. */
function fileOf(id: string, source: string | null | undefined, isLine: boolean): string | null {
  if (source) {
    const m = new RegExp(String.raw`(?:^|\n)\s*${id.replace(/[^\w]/g, "")}\s*\[[^\]]*?\b(?:prompt|script)\s*=\s*"@([^"]+)"`).exec(source);
    if (m) return m[1];
  }
  if (isLine) {
    const files = SHIPPED_LINE.files[id];
    return files?.prompt ?? files?.script ?? null;
  }
  return null;
}

/** The shared sections a text pulls in: "$shared.json.<name>". */
function includesOf(text: string, shared: Readonly<Record<string, string>> | undefined): PromptInclude[] {
  const out: PromptInclude[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/\$(shared\w*)\.json\.(\w+)/g)) {
    if (seen.has(m[2])) continue;
    seen.add(m[2]);
    out.push({ name: m[2], from: m[1], text: shared?.[m[2]] ?? null });
  }
  return out;
}

const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Each node's column: its longest path from the start, loops left out. */
function columnsOf(ids: string[], edges: ReadonlyArray<GraphEdgeIn>, loops: Set<string>): Map<string, number> {
  const fwd = edges.filter((e) => !loops.has(`${e.from}->${e.to}`));
  const col = new Map<string, number>([["start", 0]]);
  for (let pass = 0; pass <= fwd.length; pass++) {
    let moved = false;
    for (const e of fwd) {
      const c = col.get(e.from);
      if (c == null) continue;
      if ((col.get(e.to) ?? -1) < c + 1) { col.set(e.to, c + 1); moved = true; }
    }
    if (!moved) break;
  }
  // A step no walk from the start reaches still takes a place.
  for (const id of ids) if (!col.has(id)) col.set(id, 1);
  return col;
}

// ── one run, read once per run row ───────────────────────────────────────────

type RunRead = { visits: LineVisit[]; reports: Map<string, ReportStep> };
type GraphCtx = { graph: LineGraph; kindOf: Map<string, StepKind>; labelOf: (id: string) => string; words: Map<string, string | null> };

/** A run row's reading for one graph, kept while the row, its cause and its gate decisions are unchanged: a 1000-run line rereads only the runs that moved. */
const runCache = new WeakMap<LineGraph, WeakMap<object, { task: unknown; decisionsSig: string; read: RunRead }>>();

function readRun(run: MapRun, task: LineCauseTask | undefined, decisions: ReadonlyArray<MapDecision>, g: GraphCtx): RunRead {
  const decisionsSig = decisions.map((d) => `${d._id}:${d.status}`).join(",");
  let byRun = runCache.get(g.graph);
  if (!byRun) { byRun = new WeakMap(); runCache.set(g.graph, byRun); }
  const hit = byRun.get(run);
  if (hit && hit.task === task && hit.decisionsSig === decisionsSig) return hit.read;

  const steps = runPath(run as ReportRun, g.graph, task as ReportTask | undefined).flatMap((p) => [...p.steps, ...p.routine]);
  const reports = new Map(steps.map((s) => [s.id, s]));
  const nodes = new Map((run.node_statuses ?? []).map((n) => [n.node_id, n as ReportNode]));
  const raw = runVisits(run, g.graph, decisions).filter((v) => v.node !== "start" && v.node !== "exit");
  const title = task?.title ?? run.task_title ?? "The cause";
  const visits: LineVisit[] = [];
  raw.forEach((v: RunVisit, i) => {
    const node = v.inferred ? undefined : nodes.get(v.node);
    const report = node ? stationReport(node.session as ReportNode["session"]) : null;
    const step = v.inferred ? undefined : reports.get(v.node);
    const next = raw[i + 1];
    const prev = visits[i - 1];
    const sessionId = node?.session?._id ? String(node.session._id) : null;
    const words = v.inferred ? EARLIER_ROUND_WORDS
      : step?.result ?? report?.line ?? scriptWords(node) ?? (v.state === "failed" ? "Failed" : v.state === "live" ? "Running" : "Done");
    const outcome = report?.outcome ?? v.outcome ?? node?.outcome ?? null;
    visits.push({
      index: i,
      node: v.node,
      label: g.labelOf(v.node),
      kind: g.kindOf.get(v.node) ?? "agent",
      at: v.inferred ? null : v.startedAt ?? v.at,
      startedAt: v.startedAt,
      completedAt: v.completedAt,
      durationMs: v.startedAt != null && v.completedAt != null ? v.completedAt - v.startedAt : null,
      status: v.state,
      inferred: v.inferred,
      received: {
        from: prev?.node ?? null,
        fromLabel: prev?.label ?? null,
        summary: !prev ? `The cause: ${title}` : GENERIC_WORDS.has(prev.decided.words) ? `Handed on by ${prev.label}` : `${prev.label}: ${prev.decided.words}`,
        said: !!prev && !GENERIC_WORDS.has(prev.decided.words),
        sessionId,
        href: sessionId ? `/conversation/${sessionId}` : null,
      },
      decided: {
        outcome: outcome === "success" && !report?.outcome ? null : outcome,
        words,
        result: report?.result ?? scriptResult(node),
        to: next?.node ?? null,
        toLabel: next ? g.labelOf(next.node) : null,
        toWords: next ? g.words.get(`${v.node}->${next.node}`) ?? null : null,
      },
      why: report?.prose ?? null,
      sessionId,
    });
  });
  const read = { visits, reports };
  byRun.set(run, { task, decisionsSig, read });
  return read;
}

/** A step's words when it said nothing of its own. */
const GENERIC_WORDS = new Set(["Done", "Running", "Failed", "Waiting"]);

/** A script step's printed line in words, when it printed one. */
function scriptWords(node: ReportNode | undefined): string | null {
  const said = (node?.result_preview ?? node?.activity ?? "").trim();
  if (!said || said.startsWith("{")) return null;
  return said.split("\n")[0].slice(0, 240);
}

/** A script step's printed JSON result. */
function scriptResult(node: ReportNode | undefined): Record<string, unknown> | null {
  const said = node?.result_preview?.trim();
  if (!said?.startsWith("{")) return null;
  try {
    const v = JSON.parse(said);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** The current text's version for a step: the newest run's hash for it, and
 *  how far back the runs kept that hash (runs newest first). */
function versionOf(versions: ReadonlyArray<StepTextVersion>): StepVersion | null {
  const v = versions[0];
  return v ? { hash: v.hash, since: v.since, runs: v.runs, earlier: versions.length > 1 } : null;
}

/** Every text a step ran with, newest first: each unbroken stretch of runs
 *  (runs newest first) that read the same hash. A text put back later is a
 *  stretch of its own. */
function versionsOf(id: string, runs: ReadonlyArray<MapRun>): StepTextVersion[] {
  const out: StepTextVersion[] = [];
  for (const r of runs) {
    const h = r.graph_nodes?.find((n) => n.id === id)?.h;
    if (!h) continue;
    const cur = out[out.length - 1];
    if (cur && cur.hash === h) { cur.since = r.created_at; cur.runs++; }
    else out.push({ hash: h, since: r.created_at, until: r.created_at, runs: 1 });
  }
  return out;
}

/** The quotes a cause's reports hold: their blockquoted lines, newest report first. */
function quotesOf(signals: ReadonlyArray<MapSignal>, cap = 3): IssueQuote[] {
  const out: IssueQuote[] = [];
  const seen = new Set<string>();
  for (const s of [...signals].sort((a, b) => b.created_at - a.created_at)) {
    for (const text of signalQuotes(s.detail_md)) {
      if (seen.has(text)) continue;
      seen.add(text);
      out.push({ text, source: s.source, ref: s.short_id ?? null });
      if (out.length >= cap) return out;
    }
  }
  return out;
}

// ── the model ────────────────────────────────────────────────────────────────

/** The drawn graph for a source row, kept by the row's identity so a run's reading (runCache) survives a rebuild. */
const drawnCache = new WeakMap<object, LineGraph>();
function drawnGraph(src: LineGraphSource, isLine: boolean): LineGraph {
  const hit = drawnCache.get(src);
  if (hit) return hit;
  const g = (isLine ? { nodes: [...src.nodes], edges: [...src.edges] } : graphForMap(src.nodes, src.edges)) as LineGraph;
  drawnCache.set(src, g);
  return g;
}
const idsSourceCache = new Map<string, LineGraphSource>();
function sourceFromIds(ids: string[]): LineGraphSource {
  const key = ids.join(",");
  let src = idsSourceCache.get(key);
  if (!src) {
    src = graphFromIds(ids);
    if (idsSourceCache.size > 32) idsSourceCache.clear();
    idsSourceCache.set(key, src);
  }
  return src;
}

/**
 * One project's line as every view reads it. `rows` are the project's rows
 * (its runs of any graph, its causes and signals, its labels); `graphKey`
 * names the graph to draw (lineGraphs graphKeyOf), and an unknown key draws
 * the project's busiest.
 */
export function buildLineModel(rows: LineModelRows, graphKey: string): LineModel {
  const signals = rows.signals ?? [];
  const graphs = projectGraphs(rows.runs as ReadonlyArray<GraphRun>, signals as ReadonlyArray<{ task_id: string; source: string }>);
  const key = graphKey || graphs[0]?.key || CODECAST_LINE;
  const isLine = isCodecastLine(key);
  const runs = rows.runs.filter((r) => graphKeyOf(r as GraphRun) === key).sort((a, b) => b.created_at - a.created_at);
  const picked = graphs.find((g) => g.key === key) ?? null;

  const src: LineGraphSource = rows.graph?.nodes?.length ? rows.graph
    : isLine ? SHIPPED_LINE
    : sourceFromIds(picked?.nodeIds ?? runs.find((r) => r.graph_nodes?.length)?.graph_nodes?.map((n) => n.id) ?? []);
  const graph = drawnGraph(src, isLine);
  const ends = graph.ends ?? {};
  const srcNodes = src.nodes.filter((n) => !isStartOrExit(n));
  const srcById = new Map(srcNodes.map((n) => [n.id, n]));
  const loops = backEdgeSet(src.edges);

  const kindOf = new Map<string, StepKind>(srcNodes.map((n) => [n.id, ends[n.id] ? "end" : stationWho(n)]));
  const labelOf = (id: string) => {
    const n = srcById.get(id);
    return stepLabel({ id, label: n?.label ?? SHIPPED_LINE.nodes.find((x) => x.id === id)?.label ?? null });
  };
  const stageOf = (id: string): LinePhaseKey => {
    const drawn = graph.nodes.find((n) => n.id === id)?.phase;
    return drawn ?? phaseOfStation(id) ?? guessPhase(id, srcById.get(id)?.label ?? "");
  };
  const edgeList = src.edges.filter((e) => e.from !== "start" ? srcById.has(e.from) && srcById.has(e.to) : false);
  const words = new Map(src.edges.map((e) => [`${e.from}->${e.to}`, edgeWords(e)]));
  const g: GraphCtx = { graph, kindOf, labelOf, words };

  // ── every run, read once ──
  const taskById = new Map(rows.tasks.map((t) => [t._id, t]));
  const decisionsByRun = new Map<string, MapDecision[]>();
  for (const d of rows.decisions ?? []) {
    if (!d.workflow_run_id) continue;
    const list = decisionsByRun.get(d.workflow_run_id) ?? [];
    list.push(d);
    decisionsByRun.set(d.workflow_run_id, list);
  }
  const reads = runs.map((r) => ({ run: r, task: r.task_id ? taskById.get(r.task_id) : undefined, read: readRun(r, r.task_id ? taskById.get(r.task_id) : undefined, decisionsByRun.get(r._id) ?? [], g) }));

  // ── labels by decision ──
  const labelsBy = new Map<string, DecisionLabel[]>();
  let right = 0;
  let wrong = 0;
  const runIds = new Set(runs.map((r) => r._id));
  for (const l of rows.labels ?? []) {
    if (!runIds.has(l.run_id)) continue;
    const id = decisionId(l.run_id, l.node_id);
    const list = labelsBy.get(id) ?? [];
    list.push({ verdict: l.verdict, note: l.note?.trim() || null, by: l.by, byName: rows.names?.get(l.by) ?? null, at: l.at, mine: !!rows.viewerId && l.by === rows.viewerId });
    labelsBy.set(id, list);
    if (l.verdict === "right") right++;
    else wrong++;
  }
  for (const list of labelsBy.values()) list.sort((a, b) => b.at - a.at);

  // ── counts per node and edge ──
  const visitsAt = new Map<string, number>();
  const runsAt = new Map<string, Set<string>>();
  const durations = new Map<string, number[]>();
  const crossed = new Map<string, number>();
  for (const { run, read } of reads) {
    read.visits.forEach((v, i) => {
      visitsAt.set(v.node, (visitsAt.get(v.node) ?? 0) + 1);
      const set = runsAt.get(v.node) ?? new Set();
      set.add(run._id);
      runsAt.set(v.node, set);
      if (v.durationMs != null) durations.set(v.node, [...(durations.get(v.node) ?? []), v.durationMs]);
      // An edge counts the visits that recorded a decision, one per run per
      // step, so a step's ways out agree with its tally (StepTally): an earlier
      // loop round counts in the node's visits only, and a session cut off
      // before deciding counts under "cut off", never as the way the run went.
      const next = read.visits[i + 1];
      if (next && !v.inferred && decisionKey(v) !== "cut off") crossed.set(`${v.node}->${next.node}`, (crossed.get(`${v.node}->${next.node}`) ?? 0) + 1);
    });
    const first = read.visits[0];
    if (first) crossed.set(`start->${first.node}`, (crossed.get(`start->${first.node}`) ?? 0) + 1);
  }

  // ── the graph ──
  const cols = columnsOf(srcNodes.map((n) => n.id), src.edges, loops);
  const nodes: ModelNode[] = srcNodes.map((n) => {
    const stage = stageOf(n.id);
    return {
      id: n.id, label: labelOf(n.id), fileLabel: fileStepLabel(n.id, n.label), kind: kindOf.get(n.id)!, stage, half: halfOf(stage),
      col: cols.get(n.id) ?? 1, end: ends[n.id] ?? null,
      visits: visitsAt.get(n.id) ?? 0, runs: runsAt.get(n.id)?.size ?? 0, failed: 0, cutOff: 0, medianMs: median(durations.get(n.id) ?? []),
    };
  });
  const order = [...nodes].sort((a, b) => a.col - b.col || srcNodes.indexOf(srcById.get(a.id)!) - srcNodes.indexOf(srcById.get(b.id)!)).map((n) => n.id);
  // Out of a step, the hand-on runs took most (the first in the graph when
  // none did) is its flow; the rest are branches; an edge back is a loop.
  const flowOf = new Map<string, string>();
  for (const e of edgeList) {
    if (loops.has(`${e.from}->${e.to}`)) continue;
    const had = flowOf.get(e.from);
    if (!had || (crossed.get(`${e.from}->${e.to}`) ?? 0) > (crossed.get(had) ?? 0)) flowOf.set(e.from, `${e.from}->${e.to}`);
  }
  const edges: ModelEdge[] = edgeList.map((e) => {
    const id = `${e.from}->${e.to}`;
    const gate = kindOf.get(e.from) === "person" && !!e.label;
    const [, does] = gate ? e.label!.split("::") : [];
    return {
      id, from: e.from, to: e.to, words: words.get(id) ?? null, does: does?.trim() || null, condition: e.condition ?? null,
      kind: loops.has(id) ? "loop" : flowOf.get(e.from) === id ? "flow" : "branch", gate, count: crossed.get(id) ?? 0, back: 0,
    };
  });
  const stages: ModelStage[] = LINE_PHASES.map((p) => ({ key: p.key, label: p.label, half: halfOf(p.key), nodes: order.filter((id) => nodes.find((n) => n.id === id)!.stage === p.key) }))
    .filter((s) => s.nodes.length > 0);
  const halves = HALVES.map((h) => ({ ...h, stages: h.stages.filter((k) => stages.some((s) => s.key === k)) })).filter((h) => h.stages.length > 0);

  // ── the steps ──
  const steps: Record<string, LineStep> = {};
  for (const id of order) {
    const n = srcById.get(id)!;
    const node = nodes.find((x) => x.id === id)!;
    const text = typeof n.prompt === "string" ? n.prompt : typeof n.script === "string" ? n.script : null;
    const versions = text == null ? [] : versionsOf(id, runs);
    const prompt: StepPrompt | null = text == null ? null : {
      kind: typeof n.prompt === "string" ? "prompt" : "script",
      text,
      readable: readableTemplate(text, srcNodes),
      includes: includesOf(text, rows.shared),
      file: fileOf(id, src.source, isLine),
      version: versionOf(versions),
      versions,
    };
    steps[id] = {
      id, kind: node.kind, label: node.label, fileLabel: node.fileLabel,
      purpose: node.kind === "end" ? `Ends the run: ${ends[id]}.` : stationPurpose(n, src.edges, !isLine),
      stage: node.stage, half: node.half, prompt,
      outcomes: edges.filter((e) => e.from === id).map((e) => ({ key: e.id, words: e.words ?? "next", to: e.to, toLabel: labelOf(e.to), count: e.count, back: 0, kind: e.kind, does: e.does }))
        .sort((a, b) => b.count - a.count),
      answers: node.kind === "person" ? gateAnswers(id, src.edges) : [],
      decisions: [],
      tally: { total: 0, rows: [], failed: 0, cutOff: 0, live: 0 },
      model: typeof n.model === "string" ? n.model : null,
      maxVisits: typeof n.max_visits === "number" ? n.max_visits : null,
      timeoutS: typeof n.timeout === "number" ? n.timeout : null,
    };
  }

  // ── each step's decisions, and the runs as paths ──
  const runModels: LineRunModel[] = [];
  for (const { run, task, read } of reads) {
    const caseTitle = task?.title ?? run.task_title ?? "A run";
    const caseRef = task?.short_id ?? run.task_short_id ?? null;
    for (const v of read.visits) {
      const step = steps[v.node];
      if (!step || v.inferred) continue;
      const id = decisionId(run._id, v.node);
      const labels = labelsBy.get(id) ?? [];
      const note = step.kind === "person" ? gateNote(run, v.node, decisionsByRun.get(run._id) ?? []) : null;
      step.decisions.push({
        id, runId: run._id, caseId: run.task_id ?? null, caseRef, caseTitle, at: v.at, durationMs: v.durationMs, status: v.status,
        received: v.received, decided: v.decided, reasoning: note ?? v.why,
        label: labels.find((l) => l.mine) ?? labels[0] ?? null, labels,
      });
    }
    const last = [...read.visits].reverse().find((v) => !v.inferred) ?? null;
    runModels.push({
      id: run._id, caseId: run.task_id ?? null, caseRef, caseTitle, status: run.status, live: isLiveRun(run),
      outcome: runOutcome(run as ReportRun, task as ReportTask | undefined, rows.now ?? Date.now(), true),
      at: run.created_at, updatedAt: run.updated_at,
      durationMs: isLiveRun(run) ? null : Math.max(0, run.updated_at - run.created_at),
      at_node: run.current_node_id && run.current_node_id !== "exit" && steps[run.current_node_id] ? run.current_node_id : last?.node ?? null,
      graphHash: run.graph_hash ?? null,
      visits: read.visits,
    });
  }
  // ── the issues: the causes these runs worked, and the causes no run has taken ──
  const now = rows.now ?? Date.now();
  const runsByTask = new Map<string, LineRunModel[]>();
  for (const r of runModels) if (r.caseId) runsByTask.set(r.caseId, [...(runsByTask.get(r.caseId) ?? []), r]);
  const anyRunByTask = new Map<string, MapRun[]>();
  for (const r of rows.runs) if (r.task_id) anyRunByTask.set(r.task_id, [...(anyRunByTask.get(r.task_id) ?? []), r]);
  const signalsByTask = new Map<string, MapSignal[]>();
  for (const s of signals) if (s.task_id) signalsByTask.set(s.task_id, [...(signalsByTask.get(s.task_id) ?? []), s]);
  const occurrencesByTask = new Map((rows.occurrences ?? []).map((o) => [o.task_id, o]));
  const readById = new Map(reads.map((r) => [r.run._id, r.read]));
  const said = (runId: string) => saidOf(readById.get(runId)?.visits ?? [], steps);
  const causeIds = [...runsByTask.keys(), ...rows.tasks.filter((t) => t.cause && !anyRunByTask.has(t._id)).map((t) => t._id)];
  const issues: LineIssue[] = [];
  for (const taskId of causeIds) {
    const task = taskById.get(taskId);
    const taskRuns = runsByTask.get(taskId) ?? [];
    const own = signalsByTask.get(taskId) ?? [];
    const newest = taskRuns[0] ? runs.find((r) => r._id === taskRuns[0].id) ?? null : null;
    const reopened = own.some((s) => s.reopened);
    const allRuns = (anyRunByTask.get(taskId) ?? []).slice().sort((a, b) => b.created_at - a.created_at);
    issues.push({
      id: taskId, ref: task?.short_id ?? taskRuns[0]?.caseRef ?? null, title: task?.title ?? taskRuns[0]?.caseTitle ?? "A cause", status: task?.status ?? "open",
      findings: task?.cause?.signal_count ?? own.length, quotes: quotesOf(own), runs: taskRuns.map((r) => r.id), lastRunAt: taskRuns[0]?.at ?? 0,
      where: task ? causeWhere(task as ReportTask, newest as ReportRun | null, reopened, now) : taskRuns[0].outcome,
      history: causeHistory({
        task, runs: allRuns, decisions: (rows.decisions ?? []).filter((d) => d.task_id === taskId || (!!d.workflow_run_id && allRuns.some((r) => r._id === d.workflow_run_id))),
        signals: own, occurrences: occurrencesByTask.get(taskId), deploys: rows.deploys, said, watchDays: rows.watchDays ?? null, now,
      }),
    });
  }
  issues.sort((a, b) => b.history.lastActivity - a.history.lastActivity);

  // ── each decision that closed a problem, and whether the close held; then each step's tally ──
  const closes = closesByDecision(issues);
  const edgeById = new Map(edges.map((e) => [e.id, e]));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  for (const s of Object.values(steps)) {
    s.decisions.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    for (const d of s.decisions) {
      d.closed = closes.get(d.id) ?? null;
      const e = d.closed && !d.closed.held && d.decided.to ? edgeById.get(`${s.id}->${d.decided.to}`) : undefined;
      if (e) e.back++;
    }
    s.tally = tallyDecisions(s.decisions);
    for (const o of s.outcomes) o.back = edgeById.get(o.key)?.back ?? 0;
    const node = nodeById.get(s.id);
    if (node) { node.failed = s.tally.failed; node.cutOff = s.tally.cutOff; }
  }

  return {
    graphKey: key,
    title: graphTitle(key, rows.graph?.name ?? runs[0]?.workflow_name),
    graphs,
    graph: { nodes, edges, stages, halves },
    steps,
    order,
    runs: runModels,
    issues,
    labels: { right, wrong },
  };
}

/** Every close in the problems' histories, by the decision that made it
 *  (the run, at the step it closed at): whether what it closed came back. A
 *  close that did not hold reads as wrong on every surface that shows the
 *  decision, never as the green of a good end. */
function closesByDecision(issues: ReadonlyArray<LineIssue>): Map<string, DecisionClose> {
  const out = new Map<string, DecisionClose>();
  for (const { history: h } of issues) {
    for (const c of h.closes) {
      if (!c.step) continue;
      out.set(decisionId(c.runId, c.step), c.back ? { held: false, count: c.back.count, words: c.back.words } : { held: true, count: 0, words: null });
    }
  }
  return out;
}

/** What a run's stations found, proposed and built, in their own words: the
 *  newest visit of each kind that said something of its own. Finding is the
 *  diagnose half; proposing is a plan or proposal step; building is the build stage. */
function saidOf(visits: ReadonlyArray<LineVisit>, steps: Record<string, LineStep>): { found: string | null; proposed: string | null; built: string | null } {
  let found: string | null = null;
  let proposed: string | null = null;
  let built: string | null = null;
  for (const v of visits) {
    if (v.inferred || v.status !== "done") continue;
    const step = steps[v.node];
    if (!step || step.kind === "script" || step.kind === "end") continue;
    const words = decisionSaid({ reasoning: v.why, decided: v.decided });
    if (GENERIC_WORDS.has(words)) continue;
    const slot = saidSlot(v.node, step.half === "diagnose" ? "diagnose" : step.stage === "build" ? "build" : null);
    if (slot === "proposed") proposed = words;
    else if (slot === "found") found = words;
    else if (slot === "built") built = words;
  }
  return { found, proposed, built };
}

/** A person's note with their answer at a gate, when the decision kept one. */
function gateNote(run: MapRun, gate: string, decisions: ReadonlyArray<MapDecision>): string | null {
  const d = [...decisions].reverse().find((x) => x.gate_node_id === gate && x.status === "answered");
  const text = d?.answer_text?.trim();
  if (text && d && (d.answer_index == null || text !== d.options?.[d.answer_index]?.label)) return text;
  return gate === CARD_GATE_NODE_ID && run.gate_node_id === gate && run.gate_response && !/^[A-Z]$/.test(run.gate_response.trim()) ? run.gate_response.trim() : null;
}
