/**
 * Completion over time, from the timestamps tasks already carry.
 *
 * Three cumulative series, the same three Linear plots:
 *   scope     — how much work exists (tasks created, minus dropped)
 *   started   — how much has been picked up
 *   done      — how much has landed
 *
 * Reading them together is the point. Done climbing toward a flat scope is a
 * project finishing; scope climbing as fast as done is a project discovering
 * work as fast as it completes it, which no single percentage would show you.
 *
 * Pure and store-free so it can be tested directly.
 */

export type ProgressPoint = { t: number; scope: number; started: number; done: number };

export type ProgressSeries = {
  points: ProgressPoint[];
  /** Totals as of now — the same numbers the header counts show. */
  scope: number;
  started: number;
  done: number;
  /** Sorted completion timestamps (≤ now), for pace math that must not
   *  inherit the chart's bucket widths. */
  doneTimes: number[];
};

type TaskLike = {
  status?: string;
  created_at?: number;
  started_at?: number;
  closed_at?: number;
};

/** Most points we draw. Beyond this the buckets widen instead — a chart with a
 *  point per pixel is noise, and the shape is what carries the meaning. */
const MAX_POINTS = 60;
const DAY = 86_400_000;

/**
 * When a task began. A task that closed must have started, so a missing
 * `started_at` falls back to its close time — otherwise the done line could
 * cross above the started line, which would be a drawing of a lie.
 */
function startedTime(task: TaskLike): number | undefined {
  return task.started_at ?? task.closed_at ?? undefined;
}

/** When a task landed. Dropped work closes too, but it did not get done. */
function doneTime(task: TaskLike): number | undefined {
  return task.status === "done" ? task.closed_at : undefined;
}

export type BurndownPoint = { t: number; remaining: number };

export type Burndown = {
  /** Historical remaining work (scope − done), one point per progress bucket. */
  points: BurndownPoint[];
  /** Remaining as of now. */
  remaining: number;
  /** Completions per day, measured over the recent window. */
  velocity: number;
  /** When remaining hits zero at the current velocity. Absent when velocity is zero. */
  projectedEnd?: number;
  deadline?: number;
  /**
   * done — nothing remains. hit/miss — the projection lands before/after the
   * deadline. no_velocity — work remains but nothing finished recently, so
   * there is no honest line to draw. no_deadline — a projection exists but
   * there is no date to judge it against.
   */
  verdict: "done" | "hit" | "miss" | "no_velocity" | "no_deadline";
};

/** How far back completions count toward the pace. Two weeks: long enough to
 *  smooth a quiet weekend, short enough that an old sprint cannot flatter a
 *  stalled project. */
const VELOCITY_WINDOW = 14 * DAY;

export function buildBurndown(
  series: ProgressSeries,
  deadline: number | undefined,
  now: number,
): Burndown {
  const points: BurndownPoint[] = series.points.map((p) => ({
    t: p.t,
    remaining: p.scope - p.done,
  }));
  // Anchor "remaining" to the series' last point so the projection hinges
  // exactly where the drawn line ends — a task closed with a future timestamp
  // (client clock skew) must not open a gap between the two.
  const remaining = points.length
    ? points[points.length - 1].remaining
    : series.scope - series.done;

  // Pace from the raw completion timestamps, not the bucketed points — an old
  // project's buckets are weeks wide, and snapping the window to a bucket edge
  // would count month-old completions as recent pace. A younger project
  // measures over its whole life.
  let velocity = 0;
  if (series.points.length) {
    const windowStart = Math.max(now - VELOCITY_WINDOW, series.points[0].t);
    const recentDone = series.doneTimes.filter((t) => t > windowStart && t <= now).length;
    const spanDays = Math.max((now - windowStart) / DAY, 1);
    velocity = recentDone / spanDays;
  }

  const base = { points, remaining, velocity, deadline };
  if (remaining <= 0 && series.scope > 0) return { ...base, verdict: "done" };
  if (velocity <= 0) return { ...base, verdict: "no_velocity" };
  const projectedEnd = now + (remaining / velocity) * DAY;
  if (deadline === undefined) return { ...base, projectedEnd, verdict: "no_deadline" };
  return { ...base, projectedEnd, verdict: projectedEnd <= deadline ? "hit" : "miss" };
}

export function buildProgressSeries(tasks: TaskLike[], now: number): ProgressSeries {
  // Dropped work leaves scope entirely rather than counting as never-finished —
  // a cancelled task is not a debt, and leaving it in makes every project look
  // permanently behind.
  const live = tasks.filter((t) => t.status !== "dropped" && typeof t.created_at === "number");

  const doneTimes = live
    .map(doneTime)
    .filter((v): v is number => v !== undefined && v <= now)
    .sort((a, b) => a - b);
  const totals = {
    scope: live.length,
    started: live.filter((t) => startedTime(t) !== undefined).length,
    done: live.filter((t) => doneTime(t) !== undefined).length,
    doneTimes,
  };
  if (live.length === 0) return { points: [], ...totals };

  const first = Math.min(...live.map((t) => t.created_at as number));
  const span = Math.max(now - first, DAY);
  // A day per point until the project outgrows the budget, then wider buckets.
  const step = Math.max(DAY, Math.ceil(span / MAX_POINTS / DAY) * DAY);

  const created = live.map((t) => t.created_at as number).sort((a, b) => a - b);
  const started = live.map(startedTime).filter((v): v is number => v !== undefined).sort((a, b) => a - b);
  const done = doneTimes;

  // Each series is sorted, so one walking index per series counts everything at
  // or before the current bucket without rescanning the list per point.
  let ci = 0, si = 0, di = 0;
  const points: ProgressPoint[] = [];
  for (let t = first; t < now + step; t += step) {
    const at = Math.min(t, now);
    while (ci < created.length && created[ci] <= at) ci++;
    while (si < started.length && started[si] <= at) si++;
    while (di < done.length && done[di] <= at) di++;
    points.push({ t: at, scope: ci, started: si, done: di });
    if (at === now) break;
  }
  return { points, ...totals };
}
