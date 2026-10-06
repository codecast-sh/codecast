// What the home wall decides (evals-ui.md 4.1): row order, the worse pair
// and its links, the shared time window and the What moved lines. Pure,
// beside SurfaceWallView.

import type { OverviewResponse, SurfaceOverview, MovedEvent } from "../../contract";
import type { EvalsHrefs } from "../paths";
import { DAY_MS, dayList, dayStart, linear, timeAxisLabels } from "./scale";
import { newestBaseline } from "./verdictModel";
import { plural, shortModel, shortRuler } from "./format";

/** All first: the agent surfaces and most call batches carry no cadence, so a nightly default would hide them. */
export const WALL_CADENCES = [
  { key: "all", label: "All" },
  { key: "nightly", label: "Nightly" },
  { key: "named", label: "By hand" },
] as const;
export const DEFAULT_WALL_CADENCE = "all";

export const isWorse = (s: SurfaceOverview) => s.latest?.separation.kind === "worse";
const latestAt = (s: SurfaceOverview) => (s.latest ? Date.parse(s.latest.set.batchAt) : 0);

/** The wall's order: rows that separated worse first (newest first), then call surfaces, then agent surfaces, each in the api's order. */
export function wallOrder<S extends SurfaceOverview>(surfaces: readonly S[]): S[] {
  const rank = (s: SurfaceOverview) => (isWorse(s) ? 0 : s.route === "call" ? 1 : 2);
  return surfaces
    .map((s, i) => ({ s, i }))
    .sort((a, b) => rank(a.s) - rank(b.s) || (rank(a.s) === 0 ? latestAt(b.s) - latestAt(a.s) : 0) || a.i - b.i)
    .map((x) => x.s);
}

/**
 * A worse row's pair: its latest batch as the bad end and the newest batch of
 * its baseline as the good end. Null when the row did not separate worse.
 */
export function worsePair(s: SurfaceOverview): { surface: string; good: string | null; bad: string } | null {
  if (!isWorse(s) || !s.latest) return null;
  return { surface: s.id, good: newestBaseline(s.latest, s.strip), bad: s.latest.batch };
}

/** The newest worse pair on the wall: the surface whose latest batch separated worse most recently. Null when nothing did. */
export function newestWorsePair(surfaces: readonly SurfaceOverview[]): { surface: string; good: string | null; bad: string } | null {
  const worse = surfaces.filter(isWorse).sort((a, b) => latestAt(b) - latestAt(a))[0];
  return worse ? worsePair(worse) : null;
}

/** Where a row opens: a worse row lands with its red batch and that batch's baseline pinned, so the surface page opens on the comparison the wall made. */
export function rowHref(href: EvalsHrefs, s: SurfaceOverview): string {
  const pair = worsePair(s);
  return pair ? href.surface(s.id, { batch: pair.bad, compare: pair.good }) : href.surface(s.id);
}

/** Where `b` goes: the newest worse pair, else the launcher for the selected surface, which picks its own red batch. */
export function attributeHref(href: EvalsHrefs, surfaces: readonly SurfaceOverview[], selected: string | null): string {
  const pair = newestWorsePair(surfaces);
  if (pair) return href.bisectNew(pair);
  return href.bisectNew({ surface: selected });
}

// ── The wall ────────────────────────────────────────────────────────────────

const MAX_WINDOW_DAYS = 30;
const MIN_WINDOW_DAYS = 2;

/**
 * Where the shared axis starts: just before the oldest batch on the wall
 * (the oldest spend day when there is none), kept between 2 and 30 days
 * before now. A home whose runs span four days would otherwise draw every
 * strip in the last eighth of its width.
 */
export function wallWindowFrom(data: Pick<OverviewResponse, "surfaces" | "spendByDay">, now: number): number {
  const widest = now - MAX_WINDOW_DAYS * DAY_MS;
  const narrowest = now - MIN_WINDOW_DAYS * DAY_MS;
  let oldest = Infinity;
  for (const s of data.surfaces) for (const b of s.strip) oldest = Math.min(oldest, Date.parse(b.batchAt));
  // Spend is kept per day, so it places the window only when no batch can.
  if (!Number.isFinite(oldest)) for (const d of data.spendByDay) oldest = Math.min(oldest, dayStart(d.day));
  if (!Number.isFinite(oldest)) return widest;
  // A margin of 3% of the span keeps the oldest batch off the strip's edge.
  return Math.min(narrowest, Math.max(widest, oldest - (now - oldest) * 0.03));
}

/**
 * What the wall says it spent: every day of spendByDay that reaches into the
 * window (the days the spend strip draws), over the window's length in whole
 * days. One value, read by the header and the spend row alike.
 */
export function wallSpend(days: OverviewResponse["spendByDay"], from: number, to: number): { usd: number; days: number } {
  const usd = days.filter((d) => dayStart(d.day) + DAY_MS > from && dayStart(d.day) <= to).reduce((t, d) => t + d.usd + d.judgeUsd, 0);
  return { usd, days: wallWindowDays(from, to) };
}

/** The window's length in whole days, as every wall label says it. */
export const wallWindowDays = (from: number, to: number) => Math.max(1, Math.round((to - from) / DAY_MS));

/** The widest axis label ("Sep 29", six 11px mono characters) plus a gutter, so daily ticks in a narrow pane drop labels instead of overlapping. */
export const WALL_AXIS_LABEL_GAP = 48;

/** The date labels over the strip column: the strip's own x scale, one label at most every WALL_AXIS_LABEL_GAP px. */
export function wallAxisTicks(from: number, to: number, stripWidth: number): { label: string; x: number }[] {
  const days = dayList(from, to);
  const x = linear(from, to, 2, Math.max(stripWidth, 40) - 2);
  // The first day began before the window does; its midnight sits left of the strip.
  return timeAxisLabels(days, (i) => x(dayStart(days[i])), WALL_AXIS_LABEL_GAP).filter((t) => t.x >= 0);
}

const OUTCOME_WORDS: Record<string, string> = {
  culprit: "named a culprit commit",
  range: "narrowed to a range",
  drift: "found drift, not source",
  attribution: "answered from the records",
  unreplayable: "found uncommitted edits it cannot replay",
};

/** Where a What moved line goes, and what it says. */
export type MovedLine = { href: string; text: string };

/**
 * Where an event's line goes, and what it says. A host's own kinds (the
 * second parameter of OverviewResponse) are drawn by `own`, whose line comes
 * back as it made it, so a host's extra fields (codecast's mark) reach the
 * view (codecast: a sim failure opens its sim run, through the host's wall
 * slot).
 */
export function movedLine<M = never, L extends MovedLine = MovedLine>(href: EvalsHrefs, e: MovedEvent | M, own?: (e: M) => L): MovedLine | L {
  const n = e as MovedEvent;
  const s = n.surface ?? "";
  switch (n.kind) {
    case "epoch":
      return { href: href.surface(s, { batch: n.batch }), text: `${s} began prompt epoch e${n.epoch}, ${plural(n.changedFreezes, "freeze")} rendered anew` };
    case "footing":
      return n.change === "model"
        ? { href: href.surface(s, { batch: n.batch }), text: `${s} moved model, ${shortModel(n.from)} to ${shortModel(n.to)}` }
        : { href: href.surface(s, { batch: n.batch }), text: `${s} judge ruler moved, ${shortRuler(n.from)} to ${shortRuler(n.to)}` };
    case "flips": {
      const parts = [n.broke ? `${plural(n.broke, "freeze")} broke` : null, n.fixed ? `${n.fixed} fixed` : null, n.noise ? `${plural(n.noise, "flip")} on flapping freezes or an unchanged prompt` : null].filter(Boolean);
      return { href: href.surface(s, { batch: n.batch }), text: `${s}: ${parts.join(", ") || "freezes flipped"}` };
    }
    case "bisect":
      return { href: href.bisect(n.id), text: `Bisect on ${s} ${n.outcome ? OUTCOME_WORDS[n.outcome] ?? "finished" : "stopped without an answer"}` };
    default:
      return own ? own(e as M) : { href: href.home(), text: `${s || "The evals"} moved` };
  }
}
