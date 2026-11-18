// Whether production can read one change on a goal metric (flows.md FL10),
// from the reading every surface shows: metricReadings over the goal's live
// series, its window's level and 4-week MDE (cohort periods, pooling and the
// observed spread included). `cast climb experiment` sizes a test with it, and
// Gauge reads the card's plausible lift against it before the climb spends,
// so a climb whose top level cannot confirm one change says so on its card
// instead of proposing a read nobody can make.
import { CLIMB_EXPERIMENT_MAX_WEEKS, experimentWeeks } from "@codecast/shared/contracts/climb";
import { formatSeriesValue, metricReadings, type MetricReading } from "@codecast/shared/contracts/initiative";
import { MDE_WEEKS, mdeWords } from "@codecast/shared/contracts/metricStanding";
import { liveSeries } from "../initiativeCommand.js";

export type Readability = {
  metric: string;
  /** The card's plausible relative lift of one change on the metric (0.04 = 4%). */
  lift: number;
  /** The metric's level and what a 4-week 50/50 test detects there. */
  level: string;
  mde4: number;
  /** Weeks a 50/50 test needs to detect the lift, or null when no test within CLIMB_EXPERIMENT_MAX_WEEKS can. */
  weeks: number | null;
  readable: boolean;
  /** What stands in for the production read when it cannot be made. */
  evidence: string;
};

export class MetricUnread extends Error {}

/** One metric's reading on a goal row as `/cli/initiatives/get` serves it; throws MetricUnread with the reason when it has no MDE. */
export function readMetric(goal: any, key: string): MetricReading & { band: NonNullable<MetricReading["band"]> & { mde: number } } {
  const r = metricReadings(goal, liveSeries(goal)).find((x) => x.key === key || x.name === key);
  if (!r) throw new MetricUnread(`${goal?.short_id ?? "the goal"} has no metric ${key} (${(goal?.metrics ?? []).map((x: any) => x.key).join(", ") || "none"})`);
  const b = r.band;
  if (!b) throw new MetricUnread(`${key} is read without a window and a noise model, so no test can be sized from it (cast goal set --metric "... window 4w noise poisson")`);
  if (b.mde === null) throw new MetricUnread(`${key}'s reading has no detectable change to size a test from${b.note ? `: ${b.note}` : ""}`);
  return r as any;
}

const levelWords = (r: MetricReading & { band: NonNullable<MetricReading["band"]> }) => {
  const b = r.band;
  const level = r.unit ? formatSeriesValue(b.mean, r.unit) : String(Math.round(b.mean * 100) / 100);
  return `${level} (${b.pooling === "pooled" ? "pooled" : "mean"} over ${b.periods} ${b.cohort ? "cohort " : ""}${b.period}s, ${b.spread ?? "model"} spread)`;
};

/** How long a production test needs to read `lift` on a metric, in words (`cast climb experiment`). */
export function experimentWords(goal: any, key: string, lift: number): string {
  const r = readMetric(goal, key);
  const pct = `${(lift * 100).toFixed(0)}%`;
  const weeks = experimentWeeks(r.band.mde, r.noise, lift);
  const four = `${MDE_WEEKS} weeks detect ${mdeWords(r.band.mde)}`;
  return weeks === null
    ? `${r.key} at ${levelWords(r)}: a 50/50 test cannot detect ${pct} within ${CLIMB_EXPERIMENT_MAX_WEEKS} weeks (${four})`
    : `${r.key} at ${levelWords(r)}: a 50/50 test detects ${pct} in ${weeks} week${weeks === 1 ? "" : "s"} (${four})`;
}

/** Whether production can confirm one change of the card's plausible lift on the metric. */
export function readability(goal: any, key: string, lift: number): Readability {
  const r = readMetric(goal, key);
  const weeks = experimentWeeks(r.band.mde, r.noise, lift);
  const readable = weeks !== null;
  return {
    metric: r.key, lift, level: levelWords(r), mde4: r.band.mde, weeks, readable,
    evidence: readable
      ? `a ${weeks}-week holdout read on ${r.key}`
      : `the held split's result, and the predictions read back over many climbs (cast goal show ${goal?.short_id ?? "<in-N>"}, Predictions): no production read can confirm one change of +${(lift * 100).toFixed(0)}% on ${r.key}, which detects ${mdeWords(r.band.mde)} in ${MDE_WEEKS} weeks`,
  };
}
