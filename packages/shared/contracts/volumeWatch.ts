// Volume watches (X7): numbers codecast already holds about a source, watched
// like any polled metric. A source that sends errors, logs or CI runs gets a
// series without asking anything outside: its events per hour (the door's
// hour counter), one named event per hour, issues first seen in the last day,
// and issues open now; a CI source adds its runs' failure rate and their
// duration at the median and the 95th percentile, over the trailing day.
// The server polls them from its own tables
// (metrics.volumeRead) and backfills what the counters reach; the New watch
// sheet previews them from the same counters on the client. One rule for
// both, here.

/** The series a volume watch reads. */
export const VOLUME_SERIES = ["events", "new_issues", "open_issues", "ci_failure_rate", "ci_duration_p50", "ci_duration_p95"] as const;
export type VolumeSeries = (typeof VOLUME_SERIES)[number];

export type VolumeQuery = { series: VolumeSeries; event?: string };

const EVENT_NAME = /^[^\s:][^\n]{0,199}$/;

/** The series read from a CI source's finished runs (VolumeInput.ci_runs). */
export const CI_RUN_SERIES = ["ci_failure_rate", "ci_duration_p50", "ci_duration_p95"] as const satisfies readonly VolumeSeries[];
export const isCiRunSeries = (s: VolumeSeries): boolean => (CI_RUN_SERIES as readonly string[]).includes(s);

/** A volume watch's query read back: `events`, `events:<name>`, `new_issues`, `open_issues`, or a CI run series. */
export function parseVolumeQuery(query: string): VolumeQuery | { error: string } {
  const q = query.trim();
  if ((VOLUME_SERIES as readonly string[]).includes(q)) return { series: q as VolumeSeries };
  const m = /^events:(.+)$/.exec(q);
  if (m && EVENT_NAME.test(m[1].trim())) return { series: "events", event: m[1].trim() };
  return { error: "A volume watch reads events, events:<name>, new_issues, open_issues, ci_failure_rate, ci_duration_p50 or ci_duration_p95" };
}

export function volumeQueryText(q: VolumeQuery): string {
  return q.event ? `events:${q.event}` : q.series;
}

/** How each series names itself, by what the source sends: CI runs are runs and failures, everything else events and issues. */
export function volumeLabel(q: VolumeQuery, ci: boolean): string {
  if (q.series === "events") return q.event ? `${q.event} per hour` : ci ? "Runs per hour" : "Events per hour";
  if (q.series === "new_issues") return ci ? "New failures, 24h" : "New issues, 24h";
  if (q.series === "ci_failure_rate") return "Failed runs, 24h";
  if (q.series === "ci_duration_p50") return "Run time p50, 24h";
  if (q.series === "ci_duration_p95") return "Run time p95, 24h";
  return ci ? "Failing checks" : "Open issues";
}

/** The unit a series reads in: per hour, a share, minutes, or a plain count. */
export function volumeUnit(q: VolumeQuery): string | null {
  if (q.series === "events") return "/h";
  if (q.series === "ci_failure_rate") return "%";
  if (q.series === "ci_duration_p50" || q.series === "ci_duration_p95") return "min";
  return null;
}

/** One finished CI run as the source keeps it: when it started, whether it passed, and how long it ran. */
export type CiRunFact = { at: number; ok: boolean; duration_ms?: number };

/** How many runs a CI source keeps (event_source_stats.ci_runs), newest last, and how far back. */
export const CI_RUNS_KEPT = 600;
export const CI_RUNS_DAYS = 30;

/** A run added to the kept list: in start order, cut to CI_RUNS_KEPT and to CI_RUNS_DAYS before the newest run. */
export function withCiRun(runs: readonly CiRunFact[] | undefined, run: CiRunFact): CiRunFact[] {
  const all = [...(runs ?? []), run].sort((a, b) => a.at - b.at);
  const cutoff = all[all.length - 1].at - CI_RUNS_DAYS * DAY;
  return all.filter((r) => r.at > cutoff).slice(-CI_RUNS_KEPT);
}

/**
 * Runs read back from GitHub merged into the kept list. A run the webhook
 * already kept (same start, result and length) is not kept twice; the cut
 * is withCiRun's.
 */
export function withCiRuns(runs: readonly CiRunFact[] | undefined, added: readonly CiRunFact[]): CiRunFact[] {
  const key = (r: CiRunFact) => `${r.at}:${r.ok}:${r.duration_ms ?? ""}`;
  const seen = new Map<string, CiRunFact>();
  for (const r of [...(runs ?? []), ...added]) if (!seen.has(key(r))) seen.set(key(r), r);
  const all = [...seen.values()].sort((a, b) => a.at - b.at);
  if (!all.length) return [];
  const cutoff = all[all.length - 1].at - CI_RUNS_DAYS * DAY;
  return all.filter((r) => r.at > cutoff).slice(-CI_RUNS_KEPT);
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** What the counters and groups hold, as both sides read them. */
export type VolumeInput = {
  now: number;
  /** The hour counter, hour starts in epoch ms (event_source_stats.hours). */
  hours?: ReadonlyArray<{ hour: number; events: number }>;
  /** Per-event hour buckets (event_source_stats.event_names). */
  event_names?: ReadonlyArray<{ name: string; buckets: ReadonlyArray<{ hour: number; count: number }> }>;
  /** The source's groups seen in the last 30 days: when each was first seen, and whether it is open. */
  groups?: ReadonlyArray<{ first_seen: number; status: string }>;
  /** Open groups by the source's own counter, when the groups were not read. */
  groups_open?: number;
  /** A CI source's finished runs (event_source_stats.ci_runs). */
  ci_runs?: ReadonlyArray<CiRunFact>;
};

/** A CI series over the runs that started in the day before `end`: the failed share in percent, or a run time percentile in minutes. Null with no runs (or no timed runs). */
function ciValue(series: VolumeSeries, runs: ReadonlyArray<CiRunFact>, end: number): number | null {
  const day = runs.filter((r) => r.at > end - DAY && r.at <= end);
  if (series === "ci_failure_rate") return day.length ? Math.round((day.filter((r) => !r.ok).length / day.length) * 1000) / 10 : null;
  const ds = day.map((r) => r.duration_ms).filter((d): d is number => typeof d === "number" && d >= 0).sort((a, b) => a - b);
  if (!ds.length) return null;
  const f = series === "ci_duration_p95" ? 0.95 : 0.5;
  const v = ds[Math.min(ds.length - 1, Math.ceil(f * ds.length) - 1)];
  return Math.round((v / 60_000) * 10) / 10;
}

/** The last complete hour's start: the hour a poll reads, so a half-counted hour never reads as a drop. */
export function lastFullHour(now: number): number {
  return Math.floor(now / HOUR) * HOUR - HOUR;
}

function hourCounts(q: VolumeQuery, input: VolumeInput): Map<number, number> {
  const out = new Map<number, number>();
  if (q.event) {
    for (const b of input.event_names?.find((e) => e.name === q.event)?.buckets ?? []) out.set(b.hour, (out.get(b.hour) ?? 0) + b.count);
  } else {
    for (const h of input.hours ?? []) out.set(h.hour, h.events);
  }
  return out;
}

/** The series' value now: the last complete hour's count, the issues first seen in the last 24h, or the issues open. */
export function volumeValue(q: VolumeQuery, input: VolumeInput): number {
  if (isCiRunSeries(q.series)) return ciValue(q.series, input.ci_runs ?? [], input.now) ?? 0;
  if (q.series === "events") return hourCounts(q, input).get(lastFullHour(input.now)) ?? 0;
  if (q.series === "new_issues") return (input.groups ?? []).filter((g) => g.first_seen > input.now - DAY && g.first_seen <= input.now).length;
  return input.groups ? input.groups.filter((g) => g.status === "open").length : input.groups_open ?? 0;
}

/**
 * The series' past as dated points, oldest first, as far as the data
 * reaches: every hour the counter holds (an hour with nothing counted reads
 * zero, from the counter's first hour on), and for new issues the 24h count
 * at the end of each of the last `days` days. Open issues has no past.
 */
export function volumeHistory(q: VolumeQuery, input: VolumeInput, days = 30): Array<{ at: number; value: number }> {
  if (q.series === "events") {
    const counts = hourCounts(q, input);
    const holds = q.event ? [...counts.keys()] : (input.hours ?? []).map((h) => h.hour);
    if (!holds.length) return [];
    const first = Math.min(...holds);
    const out: Array<{ at: number; value: number }> = [];
    // Each hour is dated at its end, the moment a poll would have read it.
    for (let h = first; h <= lastFullHour(input.now); h += HOUR) out.push({ at: h + HOUR, value: counts.get(h) ?? 0 });
    return out;
  }
  if (isCiRunSeries(q.series)) {
    // The trailing day at the end of each day the runs reach, as new issues reads; a day with no runs has no value.
    const runs = input.ci_runs ?? [];
    if (!runs.length) return [];
    const today = Math.floor(input.now / DAY) * DAY;
    const out: Array<{ at: number; value: number }> = [];
    for (let at = Math.max(today - (days - 1) * DAY, Math.floor(runs[0].at / DAY) * DAY + DAY); at <= today; at += DAY) {
      const v = ciValue(q.series, runs, at);
      if (v !== null) out.push({ at, value: v });
    }
    return out;
  }
  if (q.series === "new_issues") {
    const firsts = (input.groups ?? []).map((g) => g.first_seen).sort((a, b) => a - b);
    const today = Math.floor(input.now / DAY) * DAY;
    const out: Array<{ at: number; value: number }> = [];
    for (let d = days; d >= 1; d--) {
      const at = today - (d - 1) * DAY;
      out.push({ at, value: firsts.filter((f) => f > at - DAY && f <= at).length });
    }
    return out;
  }
  return [];
}
