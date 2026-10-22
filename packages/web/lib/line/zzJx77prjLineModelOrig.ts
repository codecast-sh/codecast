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
import { causeAsks, causeName, type LineCauseTask } from "../lineFlow";
import {
  CODECAST_LINE, backEdgeSet, fileStepLabel, gateAnswers, graphForMap, graphFromIds, graphKeyOf, graphTitle, guessPhase, isCodecastLine,
  processIndex, projectGraphs, readableTemplate, stationPurpose, stationWho, stepLabel,
  type GraphEdgeIn, type GraphEnd, type GraphNodeIn, type GraphRun, type ProjectGraph,
} from "./lineGraphs";
import { runVisits, type LineGraph, type MapDecision, type MapRun, type MapSignal, type RunVisit } from "./lineMap";
import { EARLIER_ROUND_WORDS, plainWords } from "./lineTrace";
import {
  INTERRUPTED_WORDS, LINE_PHASES, causeWhere, choiceWords, newestClose, isLiveRun, phaseOfStation, plainStepWords, runOutcome, runPath, stationCatalogWords, stationReport,
  type LinePhaseKey, type ReportNode, type ReportRun, type ReportStep, type ReportTask, type RunOutcome, type StepState,
} from "./runReport";
import { SHIPPED_LINE } from "./shippedLine.generated";
import { causeHistory, type CauseHistory, type DeployRow, type HandMerge, type HistoryClose, type OccurrenceRow } from "./causeHistory";
import { attemptVerdict, cameBackCount, type MarkTone } from "./timeline";
import { backTimes, reportArgument, unshippedGuard, reportFieldWords, saidSlot, signalQuotes, type CloseArgument, type CloseKind, type RunSaid } from "@codecast/shared/contracts/causeHistory";
import { halfOfPhase } from "@codecast/shared/contracts/linePhases";
import type { LabelVerdict } from "./lineLabels";
import { isEmptyFinding, repeatedFindings } from "./findingEvidence";
import { faultsNaming, stepFaults, type LineFault } from "./lineFaults";
import { decisionOutcome, gateCard, type DecisionOutcome } from "./decisionOutcome";

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
  /** Fix branches merged through their pull request by hand, by task id (problemPage fixMerges): each history reads it as its merge. */
  handMerges?: ReadonlyMap<string, HandMerge>;
  /** Why a problem's own project starts nothing on its own, as a state word (lineFlow autoStartWord); null when it does. */
  holdOf?: (projectId: string | null) => string | null;
  /** What each problem waits on the viewer for, by task id: its Inbox group (lineInbox). A problem in the Inbox is "waiting on you", one definition everywhere. */
  forYou?: ReadonlyMap<string, string>;
  /** Runs a trial started: an answer at their gates is recorded and ships nothing. */
  trialRuns?: ReadonlySet<string>;
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
  /** An edge whose condition joins outcomes ("red or infeasible"): how many runs took it for each, when more than one did. */
  split?: Array<{ words: string; n: number }>;
  /** Runs that took it with evals their eval scope selected and no step ran (scriptReport evalsOwed). */
  owed?: number;
};

export type ModelStage = { key: LinePhaseKey; label: string; half: LineHalf; nodes: string[] };
export type ModelHalf = { key: LineHalf; label: string; stages: LinePhaseKey[] };
export type LineGraphModel = { nodes: ModelNode[]; edges: ModelEdge[]; stages: ModelStage[]; halves: ModelHalf[] };

/** A shared section a prompt pulls in ("$shared.json.rulings"). `text` is null when the caller has not read it. */
export type PromptInclude = { name: string; from: string; text: string | null };
/** The run of recent runs that ran this step's current text: its hash, since when, how many runs. */
export type StepVersion = { hash: string; since: number; runs: number; earlier: boolean };
/** One text a step ran with: its hash, its first and newest run, how many runs read it. */
/** `runIds`: the runs that read this text, so what it decided can be told apart from the text before it. */
export type StepTextVersion = { hash: string; since: number; until: number; runs: number; runIds: string[] };
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
  /** It was left waiting or running and a newer run on its problem took over: nothing waits on it any more. */
  superseded?: boolean;
  /** At a person's step: how the decision asked there stands (decisionOutcome), the one reading every surface shares. */
  answer?: DecisionOutcome | null;
};

/** A close a decision made and whether it held: `count` occurrences came back after it ("Came back 3x after attempt 2 dissolved it"), `total` after any close on its case (the Timeline's one count). */
export type DecisionClose = { kind: CloseKind; held: boolean; count: number; total: number; words: string | null;
  /** A close that handed the problem to another cause whose fix has not gone live (HistoryClose.fold): "folded into C1, whose fix has not shipped".
   *  It has not held or failed yet, so it counts as neither. */
  folded?: string | null;
  /** The cause it folded into ("C1"), beside `folded`. */
  foldInto?: string | null };

/** A close that did not hold, in words: "came back 7x after this run, 9x in all", or "came back 9x after this run" when the two counts agree. */
export const closeBackWords = (c: Pick<DecisionClose, "count" | "total">) =>
  `came back ${backTimes(c.count)} after this run${c.total > c.count ? `, ${backTimes(c.total)} in all` : ""}`;

/** A decision that closed its problem without a change while its finding names a guard (an eval, a test): nothing shipped that guard, so every surface showing the finding says so beside it. */
export const findingNeverShipped = (d: { closed?: DecisionClose | null }, said: string | null | undefined) => unshippedGuard(d.closed?.kind, said);

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
  /** It never ended (left waiting or running) and a newer run on its problem took over. */
  superseded?: boolean;
  /** A run that built a fix: its one outcome (timeline attemptVerdict), "deployed", "merged, not deployed", "merged". Every surface says this, never the stop of a later step. */
  verdict?: { word: string; tone: MarkTone } | null;
};

export type IssueQuote = { text: string; source: string; ref: string | null };
export type LineIssue = {
  id: string;
  ref: string | null;
  title: string;
  /** Its name in a list when the title is too long to list (lineRetitle's cause.named, written for this title); else null. */
  name?: string | null;
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
  /** The question grounding asked a person about it, while it holds on the answer (lineFlow causeAsks); else null. */
  ask: string | null;
  /** Why it was dissolved, in the dissolver's words, while it stays dissolved; else null. */
  dissolvedWhy: string | null;
  /** When the fix a dissolve named went live, when it named one: a finding after it reopens the problem. */
  dissolvedFixedAt: number | null;
  /** Its Inbox group when it waits on the viewer (lineInbox InboxKind), else null; undefined when the caller fed no Inbox. */
  forYou?: string | null;
  /** The line's own runs that failed on the machine fault this problem is about (lineFaults faultsNaming), newest first. */
  lineFaults?: LineFault[];
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
export function decisionKey(d: { status: StepState; decided: { outcome: string | null; toWords?: string | null }; superseded?: boolean }): string {
  const own = d.decided.outcome;
  if (d.superseded) return "superseded";
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
  /** How many times the case came back in all (DecisionClose total), when any earlier close did not hold. */
  earlierBackTotal: number;
};

/** Decisions (newest first) grouped by case, each case where its newest run
 *  falls: a case run five times reads as one case with four earlier runs. A
 *  decision without a case stands alone. */
export function decisionsByCase(decisions: ReadonlyArray<StepDecision>): CaseDecisions[] {
  const by = new Map<string, CaseDecisions>();
  for (const d of decisions) {
    const key = d.caseId ?? `run:${d.runId}`;
    const had = by.get(key);
    if (had) {
      had.earlier.push(d);
      if (d.closed && !d.closed.held) { had.earlierBack++; had.earlierBackTotal = Math.max(had.earlierBackTotal, d.closed.total); }
    } else by.set(key, { key, latest: d, earlier: [], earlierBack: 0, earlierBackTotal: 0 });
  }
  return [...by.values()];
}

/** Each run whose close the problem came back after, with what came back: the same closes a decision's `closed` reads, by run. */
export function cameBackByRun(issues: ReadonlyArray<Pick<LineIssue, "history">>): Map<string, DecisionClose> {
  const out = new Map<string, DecisionClose>();
  for (const { history: h } of issues) {
    const total = cameBackCount(h);
    for (const c of h.closes) if (c.back) out.set(c.runId, closeOf(c, total));
  }
  return out;
}

/** A record's own id after the noun it names ("cluster c2cb5312", "run 3f9a1c0e"): the noun reads alone, the id is
 *  noise to a person. A commit keeps its hash, since that is how a person finds it. */
const RECORD_ID = /\b(cluster|group|signal|finding|run|session|issue)\s+(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{6,40}\b/gi;
export const withoutRecordIds = (text: string) => text.replace(RECORD_ID, "$1");

/** What a run actually found at a step, in its own words: the first line of
 *  its reasoning when it gave one (the outcome's tag already says the generic
 *  "Found why it happens"), else the finding its report put in words
 *  (`statement`, `evidence`), else what it decided. The history's "Found" reads
 *  the same words, so the next attempt is handed the argument, not the label. */
export function decisionSaid(d: { reasoning: string | null; decided: Pick<LineVisit["decided"], "words" | "result"> }): string {
  const raw = (d.reasoning ?? "").split("\n").map((l) => plainWords(l.replace(/^\s*(?:#+|[-*>]|\d+\.)\s*/, "")).trim()).find((l) => l.length > 12)
    ?? reportFieldWords(d.decided.result)?.replace(/\s+/g, " ");
  const line = raw ? withoutRecordIds(raw) : raw;
  if (!line) return d.decided.words;
  return sentencesWithin(line, 240);
}

/** A station's line cut only at a sentence end: its first sentence whole however long, then each next one that fits. A
 *  cut inside a sentence ends on half a figure or a branch name ("turns the check 20/…"). */
export function sentencesWithin(line: string, cap: number): string {
  if (line.length <= cap) return line;
  let end = 0;
  for (const m of line.matchAll(/[.!?]["')\]]?(?=\s+\S)/g)) {
    const at = m.index! + m[0].length;
    if (end && at > cap) break;
    end = at;
  }
  return end ? line.slice(0, end) : line;
}

/** The row a decision counts under in a tally and filters by: its key, a session cut off before deciding counted with
 *  the failures, since both read "failed" (outcomeWords) and two chips of one word cannot be told apart. */
export const tallyKey = (d: Parameters<typeof decisionKey>[0]): string => {
  const k = decisionKey(d);
  return k === "cut off" ? "failed" : k;
};

/** A step's ways out, two that read the same (the same words to an end of the same name, "→ Failed") as one, counts summed. */
function mergeOutcomes(list: StepOutcome[]): StepOutcome[] {
  const out: StepOutcome[] = [];
  for (const o of list) {
    const had = out.find((x) => x.words === o.words && x.toLabel === o.toLabel && x.kind === o.kind);
    if (had) { had.count += o.count; had.back += o.back; }
    else out.push({ ...o });
  }
  return out;
}

/** Decisions counted by key, the most first; each row names where most of them sent the run. */
export function tallyDecisions(decisions: ReadonlyArray<Pick<StepDecision, "status" | "decided" | "closed">>): StepTally {
  const rows = new Map<string, StepTallyRow & { tos: Map<string, number> }>();
  let live = 0;
  let cutOff = 0;
  for (const d of decisions) {
    if (decisionKey(d) === "cut off") cutOff++;
    const key = tallyKey(d);
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
  return { total: decisions.length, rows: list, failed: (rows.get("failed")?.n ?? 0) - cutOff, cutOff, live };
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
  // A handoff reads as what it means for the reader: the work is done, or it needs a person.
  if (lhs === "handoff") return not ? null : value === "done" ? "done" : value === "needs_context" || value === "blocked" ? "needs you" : `handed off ${humanize(value)}`;
  if (lhs === "category") return not ? null : value === "line" ? "about the line itself" : `a ${humanize(value)} problem`;
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

/** Which way of an "or" condition a run took, in words: "red" for "red.json.red = true or prove.json.outcome = infeasible"
 *  when the run's red step printed red: true. `valueOf` reads a condition's left side on the run (undefined when the run
 *  kept nothing to tell by). Undefined when the edge has no "or", or no way of it can be told. */
export function takenWords(e: Pick<GraphEdgeIn, "label" | "condition"> | undefined, valueOf: (lhs: string) => unknown): string | null | undefined {
  if (!e || e.label || !e.condition) return undefined;
  const alts = e.condition.split(/\s+or\s+/i);
  if (alts.length < 2) return undefined;
  for (const alt of alts) {
    const clauses = alt.split(/\s+and\s+/i);
    let known = false;
    let holds = true;
    for (const c of clauses) {
      const m = c.trim().replace(/^\(|\)$/g, "").match(/^([\w.]+)\s*(!=|=)\s*(.+)$/);
      if (!m) continue;
      const have = valueOf(m[1]);
      if (have === undefined) continue;
      known = true;
      const same = String(have) === m[3].trim().replace(/^["']|["']$/g, "");
      if (same === (m[2] === "!=")) { holds = false; break; }
    }
    if (holds && known) return [...new Set(clauses.map(clauseWords).filter((w): w is string => !!w))].join(" and ") || null;
  }
  return undefined;
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
type GraphCtx = { graph: LineGraph; kindOf: Map<string, StepKind>; labelOf: (id: string) => string; words: Map<string, string | null>; edgeOf: Map<string, GraphEdgeIn> };

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
  const title = task?.title ?? run.task_title ?? "The problem";
  // A condition's left side on this run: a step's outcome, or a field of the JSON a step put out.
  const jsonOfNode = (id: string): Record<string, unknown> | null => {
    const n = nodes.get(id);
    return n ? stationReport(n.session as ReportNode["session"])?.result ?? scriptResult(n) : null;
  };
  const valueAt = (self: string) => (lhs: string): unknown => {
    if (lhs === "outcome") return nodes.get(self)?.outcome;
    const [id, kind, ...path] = lhs.split(".");
    if (kind !== "json" || !path.length) return undefined;
    let at: unknown = jsonOfNode(id);
    if (at == null) return undefined;
    for (const k of path) at = at != null && typeof at === "object" ? (at as Record<string, unknown>)[k] : undefined;
    return at ?? null;
  };
  const visits: LineVisit[] = [];
  raw.forEach((v: RunVisit, i) => {
    const node = v.inferred ? undefined : nodes.get(v.node);
    const report = node ? stationReport(node.session as ReportNode["session"]) : null;
    const step = v.inferred ? undefined : reports.get(v.node);
    const next = raw[i + 1];
    const prev = visits[i - 1];
    const sessionId = node?.session?._id ? String(node.session._id) : null;
    // A failed script's own printed line outranks the station's catalog words ("Evals failed"): it says why.
    const printed = !v.inferred && v.state === "failed" && stationCatalogWords(v.node, step?.result) ? scriptWords(node, true) : null;
    const words = v.inferred ? EARLIER_ROUND_WORDS
      : printed ?? step?.result ?? report?.line ?? scriptWords(node) ?? (v.state === "failed" ? "Failed" : v.state === "live" ? "Running" : "Done");
    // A step the run ended under never finished: it failed there, whatever its node kept from an earlier round.
    const cut = !v.inferred && step?.result === INTERRUPTED_WORDS;
    const outcome = cut ? null : report?.outcome ?? v.outcome ?? node?.outcome ?? null;
    visits.push({
      index: i,
      node: v.node,
      label: g.labelOf(v.node),
      kind: g.kindOf.get(v.node) ?? "agent",
      at: v.inferred ? null : v.startedAt ?? v.at,
      startedAt: v.startedAt,
      completedAt: v.completedAt,
      durationMs: v.startedAt != null && v.completedAt != null ? v.completedAt - v.startedAt : null,
      status: cut ? "failed" : v.state,
      inferred: v.inferred,
      received: {
        from: prev?.node ?? null,
        fromLabel: prev?.label ?? null,
        summary: !prev ? `The problem: ${title}` : GENERIC_WORDS.has(prev.decided.words) ? `Handed on by ${prev.label}` : `${prev.label}: ${prev.decided.words}`,
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
        toWords: next ? (() => {
          const id = `${v.node}->${next.node}`;
          const taken = v.inferred ? undefined : takenWords(g.edgeOf.get(id), valueAt(v.node));
          return taken !== undefined ? taken : g.words.get(id) ?? null;
        })() : null,
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
function scriptWords(node: ReportNode | undefined, failed = false): string | null {
  const said = (node?.result_preview ?? node?.activity ?? "").trim();
  if (!said || said.startsWith("{")) return null;
  const lines = said.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!failed) return lines[0].slice(0, 240);
  // A failure: its first line and the error it printed, with each path cut to its file ("wrote no reps.json").
  const err = lines.slice(1).find((l) => /^\w*(?:Error|Exception)\b|^error:/i.test(l));
  return shortPaths(err ? `${lines[0]}: ${err}` : lines[0]).slice(0, 240);
}

/** Absolute paths in a printed line as their last part: a path says nothing at a glance. */
const shortPaths = (text: string) => text.replace(/(?:~|(?:\/[\w.@+-]+){2,})\/([\w.@+-]+)/g, "$1");

/** A script step's printed JSON result. */
function scriptResult(node: ReportNode | undefined): Record<string, unknown> | null {
  const said = node?.result_preview?.trim();
  if (!said?.startsWith("{")) return null;
  // Whole JSON, else its first line (a script that prints its result, then its log).
  for (const body of [said, said.split("\n")[0]]) {
    try {
      const v = JSON.parse(body);
      return v && typeof v === "object" && !Array.isArray(v) ? v : null;
    } catch { /* not whole */ }
  }
  return null;
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
    if (cur && cur.hash === h) { cur.since = r.created_at; cur.runs++; cur.runIds.push(r._id); }
    else out.push({ hash: h, since: r.created_at, until: r.created_at, runs: 1, runIds: [r._id] });
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
  const g: GraphCtx = { graph, kindOf, labelOf, words, edgeOf: new Map(src.edges.map((e) => [`${e.from}->${e.to}`, e])) };

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
  // Per edge, how many runs took it for each way of its condition; per step, the runs it sent to a step the drawn graph has no edge to.
  const crossedWords = new Map<string, Map<string, number>>();
  const drawnEdges = new Set(edgeList.map((e) => `${e.from}->${e.to}`));
  const elsewhere = new Map<string, Map<string, number>>();
  const owedOn = new Map<string, number>();
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
      if (next && !v.inferred && decisionKey(v) !== "cut off") {
        const id = `${v.node}->${next.node}`;
        crossed.set(id, (crossed.get(id) ?? 0) + 1);
        if (v.decided.toWords) {
          const by = crossedWords.get(id) ?? new Map<string, number>();
          by.set(v.decided.toWords, (by.get(v.decided.toWords) ?? 0) + 1);
          crossedWords.set(id, by);
        }
        // An eval scope that selected evals, handing on to a step that is not an eval: the evals are owed.
        const r = v.decided.result;
        if (r && r.scoped === true && typeof r.select === "string" && !/(^|_)evals?($|_)/.test(next.node)) owedOn.set(id, (owedOn.get(id) ?? 0) + 1);
        if (!drawnEdges.has(id) && srcById.has(v.node)) {
          // Keyed by what it decided and where it went, so the stub reads "mechanism → Record the problem", never "other route".
          const by = elsewhere.get(v.node) ?? new Map<string, number>();
          const k = `${v.decided.toWords ?? (v.decided.outcome && !/^(success|failure)$/.test(v.decided.outcome) ? v.decided.outcome.replace(/_/g, " ") : "next")}\u0000${next.node}\u0000${next.label}`;
          by.set(k, (by.get(k) ?? 0) + 1);
          elsewhere.set(v.node, by);
        }
      }
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
  // An "or" edge reads by the ways runs took it: one way, its own words ("red"); several, each with its count.
  const takenSplit = (id: string): Partial<Pick<ModelEdge, "words" | "split">> => {
    const by = crossedWords.get(id);
    if (!by?.size || !/\bor\b/.test(words.get(id) ?? "")) return {};
    const list = [...by].map(([w, n]) => ({ words: w, n })).sort((a, b) => b.n - a.n);
    return list.length === 1 ? { words: list[0].words } : { words: list.map((x) => `${x.words} ${x.n}`).join(" · "), split: list };
  };
  const edges: ModelEdge[] = edgeList.map((e) => {
    const id = `${e.from}->${e.to}`;
    const gate = kindOf.get(e.from) === "person" && !!e.label;
    const [, does] = gate ? e.label!.split("::") : [];
    return {
      id, from: e.from, to: e.to, does: does?.trim() || null, condition: e.condition ?? null,
      kind: loops.has(id) ? "loop" : flowOf.get(e.from) === id ? "flow" : "branch", gate, count: crossed.get(id) ?? 0, back: 0,
      ...{ words: words.get(id) ?? null, ...takenSplit(id) },
      ...(owedOn.get(id) ? { owed: owedOn.get(id) } : {}),
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
      outcomes: [
        ...mergeOutcomes(edges.filter((e) => e.from === id).map((e) => ({ key: e.id, words: e.words ?? "next", to: e.to, toLabel: labelOf(e.to), count: e.count, back: 0, kind: e.kind, does: e.does }))),
        // Runs this step sent where the drawn graph has no edge (an earlier version's route): one way out each, named by what
        // it decided and where it went, so the step's ways out sum to its decisions.
        ...[...(elsewhere.get(id) ?? [])].map(([k, count]) => {
          const [words, to, toLabel] = k.split("\u0000");
          return { key: `${id}->*${to}`, words, to, toLabel, count, back: 0, kind: "branch" as EdgeKind, does: "A route the graph no longer draws" };
        }),
      ].sort((a, b) => b.count - a.count),
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
        received: v.received, decided: step.kind === "person" ? gateDecided(v.decided) : v.decided, reasoning: note ?? v.why,
        label: labels.find((l) => l.mine) ?? labels[0] ?? null, labels,
        ...(step.kind === "person" ? { answer: decisionOutcome(gateCard(decisionsByRun.get(run._id) ?? [], run._id, v.node), run, { gate: v.node, trial: rows.trialRuns?.has(run._id) }) } : {}),
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
  // A run left waiting or running whose problem a newer run took up is superseded: its waits are over, on every surface.
  const newestAt = new Map<string, number>();
  for (const r of runModels) if (r.caseId && r.at > (newestAt.get(r.caseId) ?? -Infinity)) newestAt.set(r.caseId, r.at);
  const supersededIds = new Set<string>();
  for (const r of runModels) {
    if (!r.caseId || r.at >= newestAt.get(r.caseId)! || r.live) continue;
    if (r.outcome.tone === "waiting" || r.outcome.tone === "live") { r.superseded = true; supersededIds.add(r.id); }
  }
  for (const st of Object.values(steps)) for (const d of st.decisions) if (supersededIds.has(d.runId) && (d.status === "waiting" || d.status === "live")) d.superseded = true;

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
  // A close that folded its problem into a codecast cause ("ct-4681") counts what comes after once that cause was resolved; a cause named only in the product's own words ("C1") reads as not shipped.
  const taskByRef = new Map(rows.tasks.flatMap((t) => (t.short_id ? [[t.short_id, t] as const] : [])));
  const foldFixAt = (into: string) => { const t = taskByRef.get(into); return t && /^(done|closed)$/.test(t.status) ? t.resolved_at ?? null : null; };
  // A problem no run has taken yet waits under the process its project runs (processIndex), never under every one.
  const process = processIndex(rows.runs as ReadonlyArray<GraphRun>, (id) => (taskById.get(id) as { project_id?: string | null } | undefined)?.project_id);
  const causeIds = [...runsByTask.keys(), ...rows.tasks.filter((t) => t.cause && !anyRunByTask.has(t._id) && process.task(t._id) === key).map((t) => t._id)];
  const issues: LineIssue[] = [];
  // The line's own machine faults: a problem that names the same identifier is happening again each time one fails.
  const faults = stepFaults(steps);
  for (const taskId of causeIds) {
    const task = taskById.get(taskId);
    const taskRuns = runsByTask.get(taskId) ?? [];
    // A finding filed twice word for word is one occurrence, and one that says nothing is none: both stay out of the
    // series, the counts and the trend.
    const filed = signalsByTask.get(taskId) ?? [];
    const repeats = repeatedFindings(filed);
    const empty = filed.filter(isEmptyFinding);
    const out = new Set([...repeats, ...empty]);
    const own = out.size ? filed.filter((x) => !out.has(x)) : filed;
    const occ = occurrencesByTask.get(taskId);
    const occurrences = occ && out.size ? withoutTimes(occ, [...out].map((x) => x.observed_at ?? x.created_at)) : occ;
    const newest = taskRuns[0] ? runs.find((r) => r._id === taskRuns[0].id) ?? null : null;
    const reopened = own.some((s) => s.reopened);
    const allRuns = (anyRunByTask.get(taskId) ?? []).slice().sort((a, b) => b.created_at - a.created_at);
    issues.push({
      id: taskId, ref: task?.short_id ?? taskRuns[0]?.caseRef ?? null, title: task?.title ?? taskRuns[0]?.caseTitle ?? "A problem", status: task?.status ?? "open",
      name: causeName(task),
      findings: task?.cause?.signal_count != null ? Math.max(0, task.cause.signal_count - empty.length) : own.length, quotes: quotesOf(own), runs: taskRuns.map((r) => r.id), lastRunAt: taskRuns[0]?.at ?? 0,
      where: task ? causeWhere(task as ReportTask, newest as ReportRun | null, reopened, now, rows.holdOf?.((task as { project_id?: string | null }).project_id ?? null) ?? null, newestClose(allRuns as unknown as ReportRun[], task.cause?.last_seen)) : taskRuns[0].outcome,
      ask: task && causeAsks(task) ? task.readiness_note?.trim() || "Is this a real problem?" : null,
      dissolvedWhy: task?.cause?.dissolved?.note?.trim() || null,
      dissolvedFixedAt: task?.cause?.dissolved?.fixed_at ?? null,
      ...(rows.forYou ? { forYou: rows.forYou.get(taskId) ?? null } : {}),
      lineFaults: faultsNaming(`${task?.title ?? ""}\n${(task as { description?: string | null } | undefined)?.description ?? ""}`, faults),
      history: causeHistory({
        task, runs: allRuns, decisions: (rows.decisions ?? []).filter((d) => d.task_id === taskId || (!!d.workflow_run_id && allRuns.some((r) => r._id === d.workflow_run_id))),
        signals: own, occurrences, deploys: rows.deploys, said, foldFixAt, handMerge: rows.handMerges?.get(taskId) ?? null, watchDays: rows.watchDays ?? null, now,
      }),
    });
  }
  issues.sort((a, b) => b.history.lastActivity - a.history.lastActivity);
  // A run that built a fix reads by its fix, the same words its problem's history says.
  const attemptOf = new Map(issues.flatMap((i) => i.history.attempts.map((a) => [a.runId, { a, h: i.history }] as const)));
  for (const r of runModels) {
    const x = attemptOf.get(r.id);
    if (x && !r.live && (x.a.ended === "shipped" || x.a.merge)) r.verdict = attemptVerdict(x.a, x.h);
  }

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

/** One close as a decision reads it: came back (`back`), folded into a cause whose fix is pending, or held. */
function closeOf(c: HistoryClose, total: number): DecisionClose {
  if (c.back) return { kind: c.kind, held: false, count: c.back.count, total: Math.max(total, c.back.count), words: c.back.words, folded: null, foldInto: null };
  const pending = c.fold && c.fold.liveAt == null ? c.fold : null;
  return { kind: c.kind, held: true, count: 0, total, words: null, folded: pending?.words ?? null, foldInto: pending?.into ?? null };
}

/** Every close in the problems' histories, by the decision that made it
 *  (the run, at the step it closed at): whether what it closed came back. A
 *  close that did not hold reads as wrong on every surface that shows the
 *  decision, never as the green of a good end. */
function closesByDecision(issues: ReadonlyArray<LineIssue>): Map<string, DecisionClose> {
  const out = new Map<string, DecisionClose>();
  for (const { history: h } of issues) {
    const total = cameBackCount(h);
    for (const c of h.closes) {
      if (!c.step) continue;
      out.set(decisionId(c.runId, c.step), closeOf(c, total));
    }
  }
  return out;
}

/** What a run's stations found, proposed and built, in their own words: the
 *  newest visit of each kind that said something of its own. Finding is the
 *  diagnose half; proposing is a plan or proposal step; building is the build stage. */
function saidOf(visits: ReadonlyArray<LineVisit>, steps: Record<string, LineStep>): RunSaid {
  let argued: CloseArgument | null = null;
  let found: string | null = null;
  let proposed: string | null = null;
  let built: string | null = null;
  for (const v of visits) {
    if (v.inferred || v.status !== "done") continue;
    const step = steps[v.node];
    if (!step || step.kind === "script" || step.kind === "end") continue;
    argued = reportArgument(v.decided.result, v.why) ?? argued;
    const words = decisionSaid({ reasoning: v.why, decided: v.decided });
    if (GENERIC_WORDS.has(words)) continue;
    const slot = saidSlot(v.node, step.half === "diagnose" ? "diagnose" : step.stage === "build" ? "build" : null);
    if (slot === "proposed") proposed = words;
    else if (slot === "found") found = words;
    else if (slot === "built") built = words;
  }
  return { found, proposed, built, argued };
}

/** A person's answer at a gate that did not approve is what they chose, never a failure: the gate routes Revise and
 *  Drop on its failure outcome, so a person who sent a proposal back reads "revised", not "failed". */
export function gateDecided(d: StepDecided): StepDecided {
  if (!d.outcome || !FAILED_OUTCOME.test(d.outcome)) return d;
  const answer = `${d.toWords ?? ""} ${d.toLabel ?? ""}`;
  const outcome = /\brevis/i.test(answer) ? "revised" : /\bdrop/i.test(answer) ? "dropped" : /\bapprov/i.test(answer) ? "approved" : /\bship/i.test(answer) ? "shipped" : "sent back";
  return { ...d, outcome, words: /fail/i.test(d.words) ? outcome.charAt(0).toUpperCase() + outcome.slice(1) : d.words };
}

/** A person's note with their answer at a gate, when the decision kept one. */
function gateNote(run: MapRun, gate: string, decisions: ReadonlyArray<MapDecision>): string | null {
  const d = [...decisions].reverse().find((x) => x.gate_node_id === gate && x.status === "answered");
  const text = d?.answer_text?.trim();
  if (text && d && (d.answer_index == null || text !== d.options?.[d.answer_index]?.label)) return text;
  return gate === CARD_GATE_NODE_ID && run.gate_node_id === gate && run.gate_response && !/^[A-Z]$/.test(run.gate_response.trim()) ? run.gate_response.trim() : null;
}

/** An occurrence series with one observation taken out for each time given (a repeat filed at that moment). */
function withoutTimes(o: OccurrenceRow, times: ReadonlyArray<number>): OccurrenceRow {
  const left = [...o.observed];
  for (const t of times) { const i = left.indexOf(t); if (i >= 0) left.splice(i, 1); }
  return left.length === o.observed.length ? o : { ...o, observed: left };
}
