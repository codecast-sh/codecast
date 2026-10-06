// The arithmetic behind the bisect pages (docs/architecture/evals-ui.md 4.5
// and section 5): the order the commit ruler lays candidates in, where the
// good and bad brackets stand once probes resolve, how many probes are left,
// and the words for a status or an outcome. Pure, so the ruler, the list, the
// fixtures and the tests read one model.

import { EVALS_SHA_RE, type Attribution, type BisectAnswer, type BisectProbe, type BisectRep, type BisectState, type BisectStatus, type BisectStep, type BisectSummary, type Candidate, type ProbeVerdict, type RenderClass, type BisectPlan, type BisectResponse, type SimJob } from "@codecast/shared/contracts/evalsApi";
import { batchLabel, shortSha } from "./format";
import type { BisectPlanPanelProps } from "./BisectPlanPanel";
import { EVALS_STALL_MS } from "../../lib/evals/hooks";
import type { VerdictState } from "./verdictModel";

/** The sha a candidate replays at: a commit, or the head a patch sits on. */
export const candidateSha = (c: Candidate) => (c.kind === "commit" ? c.commit.sha : c.base);

/** A stable key for a candidate: a commit's sha, or the patch's own hash (it sits on a head that is also a candidate). */
export const candidateKey = (c: Candidate) => (c.kind === "commit" ? c.commit.sha : `patch:${c.treePatch}`);

/**
 * Ancestry order, oldest first: commits by author date, then the uncommitted
 * patch, which sits on top of the bad end and is always the last tile.
 */
export function orderCandidates(candidates: readonly Candidate[]): Candidate[] {
  const commits = candidates.filter((c): c is Extract<Candidate, { kind: "commit" }> => c.kind === "commit");
  const patches = candidates.filter((c) => c.kind === "patch");
  return [...[...commits].sort((a, b) => Date.parse(a.commit.at) - Date.parse(b.commit.at)), ...patches];
}

/**
 * A rep's state on the ruler. The runner builds a rep only from a run that
 * exists (`repOf` in bisect/runner.ts), and gives a crashed one `passed: null`,
 * so a run id with no pass or fail is a crash; no run id is a rep still to land.
 */
export type RepState = "pending" | "crashed" | "passed" | "failed";
export const repState = (r: BisectRep): RepState => (r.passed === true ? "passed" : r.passed === false ? "failed" : r.runId ? "crashed" : "pending");

/** A probe's reps counted by state, the ruler's tally. */
export function repTally(reps: readonly BisectRep[]): Record<RepState, number> & { landed: number; all: number } {
  const t = { pending: 0, crashed: 0, passed: 0, failed: 0 };
  for (const r of reps) t[repState(r)]++;
  return { ...t, landed: reps.length - t.pending, all: reps.length };
}

/** Probes needed to search `classes` render classes whose newest is known bad. */
export const probesLeftFor = (classes: number) => (classes <= 1 ? 0 : Math.ceil(Math.log2(classes)));

export const BISECT_LIVE: ReadonlySet<BisectStatus> = new Set(["planning", "controls", "probing", "confirming"]);
export const isBisectLive = (status: BisectStatus) => BISECT_LIVE.has(status);

/** No new step for the stall window (section 3.6): any live job, a bisect, a shrink or a sweep, then reads "stalled?". */
/**
 * When a bisect id says it was started: newBisectId stamps `<surface>-<yyyymmdd>-<hhmmss>` in UTC,
 * with a counter after it when that second was taken. Null for an id that carries no stamp.
 */
export function bisectIdStartedAt(id: string): number | null {
  const m = id.match(/-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d+)?$/);
  if (!m) return null;
  const at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isFinite(at) ? at : null;
}

/** How long a page keeps asking for a bisect it was just sent to before it says there is none. */
export const JUST_STARTED_MS = 3 * 60_000;

/** An id the api has not answered for yet, stamped within the last few minutes: a start whose state is still on its way. */
export const isJustStarted = (id: string, now: number) => {
  const at = bisectIdStartedAt(id);
  return at !== null && now - at < JUST_STARTED_MS && now - at > -60_000;
};

export const quietTooLong = (updatedAt: string, now: number, stallMs = EVALS_STALL_MS) => now - Date.parse(updatedAt) > stallMs;

/** Stalled: the server says so, or a live bisect has written nothing for `stallMs`. The bisect page, the list and the wall's ribbon all ask this. */
export function isBisectStalled(b: { status: BisectStatus; updatedAt: string; stalled?: boolean }, now: number, stallMs: number): boolean {
  return isBisectLive(b.status) && (!!b.stalled || quietTooLong(b.updatedAt, now, stallMs));
}

/** A Multiplayer sim shrink or sweep, by the bisect's own rule. */
export const isJobStalled = (job: Pick<SimJob, "status" | "updatedAt">, now: number) => job.status === "running" && quietTooLong(job.updatedAt, now);

export interface RulerTile {
  key: string;
  index: number;
  candidate: Candidate;
  sha: string;
  /** The render class it collapsed into (Tier 1), or null when not yet rendered. */
  classN: number | null;
  /** Every probe and confirmation replayed at this tile's sha. */
  probes: BisectProbe[];
  /** Its class's reading: a probe at any commit of a class reads for the whole class. */
  verdict: ProbeVerdict | null;
  /** Read for free from a recorded batch, not replayed. */
  recorded: boolean;
  /** Outside the brackets: already known good, or after the oldest known bad. */
  outside: boolean;
  culprit: boolean;
}

export interface RulerSpan {
  n: number;
  from: number;
  to: number;
  skip: string | null;
}

export interface RulerModel {
  tiles: RulerTile[];
  /** Runs of adjacent tiles in one render class, for the brackets under the ruler (classes of one tile included). */
  spans: RulerSpan[];
  /** The newest tile known good; -1 is the good end itself, left of the first tile. */
  goodAt: number;
  /** The oldest tile known bad; the last tile is the bad end until a probe reads earlier. */
  badAt: number;
  controls: { good: BisectProbe[]; bad: BisectProbe[] };
  /** Render classes still between the brackets. */
  classesLeft: number;
  probesLeft: number;
  culpritAt: number | null;
}

type RulerInput = Pick<BisectState, "candidates" | "classes" | "probes" | "answer">;

function classOf(c: Candidate, classes: readonly RenderClass[] | null): number | null {
  if (c.renderClass !== null) return c.renderClass;
  if (c.kind === "patch") return null;
  return classes?.find((k) => k.shas.includes(c.commit.sha))?.n ?? null;
}

/** The latest reading among probes: pending wins, so a probe still landing reads as pending. */
function readingOf(probes: readonly BisectProbe[]): ProbeVerdict | null {
  if (!probes.length) return null;
  if (probes.some((p) => p.verdict === "pending")) return "pending";
  return probes[probes.length - 1].verdict;
}

export function rulerModel(state: RulerInput): RulerModel {
  const ordered = orderCandidates(state.candidates);
  const base0 = ordered.map((candidate, index) => ({ candidate, index, sha: candidateSha(candidate), key: candidateKey(candidate), classN: classOf(candidate, state.classes) }));
  // A patch tile shares its head's sha with the bad end's own commit, so a
  // probe finds its tile by sha and render class together; with no class to
  // tell them apart it is the commit's. Confirmations replay plain commits.
  const belongs = (p: BisectProbe, t: (typeof base0)[number]) => {
    if (p.sha !== t.sha) return false;
    if (p.kind !== "probe") return t.candidate.kind === "commit";
    if (p.renderClass === null || t.classN === null) return t.candidate.kind === "commit";
    return p.renderClass === t.classN;
  };
  const searchProbes = state.probes.filter((p) => p.kind === "probe" || p.kind === "confirm-culprit" || p.kind === "confirm-parent");
  const placed = new Set<BisectProbe>();
  const base = base0.map((t) => {
    const probes = searchProbes.filter((p) => belongs(p, t));
    probes.forEach((p) => placed.add(p));
    return { ...t, probes };
  });
  // The culprit's parent is often outside the range (the good end): its
  // confirmation reps stand with the good control.
  const controls = {
    good: [...state.probes.filter((p) => p.kind === "control-good"), ...searchProbes.filter((p) => !placed.has(p))],
    bad: state.probes.filter((p) => p.kind === "control-bad"),
  };

  // A class reads as one: the probe at its representative speaks for every commit in it.
  const classReading = new Map<number, ProbeVerdict | null>();
  for (const t of base) {
    if (t.classN === null) continue;
    const mates = base.filter((m) => m.classN === t.classN).flatMap((m) => m.probes.filter((p) => p.kind === "probe"));
    classReading.set(t.classN, readingOf(mates));
  }
  const verdictOf = (t: (typeof base)[number]) => (t.classN !== null ? classReading.get(t.classN) ?? null : readingOf(t.probes.filter((p) => p.kind === "probe")));

  // A class is one tile to the search, so a bracket closes after its last commit.
  const lastOfClass = (t: (typeof base)[number]) => (t.classN === null ? t.index : Math.max(...base.filter((m) => m.classN === t.classN).map((m) => m.index)));
  let goodAt = -1;
  let badAt = base.length - 1;
  for (const t of base) if (verdictOf(t) === "good") goodAt = Math.max(goodAt, lastOfClass(t));
  const oldestBad = base.find((t) => t.index > goodAt && verdictOf(t) === "bad");
  if (oldestBad) badAt = lastOfClass(oldestBad);
  const culpritSha = state.answer?.kind === "culprit" ? state.answer.commit.sha : null;
  const tiles: RulerTile[] = base.map((t) => ({
    ...t,
    verdict: verdictOf(t),
    recorded: t.probes.some((p) => p.recorded),
    outside: t.index <= goodAt || t.index > badAt,
    culprit: culpritSha !== null && t.candidate.kind === "commit" && t.sha === culpritSha,
  }));

  const spans: RulerSpan[] = [];
  for (const t of tiles) {
    const last = spans[spans.length - 1];
    if (t.classN !== null && last && last.n === t.classN && last.to === t.index - 1) last.to = t.index;
    else if (t.classN !== null) spans.push({ n: t.classN, from: t.index, to: t.index, skip: state.classes?.find((k) => k.n === t.classN)?.skip ?? null });
  }

  const inside = tiles.filter((t) => !t.outside);
  const classesLeft = new Set(inside.map((t) => (t.classN !== null ? `c${t.classN}` : t.key))).size;
  const culpritAt = tiles.find((t) => t.culprit)?.index ?? null;
  return { tiles, spans, goodAt, badAt, controls, classesLeft, probesLeft: culpritAt !== null ? 0 : probesLeftFor(classesLeft), culpritAt };
}

// ── Words ───────────────────────────────────────────────────────────────────

const STATUS_WORDS: Record<BisectStatus, string> = {
  planning: "planning",
  controls: "running the controls",
  probing: "probing",
  confirming: "confirming the culprit",
  done: "done",
  stopped: "stopped",
  budget: "stopped at its budget",
  failed: "failed",
};
export const bisectStatusWord = (s: BisectStatus) => STATUS_WORDS[s];

const OUTCOME_WORDS: Record<BisectAnswer["kind"], string> = {
  culprit: "culprit",
  range: "a range",
  drift: "drift, not source",
  crashed: "a control crashed",
  attribution: "answered from records",
  unreplayable: "not replayable",
};
export const bisectOutcomeWord = (k: BisectAnswer["kind"]) => OUTCOME_WORDS[k];

/** One line for a bisect in a list: its outcome when it has one, else where it is. */
export function bisectSummaryWord(b: Pick<BisectSummary, "status" | "outcome" | "culprit">): string {
  if (b.outcome === "culprit" && b.culprit) return `culprit ${b.culprit.slice(0, 8)}`;
  if (b.outcome) return bisectOutcomeWord(b.outcome);
  return bisectStatusWord(b.status);
}

const TIER_WORDS = { 0: "Tier 0, from records (free)", 1: "Tier 1, dry renders (free)", 2: "Tier 2, replay probes (paid)" } as const;
export const tierWord = (t: 0 | 1 | 2) => TIER_WORDS[t];

/** A batch name or a sha, short enough for a chip; a batch reads as every page writes it (format.ts batchLabel). */
export const endpointLabel = (ref: string): string => (EVALS_SHA_RE.test(ref) ? shortSha(ref) : batchLabel(ref));

// ── Bisects over a range ────────────────────────────────────────────────────

const BATCH_TIME = /^\d{4}-\d\d-\d\dT/;

/**
 * When one end of a past bisect sits, as a time. A bisect records its ends as
 * they were given: a batch name is a time; a sha is placed only when it is one
 * of this attribution's own ends (its batch, its commit or its main twin).
 * Anything else cannot be placed, and its bisect is left out rather than guessed.
 */
function endAt(ref: string, a: Pick<Attribution, "good" | "bad">): number | null {
  for (const e of [a.good, a.bad]) {
    if (ref === e.batch || (EVALS_SHA_RE.test(ref) && (e.sha.startsWith(ref) || !!e.mainSha?.startsWith(ref)))) return e.at ? Date.parse(e.at) : null;
  }
  return BATCH_TIME.test(ref) && Number.isFinite(Date.parse(ref)) ? Date.parse(ref) : null;
}

/**
 * The bisects on this surface whose range overlaps good..bad: what the
 * launcher shows before anyone pays again for an answer already on record.
 * Live ones first, then newest. `same` marks a bisect over exactly these ends.
 */
export function bisectsOverRange(list: readonly BisectSummary[], a: Pick<Attribution, "surface" | "good" | "bad">): Array<BisectSummary & { same: boolean }> {
  const lo = a.good.at ? Date.parse(a.good.at) : NaN;
  const hi = a.bad.at ? Date.parse(a.bad.at) : NaN;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  return list
    .filter((b) => b.surface === a.surface)
    .flatMap((b) => {
      const [g, d] = [endAt(b.good, a), endAt(b.bad, a)];
      if (g === null || d === null || !(g < hi && d > lo)) return [];
      return [{ ...b, same: g === lo && d === hi }];
    })
    .sort((x, y) => Number(isBisectLive(y.status)) - Number(isBisectLive(x.status)) || Date.parse(y.startedAt) - Date.parse(x.startedAt));
}

/** The runner's own answer line (the last `answer` step): why a bisect ended where it did, in the words runner.ts wrote. */
export const answerStepText = (steps: readonly BisectStep[]): string | null => [...steps].reverse().find((x) => x.kind === "answer")?.text ?? null;

/** Running first, then newest first. */
export function sortBisects(list: readonly BisectSummary[]): BisectSummary[] {
  return [...list].sort((a, b) => Number(isBisectLive(b.status)) - Number(isBisectLive(a.status)) || Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

export const PLAN_REPS = [3, 4, 5, 6, 7] as const;

/** Over budget: `check --budget` refuses a plan whose bound is above it. */
export const planOverBudget = (plan: BisectPlan, budgetUsd: number | null) => (budgetUsd ?? plan.budgetUsd) < plan.bound.maxUsd;

/** Whether Start can go: a priced plan for these settings, within budget, confirmed where it must be. */
export function canStart(p: Pick<BisectPlanPanelProps, "plan" | "pending" | "starting" | "confirm" | "settings" | "blockedBy">): boolean {
  if (!p.plan || p.pending || p.starting || p.blockedBy || !p.settings.freezes.length) return false;
  if (p.plan.needsConfirm && !p.confirm) return false;
  return !planOverBudget(p.plan, p.settings.budgetUsd);
}

/**
 * A bisect's glyph, from its outcome, for the list and the page alike: a
 * culprit fails, a range is mixed, a crashed control or a failed run is a
 * cross; drift, an attribution and an unreplayable answer stay neutral, and
 * every caller titles the glyph with the outcome's own word.
 */
export function bisectGlyph(b: { status: BisectStatus; outcome: BisectAnswer["kind"] | null }): VerdictState {
  if (isBisectLive(b.status)) return "unscored";
  if (b.outcome === "culprit") return "fail";
  if (b.outcome === "range") return "mixed";
  if (b.outcome === "crashed" || b.status === "failed") return "crash";
  return "dry";
}

/** A bisect's state in the shape bisectGlyph and bisectSummaryWord read. */
export const bisectOutcomeOf = (state: Pick<BisectState, "status" | "answer">) => ({ status: state.status, outcome: state.answer?.kind ?? null, culprit: state.answer?.kind === "culprit" ? state.answer.commit.sha : null });

/** Stalled: the server says so, or a live bisect has written no step for five minutes. */
export function isStalled(data: Pick<BisectResponse, "state" | "stalled">, now: number): boolean {
  return isBisectStalled({ ...data.state, stalled: data.stalled }, now, EVALS_STALL_MS);
}
