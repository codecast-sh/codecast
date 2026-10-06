// What the freeze page decides (evals-ui.md 4.3): the default pair of reps,
// the story of the pair on screen, attribution ends and the prompt files to
// diff. Pure, beside FreezeView.

import type { LedgerCell, PromptFilePair, RunResponse, RunRowCore } from "../../contract";

/**
 * The anatomy a product may add to a run response (codecast: its model calls
 * and agent turns). A product without it answers from the run's sends alone.
 */
export interface RunAnatomy {
  calls?: ReadonlyArray<{ dir: string; system: string | null; prompt: string; reply: string | null }>;
  agents?: ReadonlyArray<{ dir: string; prompt: string; then: readonly string[]; said: readonly string[] }>;
}
/** A run response with whatever anatomy its product adds. */
export type RunWithAnatomy = RunResponse & RunAnatomy;
import { score2, batchLabel } from "./format";
import { verdictOfRow, type VerdictState } from "./verdictModel";

// ── What the page decides ───────────────────────────────────────────────────

/** The two reps the cards hold, by run id. */
export interface FreezePair {
  a: string | null;
  b: string | null;
}

export interface DefaultFreezePair extends FreezePair {
  /** The flip the pair straddles, when there is one on the same footing. */
  flip: { batch: string; before: string; direction: NonNullable<LedgerCell["flip"]> } | null;
  /** Why these two, in words. */
  why: string;
}

/** Reps the strip draws: dry renders graded nothing and bisect probes ran other commits on purpose (both hidden, as on the surface chart). */
export const shownRep = (r: RunRowCore) => r.status !== "dry" && r.cadence !== "bisect";
export const graded = (r: RunRowCore) => r.status === "pass" || r.status === "fail";
const byStamp = (a: RunRowCore, b: RunRowCore) => a.stamp.localeCompare(b.stamp);

/** The freeze's batches oldest first, with the reps each holds. */
export function batchColumns<R extends RunRowCore>(runs: R[]): Array<{ batch: string; at: string; reps: R[] }> {
  const by = new Map<string, { batch: string; at: string; reps: R[] }>();
  for (const r of runs) {
    if (!shownRep(r) || !r.batch) continue;
    const col = by.get(r.batch) ?? { batch: r.batch, at: r.batchAt ?? r.stamp, reps: [] };
    col.reps.push(r);
    by.set(r.batch, col);
  }
  for (const c of by.values()) c.reps.sort(byStamp);
  return [...by.values()].sort((a, b) => a.at.localeCompare(b.at) || a.batch.localeCompare(b.batch));
}

/**
 * The default pair: the last rep that matched the verdict before the newest
 * flip, and the first that matched it after (for a break, the last pass before
 * and the first fail after). A batch the page was opened on (`?batch=`) takes
 * the flip's place. With no flip on record, the newest two graded batches.
 */
export function defaultFreezePair(runs: RunRowCore[], cells: Record<string, LedgerCell> | null, pinnedBatch: string | null): DefaultFreezePair {
  const cols = batchColumns(runs).filter((c) => c.reps.some(graded));
  const none: DefaultFreezePair = { a: null, b: null, flip: null, why: "No rep of this freeze has been graded yet." };
  if (!cols.length) return none;
  const index = (batch: string) => cols.findIndex((c) => c.batch === batch);
  const majorityOf = (batch: string) => cells?.[batch]?.majority ?? null;
  // The batch a flip is measured against: the nearest earlier one with a majority (the ledger's own rule).
  const before = (i: number) => {
    for (let j = i - 1; j >= 0; j--) if (!cells || majorityOf(cols[j].batch) !== null) return j;
    return -1;
  };
  let target = -1;
  let flip: DefaultFreezePair["flip"] = null;
  let why: string;
  const pinned = pinnedBatch ? index(pinnedBatch) : -1;
  if (pinned >= 0) {
    target = pinned;
    const f = cells?.[cols[pinned].batch]?.flip ?? null;
    why = f ? `The batch this page was opened on, where it ${f === "broke" ? "broke" : "was fixed"}, against the batch before.` : "The batch this page was opened on, against the batch before.";
  } else {
    for (let i = cols.length - 1; i >= 0 && target < 0; i--) if (cells?.[cols[i].batch]?.flip) target = i;
    if (target >= 0) why = "";
    else {
      target = cols.length - 1;
      why = cells ? "No flip on the same footing: the newest two graded batches." : "The newest two graded batches (the surface's ledger is not loaded, so flips are unknown).";
    }
  }
  const prev = before(target);
  const direction = cells?.[cols[target].batch]?.flip ?? null;
  if (direction && prev >= 0) {
    flip = { batch: cols[target].batch, before: cols[prev].batch, direction };
    if (!why) why = direction === "broke" ? "The last pass before the newest flip, and the first fail after it." : "The last fail before the newest fix, and the first pass after it.";
  }
  const pick = (col: (typeof cols)[number] | undefined, last: boolean): string | null => {
    if (!col) return null;
    const m = majorityOf(col.batch);
    const scored = col.reps.filter(graded);
    const wanted = m === null ? scored : scored.filter((r) => (r.status === "pass") === m);
    const pool = wanted.length ? wanted : scored.length ? scored : col.reps;
    return (last ? pool[pool.length - 1] : pool[0])?.id ?? null;
  };
  return { a: pick(cols[prev], true), b: pick(cols[target], false), flip, why };
}

const batchTime = (r: RunRowCore) => r.batchAt ?? r.stamp;

/**
 * The attribution launcher's endpoints for the pair on screen, read from the
 * freeze's own rows so a pick counts before its cards load: the earlier batch
 * is good and the later bad, whichever slot holds which. Two reps of one batch
 * name only the bad end and let the launcher find the good one. With nothing
 * picked, the default flip's batches.
 */
export function attributionEnds(pair: FreezePair, runs: RunRowCore[], pick: DefaultFreezePair): { good: string | null; bad: string | null } {
  const rows = [pair.a, pair.b].map((id) => runs.find((r) => r.id === id)).filter((r): r is RunRowCore => !!r?.batch);
  if (!rows.length) return { good: pick.flip?.before ?? null, bad: pick.flip?.batch ?? null };
  const [early, late] = [...rows].sort((x, y) => batchTime(x).localeCompare(batchTime(y)) || x.stamp.localeCompare(y.stamp));
  if (!late || early.batch === late.batch) return { good: null, bad: (late ?? early).batch };
  return { good: early.batch, bad: late.batch };
}

/** The cards' heading and the line beside it, true for the pair on screen: the default's reason, or the picked reps in words. */
export function pairStory(pair: FreezePair, pick: DefaultFreezePair, runs: RunRowCore[]): { title: string; why: string; isDefault: boolean; glyph: VerdictState } {
  const row = (id: string | null) => (id ? runs.find((r) => r.id === id) ?? null : null);
  const a = row(pair.a);
  const b = row(pair.b);
  // The pair's own verdicts: one each way is mixed, two alike take that verdict.
  const va = a ? verdictOfRow(a) : null;
  const vb = b ? verdictOfRow(b) : null;
  const glyph: VerdictState = va && vb ? (va === vb ? va : "mixed") : (va ?? vb ?? "unscored");
  if (pair.a === pick.a && pair.b === pick.b) {
    const title = pick.flip ? `Either side of the ${pick.flip.direction === "broke" ? "break" : "fix"}` : "Two reps side by side";
    return { title, why: pick.why, isDefault: true, glyph };
  }
  const isDefault = false;
  const said = (slot: "A" | "B", r: RunRowCore) => `${slot} is seed ${r.seed} from ${batchLabel(r.batch ?? r.stamp, r.batchAt)}, ${r.status}${r.score !== null ? ` ${score2(r.score)}` : ""}`;
  if (!a || !b) return { title: "Two reps you picked", why: a ? `${said("A", a)}. Click a dot to set B.` : b ? `${said("B", b)}. Click a dot to set A.` : "Click two dots to set A and B.", isDefault, glyph };
  const order = a.batch === b.batch ? "Both ran in one batch, so only the seed differs." : batchTime(a) > batchTime(b) ? "A is the later of the two." : "";
  return { title: "Two reps you picked", why: `${said("A", a)}; ${said("B", b)}.${order ? ` ${order}` : ""}`, isDefault, glyph };
}

/** What a rep answered: its sends, else its last call's reply, else what its agent said. */
export function replyOfRun(run: RunWithAnatomy): string | null {
  if (run.sends.length) return run.sends.map((s) => s.text).join("\n\n");
  const call = run.calls?.at(-1);
  if (call) return call.reply;
  const said = (run.agents ?? []).flatMap((a) => a.said);
  return said.length ? said.join("\n\n") : null;
}

/** The judge's most telling note: the reasoning of the lowest-scoring check that gave one. */
export function reasoningOfRun(run: RunResponse): string | null {
  const checks = (run.score?.checks ?? []).filter((c) => c.reasoning);
  if (!checks.length) return null;
  return [...checks].sort((x, y) => x.score - y.score)[0].reasoning ?? null;
}

/** Every rendered prompt file of two reps, as pairs: call system and prompt, agent prompt and follow-up turns. */
export function promptFilePairs(a: RunWithAnatomy, b: RunWithAnatomy): PromptFilePair[] {
  const files = (r: RunWithAnatomy) => {
    const out = new Map<string, string>();
    for (const c of r.calls ?? []) {
      if (c.system !== null) out.set(`${c.dir}/system.md`, c.system);
      out.set(`${c.dir}/prompt.md`, c.prompt);
    }
    for (const g of r.agents ?? []) {
      out.set(`${g.dir}/prompt.md`, g.prompt);
      g.then.forEach((t, i) => out.set(`${g.dir}/then${i + 2}.md`, t));
    }
    return out;
  };
  const fa = files(a);
  const fb = files(b);
  const names = [...new Set([...fa.keys(), ...fb.keys()])];
  return names.map((file) => ({ freezeId: a.row.freezeId, file, a: { runId: a.row.id, text: fa.get(file) ?? null }, b: { runId: b.row.id, text: fb.get(file) ?? null } }));
}

// ── Formatting ──────────────────────────────────────────────────────────────

export const dayLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** A strip tick names its day once; later ticks on the same day name their time, so an ordinal axis never reads "Oct 2, Oct 2, Oct 2". */
export function tickLabel(cols: { at: string }[], ticks: number[], k: number): string {
  const day = dayLabel(cols[ticks[k]].at);
  return k > 0 && dayLabel(cols[ticks[k - 1]].at) === day ? timeLabel(cols[ticks[k]].at) : day;
}

/** At this width and up the two panes sit side by side (40/60); below it the reps come first. */
export const FREEZE_WIDE_PX = 1080;
