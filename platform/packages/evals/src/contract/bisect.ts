// Part of the shared evals wire contract (codecast docs/architecture/evals-ui.md):
// attribution from records (section 5, Tier 0) and the bisect that follows it
// (section 5). PURE isomorphic data: no Node or DOM APIs.

import type { EvalFlip } from "./evalResult";
import type { CommitRef, Epoch, Footing, PromptFilePair, RunRowCore, SeparationResult, VerdictFlip } from "./core";

// ── Attribution (section 5, Tier 0) ─────────────────────────────────────────

/** The fixed-order checklist: the first class that differs between good and bad is the answer. */
export const ATTRIBUTION_CLASSES = ["footing", "freeze", "live-reads", "source", "noise"] as const;
export type AttributionClass = (typeof ATTRIBUTION_CLASSES)[number];

/** One end of a range: a batch (or a bare sha) with what it ran on. */
export interface Endpoint {
  batch: string | null;
  sha: string;
  mainSha: string | null;
  dirty: boolean;
  treePatch: string | null;
  footing: Footing;
  at: string | null;
}

/** A place the regression can sit: a commit, or a dirty batch's uncommitted edits on top of its head. */
export type Candidate =
  | { kind: "commit"; commit: CommitRef; renderClass: number | null }
  | { kind: "patch"; base: string; treePatch: string; renderClass: number | null };

/** A recorded batch inside the range that classified for free. */
export interface RecordedProbe {
  batch: string;
  sha: string;
  verdict: ProbeVerdict;
  reps: number;
}

export type ProbeVerdict = "good" | "bad" | "unsure" | "skip" | "pending";

export type AttributionAnswer =
  /** `freezeIds`: the footing that moved is these freezes' own rubric (a per-freeze judge or label line), not the surface's ruler. */
  | { kind: "footing"; change: "model" | "judge"; from: string | null; to: string | null; freezeIds?: string[] }
  | { kind: "freeze"; freezeIds: string[] }
  | { kind: "live-reads"; reps: number; reads: number }
  | {
      kind: "source";
      /** `empty`: no candidate is left in the range (no declared source moved, or the recorded batches bracket a step that touches none). */
      confidence: SourceConfidence;
      candidates: Candidate[];
      narrowedBy: RecordedProbe[];
      epochs: Epoch[];
      /** No declared source moved in the range: only --all-commits searches it. */
      noDeclaredSourceMoved: boolean;
      /** Every commit between the two ends, whatever it touches: what --all-commits would search. */
      rangeCommits: number;
      /** Why it is unattributable: an endpoint was dirty, has no patch, and Tier 1 mapped nothing. */
      reason: string | null;
    }
  | { kind: "noise"; separation: SeparationResult };

export interface Attribution {
  surface: string;
  good: Endpoint;
  bad: Endpoint;
  /** `flip` when freezes flipped; `score` when only the scores fell (the 3 largest median drops stand in). */
  mode: "flip" | "score";
  flipped: VerdictFlip[];
  /** Each class in ATTRIBUTION_CLASSES order, with whether it differs and the plain words for it. */
  checklist: Array<{ class: AttributionClass; differs: boolean; detail: string }>;
  answer: AttributionAnswer;
  /** Every rendered prompt file of each focus freeze at both ends, changed or not, shown whatever the confidence. */
  promptDiffs: PromptFilePair[];
  examples: EvalFlip[];
}

/**
 * Whether a replay search has anything to do: a source answer with candidates
 * the records did not pin. An unattributable answer with candidates counts,
 * because a bisect's start renders each candidate and can map an end that ran
 * on unreplayable edits onto the commit it rendered like. The engine and the
 * launcher page both ask this, so the page offers a plan exactly when the
 * engine would run one.
 */
export function attributionSearchable(a: Pick<Attribution, "answer">): boolean {
  if (a.answer.kind !== "source" || a.answer.confidence === "pinned") return false;
  if (a.answer.confidence === "unattributable") return a.answer.candidates.length > 0;
  return a.answer.candidates.length > 1;
}

export type SourceConfidence = "pinned" | "narrowed" | "empty" | "unattributable";

/** How many candidates the records left, in one word: none, one, or several. */
export const sourceConfidence = (candidates: number): Exclude<SourceConfidence, "unattributable"> => (candidates === 0 ? "empty" : candidates === 1 ? "pinned" : "narrowed");

/**
 * Section 5, Tier 0 step 4: narrowing a range by the recorded batches inside
 * it, for free. `at` is a batch's commit's index in the range (oldest first),
 * `rangeLength` the number of commits in it. A clean bad batch moves the bad
 * bound to its commit. A batch on edits that reads bad may owe it to those
 * edits, which land as later commits, so only a good reading moves a bound
 * for it. The bad end's patch candidate stays only while no clean recorded
 * batch reads bad. Candidates are the commits with an index in
 * (goodAt, badAt]. attribution.ts and the fixture world both narrow here.
 */
export function narrowByRecords(rangeLength: number, probes: ReadonlyArray<{ at: number; verdict: ProbeVerdict; clean: boolean }>): { goodAt: number; badAt: number; keepPatch: boolean } {
  const bads = probes.filter((p) => p.verdict === "bad" && p.clean).map((p) => p.at);
  const badAt = bads.length ? Math.min(...bads) : rangeLength - 1;
  const goodAt = Math.max(-1, ...probes.filter((p) => p.verdict === "good" && p.at < badAt + (bads.length ? 0 : 1)).map((p) => p.at));
  return { goodAt, badAt, keepPatch: !bads.length };
}

/** How a set of reps reads against the ends of a range: `split` when it leans neither way. */
export type ProbeReading = "good" | "bad" | "split";

/**
 * The probe rule in flip mode (section 5), which the bisect runner reads its
 * probes by and attribution reads recorded batches by, so both narrow alike.
 * Each focus freeze votes by the majority of its graded reps, a tie or no rep
 * voting neither way; the reading is bad when most focus freezes fail and good
 * when most pass, counted over every focus freeze, so a batch that ran one of
 * three and failed it is a split, never bad.
 */
export function flipReading(reps: ReadonlyArray<{ freezeId: string; passed: boolean }>, focus: readonly string[]): ProbeReading {
  const votes = focus.map((f) => {
    const mine = reps.filter((r) => r.freezeId === f);
    const passed = mine.filter((r) => r.passed).length;
    return !mine.length || passed * 2 === mine.length ? 0 : passed * 2 > mine.length ? 1 : -1;
  });
  const [good, bad] = [votes.filter((v) => v > 0).length, votes.filter((v) => v < 0).length];
  return bad * 2 > focus.length ? "bad" : good * 2 > focus.length ? "good" : "split";
}

/**
 * Section 5, Tier 0 step 1: for a fall in score with no flip, the focus
 * freezes are those both sides graded whose median score dropped most (up to
 * `k`; a missing score counts as 0). attribution.ts and the fixture world both
 * pick them here.
 */
export function largestDrops(good: ReadonlyArray<Pick<RunRowCore, "freezeId" | "score">>, bad: ReadonlyArray<Pick<RunRowCore, "freezeId" | "score">>, k = 3): string[] {
  const med = (set: typeof good, f: string) => {
    const s = set.filter((r) => r.freezeId === f).map((r) => r.score ?? 0).sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return !s.length ? NaN : s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  };
  const both = [...new Set(bad.map((r) => r.freezeId))].filter((f) => good.some((r) => r.freezeId === f));
  const drops = both.map((f) => ({ f, drop: med(good, f) - med(bad, f) })).sort((a, b) => b.drop - a.drop);
  const fell = drops.filter((d) => d.drop > 0);
  return (fell.length ? fell : drops).slice(0, k).map((d) => d.f);
}

// ── Bisect (section 5) ──────────────────────────────────────────────────────

/** Candidates whose dry renders match on every flipped freeze: a replay cannot tell them apart. */
export interface RenderClass {
  n: number;
  shas: string[];
  /** The newest commit in the class: the one a probe replays. */
  representative: string;
  promptShas: Record<string, string>;
  /** Set when the surface does not load at this class (baseLoadErrors). */
  skip: string | null;
}

/** C, P, F and r from the cost bound, and what they come to. */
export interface CostBound {
  classes: number;
  probes: number;
  freezes: number;
  reps: number;
  maxReps: number;
  perRepUsd: number;
  judgePerRepUsd: number;
  maxUsd: number;
}

export interface BisectPlanRequest {
  surface: string;
  /** A batch name or a sha. */
  good: string;
  bad: string;
  freezes?: string[];
  reps?: number;
  budgetUsd?: number;
  maxMinutes?: number;
  allCommits?: boolean;
}

export interface BisectPlan {
  surface: string;
  good: Endpoint;
  bad: Endpoint;
  attribution: Attribution;
  freezes: Array<{ id: string; name: string; role: "flipped" | "control" }>;
  reps: number;
  candidates: Candidate[];
  /** Null until the Tier 1 dry render finishes. */
  classes: RenderClass[] | null;
  bound: CostBound;
  /** Default 1.2 times the bound. */
  budgetUsd: number;
  maxMinutes: number;
  allCommits: boolean;
  /** An agent surface: starting needs an explicit confirm (--yes). */
  needsConfirm: boolean;
  /** The cost line in plain words. */
  summary: string;
}

export interface BisectStartRequest extends BisectPlanRequest {
  /** The agent-surface confirm, passed as --yes. */
  confirm?: boolean;
}

export interface BisectStartResponse {
  id: string;
  /** The tmux session the bisect runs in, or null when it runs detached. Either way its output goes to job.log. */
  tmux: string | null;
}

export type BisectStatus = "planning" | "controls" | "probing" | "confirming" | "done" | "stopped" | "budget" | "failed";

export interface BisectRep {
  freezeId: string;
  runId: string | null;
  passed: boolean | null;
  score: number | null;
}

export interface BisectProbe {
  sha: string;
  kind: "control-good" | "control-bad" | "probe" | "confirm-culprit" | "confirm-parent";
  renderClass: number | null;
  /** `<id>~<sha8>` for a replay probe, or the recorded batch. */
  batch: string;
  recorded: boolean;
  reps: BisectRep[];
  verdict: ProbeVerdict;
  skipReason: string | null;
  costUsd: number;
}

export type BisectAnswer =
  | { kind: "culprit"; commit: CommitRef; separation: SeparationResult; tier: 0 | 1 | 2 }
  | { kind: "range"; candidates: Candidate[]; separation: SeparationResult | null; tier: 0 | 1 | 2 }
  /** The controls did not reproduce on today's tool and judge. */
  | { kind: "drift"; detail: string }
  /** Every rep of a control on some focus freeze crashed, so the search has nothing to read. */
  | { kind: "crashed"; detail: string; runIds: string[] }
  /** Tier 0 answered with a non-source class. */
  | { kind: "attribution"; answer: AttributionAnswer }
  | { kind: "unreplayable"; detail: string };

/** EVALS_HOME/bisects/<id>/state.json, rewritten after each rep. */
export interface BisectState {
  id: string;
  surface: string;
  seq: number;
  status: BisectStatus;
  tier: 0 | 1 | 2;
  range: { good: string; bad: string };
  candidates: Candidate[];
  classes: RenderClass[] | null;
  probes: BisectProbe[];
  spentUsd: number;
  budgetUsd: number;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  tmux: string | null;
  answer: BisectAnswer | null;
  plan: BisectPlan;
  /**
   * Set on the state the api child writes as it starts a bisect, from the
   * free plan, before the runner has loaded the records (tens of seconds
   * under load). The runner's first save replaces it; a pending state whose
   * job has ended reads as failed, with the job's own output in logTail.
   */
  pending?: true;
}

/** One line of EVALS_HOME/bisects/<id>/steps.jsonl. */
export interface BisectStep {
  seq: number;
  at: string;
  kind: "plan" | "render" | "control" | "probe" | "rep" | "narrow" | "confirm" | "answer" | "stop" | "error";
  sha: string | null;
  text: string;
  /** The rep that landed, for kind `rep`. */
  rep?: BisectRep;
}

/** A bisect in a list or a ribbon. */
export interface BisectSummary {
  id: string;
  surface: string;
  good: string;
  bad: string;
  status: BisectStatus;
  outcome: BisectAnswer["kind"] | null;
  culprit: string | null;
  spentUsd: number;
  budgetUsd: number;
  startedAt: string;
  /** state.json's last write: a live bisect quiet for five minutes reads "stalled?". */
  updatedAt: string;
  finishedAt: string | null;
}

/** The flipped freezes an answer accounts for, or null when it speaks for every one (a model or ruler move, live reads, source, noise). */
export const answerFreezeIds = (a: AttributionAnswer): string[] | null => (a.kind === "freeze" ? a.freezeIds : a.kind === "footing" ? (a.freezeIds ?? null) : null);
