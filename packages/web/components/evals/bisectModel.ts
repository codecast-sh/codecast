// The arithmetic behind the bisect pages (docs/architecture/evals-ui.md 4.5
// and section 5): the order the commit ruler lays candidates in, where the
// good and bad brackets stand once probes resolve, how many probes are left,
// and the words for a status or an outcome. Pure, so the ruler, the list, the
// fixtures and the tests read one model.

import type { BisectAnswer, BisectProbe, BisectState, BisectStatus, BisectSummary, Candidate, ProbeVerdict, RenderClass } from "@codecast/shared/contracts/evalsApi";

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

/** Probes needed to search `classes` render classes whose newest is known bad. */
export const probesLeftFor = (classes: number) => (classes <= 1 ? 0 : Math.ceil(Math.log2(classes)));

export const BISECT_LIVE: ReadonlySet<BisectStatus> = new Set(["planning", "controls", "probing", "confirming"]);
export const isBisectLive = (status: BisectStatus) => BISECT_LIVE.has(status);

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

/** A batch name or a sha, short enough for a chip. */
export function endpointLabel(ref: string): string {
  if (/^[0-9a-f]{7,40}$/.test(ref)) return ref.slice(0, 8);
  const m = ref.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : ref;
}
