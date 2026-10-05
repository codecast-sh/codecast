// Part of the Evals UI's wire contract (docs/architecture/evals-ui.md). Every
// party imports it through ../evalsApi.ts. Attribution from records (section
// 5, Tier 0) and the bisect that follows it (section 5): the whole part lives
// in @platform/evals/contract and is re-exported here. PURE isomorphic data:
// no Node or DOM APIs.

export type {
  Attribution,
  AttributionAnswer,
  AttributionClass,
  BisectAnswer,
  BisectPlan,
  BisectPlanRequest,
  BisectProbe,
  BisectRep,
  BisectStartRequest,
  BisectStartResponse,
  BisectState,
  BisectStatus,
  BisectStep,
  BisectSummary,
  Candidate,
  CostBound,
  Endpoint,
  ProbeReading,
  ProbeVerdict,
  RecordedProbe,
  RenderClass,
  SourceConfidence,
} from "@platform/evals/contract";

import type { Attribution, AttributionAnswer, ProbeReading, ProbeVerdict, RunRowCore, SourceConfidence } from "@platform/evals/contract";

// ── Attribution (section 5, Tier 0) ─────────────────────────────────────────

/** The fixed-order checklist: the first class that differs between good and bad is the answer. */
export const ATTRIBUTION_CLASSES = ["footing", "freeze", "live-reads", "source", "noise"] as const;

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

/** The flipped freezes an answer accounts for, or null when it speaks for every one (a model or ruler move, live reads, source, noise). */
export const answerFreezeIds = (a: AttributionAnswer): string[] | null => (a.kind === "freeze" ? a.freezeIds : a.kind === "footing" ? (a.freezeIds ?? null) : null);
