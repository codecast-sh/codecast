// The Problems home (line-workspace.md LW1 Problems): every problem in view
// on one time axis, the way an error tracker opens its issue stream. One
// window (24h, 7d, 30d) that the chart and every row's sparkline share; the
// findings per bucket stacked by problem (the busiest few colored, the rest
// together); what came back after a close; the closes and shipped fixes as
// markers; and where each problem's fix stands, in a word or two. Pure.
import { alignDown, bucketCounts, comebackTimes, DAY, HOUR, lowerBound, neverShipped } from "./timeline";
import type { LineIssue } from "./lineModel";

export type OverviewRange = "24h" | "7d" | "30d";
export const OVERVIEW_RANGES: ReadonlyArray<OverviewRange> = ["24h", "7d", "30d"];
const SPAN: Record<OverviewRange, number> = { "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY };
const STEP: Record<OverviewRange, number> = { "24h": HOUR, "7d": 3 * HOUR, "30d": 12 * HOUR };

/** The window every mark of the home shares: [d0, d1) in buckets of `step`, ending at the next whole bucket after now. */
export type OverviewWindow = { range: OverviewRange; d0: number; d1: number; step: number; n: number };

export function overviewWindow(range: OverviewRange, now: number): OverviewWindow {
  const step = STEP[range];
  // Aligned to the bucket, so the bars move once a bucket rather than with the clock.
  const d1 = alignDown(now, step) + step;
  const d0 = alignDown(d1 - SPAN[range], step);
  return { range, d0, d1, step, n: Math.round((d1 - d0) / step) };
}

/** The colors the busiest problems take, in order; every other problem is gray. */
export const TOP_PROBLEMS = 6;

export type OverviewProblem = { id: string; ref: string | null; title: string; n: number; slot: number };
export type OverviewBucket = { i: number; from: number; to: number; total: number; byTop: number[]; other: number; back: number };
export type OverviewMarker = { at: number; kind: "ship" | "close"; problemId: string; ref: string | null; title: string; words: string };

export type Overview = {
  win: OverviewWindow;
  buckets: OverviewBucket[];
  top: OverviewProblem[];
  /** Findings in the window outside the top problems, and how many problems they belong to. */
  other: { n: number; problems: number };
  total: number;
  back: number;
  max: number;
  markers: OverviewMarker[];
};

type IssueLike = Pick<LineIssue, "id" | "ref" | "title" | "history">;

const occTimes = (i: IssueLike) => i.history.occurrences.map((o) => o.at);

/** Findings of one problem inside [from, to). */
export function countIn(i: IssueLike, from: number, to: number): number {
  const t = occTimes(i);
  return lowerBound(t, to) - lowerBound(t, from);
}

/**
 * The whole chart from the problems in view: per bucket the findings of each
 * top problem, the rest together, and how many of them came back after a
 * close; and every close and shipped fix in the window as a marker.
 */
export function buildOverview(issues: ReadonlyArray<IssueLike>, win: OverviewWindow): Overview {
  const counted = issues.map((i) => ({ i, n: countIn(i, win.d0, win.d1) })).filter((x) => x.n > 0);
  counted.sort((a, b) => b.n - a.n || (a.i.ref ?? a.i.id).localeCompare(b.i.ref ?? b.i.id));
  const topRows = counted.slice(0, TOP_PROBLEMS);
  const top: OverviewProblem[] = topRows.map((x, slot) => ({ id: x.i.id, ref: x.i.ref ?? null, title: x.i.title, n: x.n, slot }));
  const topSet = new Set(top.map((t) => t.id));
  const buckets: OverviewBucket[] = Array.from({ length: win.n }, (_, i) => ({ i, from: win.d0 + i * win.step, to: win.d0 + (i + 1) * win.step, total: 0, byTop: new Array(top.length).fill(0), other: 0, back: 0 }));
  let otherN = 0;
  let back = 0;
  for (const { i } of counted) {
    const counts = bucketCounts(occTimes(i), win.d0, win.d1, win.step);
    const slot = top.findIndex((t) => t.id === i.id);
    counts.forEach((c, k) => {
      if (!c || !buckets[k]) return;
      buckets[k].total += c;
      if (slot >= 0) buckets[k].byTop[slot] += c;
      else { buckets[k].other += c; otherN += c; }
    });
    bucketCounts(comebackTimes(i.history), win.d0, win.d1, win.step).forEach((c, k) => { if (c && buckets[k]) { buckets[k].back += c; back += c; } });
  }
  const markers: OverviewMarker[] = [];
  for (const i of issues) {
    const h = i.history;
    for (const s of h.ships) {
      const at = s.deploys[0]?.at ?? s.merge?.at ?? s.at;
      if (at < win.d0 || at >= win.d1) continue;
      const attempt = h.attempts.find((a) => a.runId === s.runId);
      // A run that went past an unanswered card with nothing merged or deployed shipped nothing: no mark.
      if (neverShipped(attempt, s)) continue;
      const n = attempt?.n;
      markers.push({ at, kind: "ship", problemId: i.id, ref: i.ref ?? null, title: i.title, words: `fix from run #${n ?? "?"} ${s.deploys.length ? "deployed" : s.merge ? "merged" : "shipped"}` });
    }
    for (const c of h.closes) {
      if (c.kind === "shipped" || c.at < win.d0 || c.at >= win.d1) continue;
      markers.push({ at: c.at, kind: "close", problemId: i.id, ref: i.ref ?? null, title: i.title, words: `run #${c.n} closed it without a change (${c.kind})` });
    }
  }
  markers.sort((a, b) => a.at - b.at);
  const total = buckets.reduce((n, b) => n + b.total, 0);
  return {
    win, buckets, top,
    other: { n: otherN, problems: counted.length - topSet.size },
    total, back,
    max: Math.max(1, ...buckets.map((b) => b.total)),
    markers,
  };
}

/** What the chart narrows the list to: a span brushed or clicked, or one problem's band. */
export type OverviewFocus = { kind: "range"; from: number; to: number } | { kind: "problem"; id: string };

/** Whether a problem stays in the list under a focus: one with a finding in the span, or the problem itself. */
export function inFocus(i: IssueLike, f: OverviewFocus | null): boolean {
  if (!f) return true;
  return f.kind === "problem" ? i.id === f.id : countIn(i, f.from, f.to) > 0;
}

/** Distinct conversations among findings in a window (`key` is findingConversation), per problem. */
export function conversationsByProblem<S extends { task_id: string; observed_at?: number; created_at?: number }>(signals: ReadonlyArray<S>, key: (s: S) => string, from: number, to: number): Map<string, number> {
  const sets = new Map<string, Set<string>>();
  for (const s of signals) {
    const at = s.observed_at || s.created_at || 0;
    if (!s.task_id || at < from || at >= to) continue;
    let set = sets.get(s.task_id);
    if (!set) { set = new Set(); sets.set(s.task_id, set); }
    set.add(key(s));
  }
  return new Map([...sets].map(([k, v]) => [k, v.size]));
}

// ── where the fix stands ─────────────────────────────────────────────────────

/** Where a problem's fix stands, as the Fix column says it. */
export type FixStand = "waiting" | "building" | "shipped" | "unshipped" | "answered" | "none";

export const FIX_WORDS: Record<FixStand, string> = {
  waiting: "For you",
  building: "Being built",
  shipped: "Shipped",
  unshipped: "Not shipped",
  answered: "Answered",
  none: "None yet",
};

/** A decision or trial card waiting on the owner about this problem, as the Fix column needs it. */
export type WaitingFix = { ref: string; trial: boolean };

/**
 * Where the fix stands: a decision waiting on you wins; then a run building
 * one; then a fix that went out (merged, shipped or deployed); then a fix that
 * ran past an unanswered card and shipped nothing; then a card you
 * answered whose fix has not gone out (a trial run records it and ships
 * nothing); else none yet.
 */
export function fixStand(issue: Pick<LineIssue, "history">, waiting: WaitingFix | null | undefined): FixStand {
  if (waiting) return "waiting";
  const h = issue.history;
  if (h.attempts.some((a) => a.live)) return "building";
  // A fix went out when a run merged or deployed it, or shipped it with its card answered. A run that only went on
  // past an unanswered card shipped nothing (timeline neverShipped): the Inbox lists it under "Not shipped: no answer".
  const shipOf = (runId: string) => h.ships.find((s) => s.runId === runId);
  const tried = h.attempts.filter((a) => a.ended === "shipped" || a.merge || shipOf(a.runId));
  if (tried.some((a) => !neverShipped(a, shipOf(a.runId))) || h.ships.some((s) => !h.attempts.some((a) => a.runId === s.runId))) return "shipped";
  if (tried.length) return "unshipped";
  if (h.attempts.some((a) => a.card?.answer)) return "answered";
  return "none";
}
