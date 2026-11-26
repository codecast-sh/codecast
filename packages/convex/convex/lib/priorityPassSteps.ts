// Milestone matching and the person's hold on milestones, for the priority
// pass (lib/priorityPass.ts): which proposed step is which existing one,
// which repeats one the person dropped, what the person set that the pass
// keeps, and the key numbering every write continues. Pure.

import type { PriorityRef, PriorityStep } from "@codecast/shared/contracts/priorities";

const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1));
function similarity(a: string, b: string): number {
  const wa = words(a), wb = words(b);
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / (wa.size + wb.size - shared);
}
/** Two step titles are the same step at this word overlap (Jaccard). */
export const STEP_TITLE_MATCH = 0.5;

/** Words that say nothing about which piece of work a title names. */
const STOPWORDS = new Set(["the", "an", "to", "of", "for", "and", "or", "in", "on", "with", "at", "by", "from", "into", "is", "it", "its", "be", "as", "up", "out", "all", "new"]);
const contentWords = (s: string) => new Set([...words(s)].filter((w) => !STOPWORDS.has(w)));

/**
 * Whether a new step's title repeats one the person dropped: the same title
 * once case and punctuation are ignored, or, without stopwords, every word of
 * the shorter title is in the longer and they share at least half their words
 * ("Update docs" repeats "Docs"; "Write the tests" does not repeat "Write the
 * docs", nor "Eval harness: judge" "Eval harness: grader"). Plain words, no
 * stemming or synonyms: a paraphrase ("Migrate auth" for "Auth migration")
 * gets through, and the prompt's "never propose it again" is the first line
 * of defence against those.
 */
export function repeatsDropped(dropped: string, title: string): boolean {
  const norm = (t: string) => [...words(t)].join(" ");
  if (norm(dropped) && norm(dropped) === norm(title)) return true;
  const a = contentWords(dropped), b = contentWords(title);
  if (!a.size || !b.size) return false;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const w of small) if (big.has(w)) shared++;
  return shared === small.size && shared / (a.size + b.size - shared) >= STEP_TITLE_MATCH;
}

/**
 * `proposed` less every step whose key is new to `current` and whose title
 * repeats a dropped step of `current` or of the priorities a merge absorbs
 * (`absorbed`'s steps) (repeatsDropped), each noted. A step already on the
 * row, and a dropped step itself, is never judged by its title: a drop takes
 * away only what it names.
 */
export function withoutDroppedRepeats(current: PriorityStep[], proposed: PriorityStep[], notes: string[], target: string, absorbed: PriorityStep[] = []): PriorityStep[] {
  const dropped = [...current, ...absorbed].filter((s) => s.dropped);
  if (!dropped.length) return proposed;
  return proposed.filter((s) => {
    if (s.dropped || current.some((c) => c.key === s.key)) return true;
    const d = dropped.find((x) => repeatsDropped(x.title, s.title));
    if (d) notes.push(`${target}: left out new step "${s.title}", it repeats "${d.title}", which the person dropped`);
    return !d;
  });
}

/**
 * Which existing step each proposed step continues, so keys and the person's
 * tiers carry over. Three rounds, each over what is still unmatched, so a
 * stronger signal is never taken by a weaker one first: (1) the same key,
 * (2) the most shared refs (at least one), (3) the most similar title, at
 * least STEP_TITLE_MATCH word overlap.
 *
 * Keys repeat across priorities (each has s1..sN), so `owners` names the
 * priority of each existing step and `own` the one being written. A
 * qualified key ("pri-2/s1") matches that priority's step. A bare key
 * matches only `own`'s step, and when an absorbed priority has a step with
 * the same key it must also share a ref or a title before it counts.
 */
export function matchSteps(existing: PriorityStep[], proposed: Array<{ key?: string; title: string; refs: PriorityRef[] }>, owners?: string[], own = ""): Array<PriorityStep | null> {
  const ownerOf = (ei: number) => owners?.[ei] ?? own;
  const shared = (e: PriorityStep, p: (typeof proposed)[number]) => p.refs.filter((r) => e.refs.some((x) => x.kind === r.kind && x.id === r.id)).length;
  const keyMatch = (e: PriorityStep, p: (typeof proposed)[number], ei: number) => {
    if (!p.key) return 0;
    const slash = p.key.lastIndexOf("/");
    if (slash >= 0) return ownerOf(ei) === p.key.slice(0, slash) && e.key === p.key.slice(slash + 1) ? 1 : 0;
    if (ownerOf(ei) !== own || e.key !== p.key) return 0;
    const ambiguous = existing.some((x, xi) => ownerOf(xi) !== own && x.key === p.key);
    return !ambiguous || shared(e, p) > 0 || similarity(e.title, p.title) >= STEP_TITLE_MATCH ? 1 : 0;
  };
  const out: Array<PriorityStep | null> = proposed.map(() => null);
  const free = new Set(existing.map((_, i) => i));
  const take = (score: (e: PriorityStep, p: (typeof proposed)[number], ei: number) => number, floor: number) => {
    for (const [pi, p] of proposed.entries()) {
      if (out[pi]) continue;
      let best = -1, bestScore = floor;
      for (const ei of free) {
        const s = score(existing[ei], p, ei);
        if (s >= bestScore && (best < 0 || s > bestScore)) { best = ei; bestScore = s; }
      }
      if (best >= 0) { out[pi] = existing[best]; free.delete(best); }
    }
  };
  take(keyMatch, 1);
  take(shared, 1);
  take((e, p) => similarity(e.title, p.title), STEP_TITLE_MATCH);
  return out;
}

/**
 * A step with tasks is done when every task is closed and at least one
 * finished (a step whose tasks were all dropped is not done). A step with no
 * task is the pass's judgment.
 */
export function stepDone(refs: PriorityRef[], judged: boolean | undefined, taskStatus: Map<string, string>): boolean {
  const tasks = refs.filter((r) => r.kind === "task").map((r) => taskStatus.get(r.id));
  if (!tasks.length) return judged === true;
  return tasks.every((s) => s === "done" || s === "dropped") && tasks.some((s) => s === "done");
}

/** A done state the pass never changes: the person's, or one evidence set (a done pin naming the milestone). */
const doneHeld = (s: PriorityStep): boolean => s.done_set_by === "person" || s.done_set_by === "evidence";

/** The step with its done state recomputed; a step that stays done keeps its first done time. A held done state (doneHeld), and a dropped step, stand. */
export function withDone(step: PriorityStep, judged: boolean | undefined, was: PriorityStep | null, taskStatus: Map<string, string>, now: number): PriorityStep {
  if (doneHeld(step) || step.dropped) return step;
  const { done_at: _, ...rest } = step;
  const done = stepDone(step.refs, judged, taskStatus);
  return done ? { ...rest, done, done_at: was?.done ? was.done_at ?? now : now } : { ...rest, done };
}

export const criticalDone = (steps: PriorityStep[]) => {
  const critical = steps.filter((s) => s.tier === "critical" && !s.dropped);
  return critical.length > 0 && critical.every((s) => s.done);
};

/** A step carrying something the person set (its tier, title or done state, or its drop), or a done state evidence set. */
export const isPersonHeld = (s: PriorityStep): boolean =>
  s.tier_set_by === "person" || s.title_set_by === "person" || doneHeld(s) || !!s.dropped;

/** A step the pass wrote, with what the person set on `was` laid over it. A dropped `was` stays the tombstone it is. */
export function withPersonFields(step: PriorityStep, was: PriorityStep): PriorityStep {
  if (was.dropped) return was;
  let out: PriorityStep = { ...step };
  if (was.tier_set_by === "person") out = { ...out, tier: was.tier, tier_set_by: "person" };
  if (was.title_set_by === "person") out = { ...out, title: was.title, title_set_by: "person" };
  if (doneHeld(was)) {
    // Its refs stay as they were too: a task the pass attaches would hand its done state back to the tasks.
    const { done_at: _, ...rest } = out;
    out = { ...rest, refs: was.refs, done: was.done, ...(was.done_at !== undefined ? { done_at: was.done_at } : {}), done_set_by: was.done_set_by };
  }
  return out;
}

/**
 * The steps a write may leave on a priority whose steps are `current` now:
 * `proposed`, with every person-set field of the step holding the same key
 * laid back over it, none new to the row that repeats a step the person
 * dropped (withoutDroppedRepeats), and every step the person set something on
 * that `proposed` lost, kept, as is every step in `anchored` (one a session
 * the person placed, or a known link, sits on). applyPlan runs it against the
 * row as it stands when it writes, so a setting made while the model was
 * reading holds too.
 */
export function holdPersonSteps(current: PriorityStep[], proposed: PriorityStep[], notes: string[] = [], target = "", anchored: ReadonlySet<string> = new Set()): PriorityStep[] {
  const held = current.filter((s) => isPersonHeld(s) || (!s.dropped && anchored.has(s.key)));
  const out = withoutDroppedRepeats(current, proposed, notes, target).map((s) => {
    const was = held.find((h) => h.key === s.key);
    // A drop only the person makes: an anchored step the plan would drop stays as it is.
    if (was && s.dropped && !was.dropped && !isPersonHeld(was)) return was;
    return was ? withPersonFields(s, was) : s;
  });
  for (const h of held) if (!out.some((s) => s.key === h.key)) out.push(h);
  return out;
}

/** The highest milestone key number among `steps` and the mark a priority keeps (step_key_max). */
export const stepKeyMax = (steps: ReadonlyArray<{ key: string }>, mark = 0): number => Math.max(mark ?? 0, 0, ...steps.map((s) => keyNumber(s.key)));

export const keyNumber = (key: string | null | undefined) => {
  const m = key ? /^s(\d+)$/.exec(key) : null;
  return m ? Number(m[1]) : 0;
};
