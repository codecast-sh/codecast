// The group upsert's rule set (docs/architecture/external-data.md X3): how an
// ingested item becomes a group occurrence, how 72 hourly buckets roll, and
// which occurrences are transitions. Only a transition writes an
// external_events row, fires a trigger and may promote; every other
// occurrence only moves counts, so a flood costs one patch per group.
//
// Pure: the mutation in ingest.ts reads and writes rows, this decides. A leaf
// with shared imports only, so convex loads it without a cycle.
import {
  GROUP_RULES,
  INGEST_LIMITS,
  isGroupedLogLevel,
  type GroupKind,
  type GroupStatus,
  type IngestItem,
  type IngestUser,
  type Transition,
} from "@codecast/shared/contracts/ingest";
import {
  checkFingerprint,
  groupFingerprint,
  jobFingerprint,
  metricFingerprint,
  sdkErrorFingerprint,
  topInAppFrame,
} from "@codecast/shared/contracts/signalFingerprint";

export const HOUR_MS = 3600_000;
const TRAILING_HOURS = 24;

/** Samples one batch may add to one group. The cap per group is GROUP_RULES.samples_per_group. */
export const SAMPLES_PER_BATCH = 5;

export type Bucket = { hour: number; count: number };

export function hourStart(at: number): number {
  return Math.floor(at / HOUR_MS) * HOUR_MS;
}

/** The UTC day (yyyy-mm-dd) a source's *_today counters count. */
export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** The oldest hour the window still holds, relative to now. */
function oldestHour(now: number): number {
  return hourStart(now) - (GROUP_RULES.bucket_hours - 1) * HOUR_MS;
}

/** Buckets inside the window, oldest first. */
export function pruneBuckets(buckets: Bucket[], now: number): Bucket[] {
  const oldest = oldestHour(now);
  return buckets.filter((b) => b.hour >= oldest);
}

/**
 * The buckets with `n` more occurrences in the hour of `at`, pruned to the
 * window. An occurrence older than the window is counted on the group but
 * has no hour left to land in.
 */
export function addToBuckets(buckets: Bucket[], at: number, n: number, now: number): Bucket[] {
  const out = pruneBuckets(buckets, now).map((b) => ({ ...b }));
  const hour = hourStart(at);
  if (hour < oldestHour(now) || n <= 0) return out;
  const hit = out.find((b) => b.hour === hour);
  if (hit) hit.count += n;
  else out.push({ hour, count: n });
  return out.sort((a, b) => a.hour - b.hour);
}

export function bucketCount(buckets: Bucket[], hour: number): number {
  return buckets.find((b) => b.hour === hour)?.count ?? 0;
}

/** Mean occurrences per hour over the 24 hours before `hour`. Empty hours count as zero. */
export function trailingMean(buckets: Bucket[], hour: number): number {
  const from = hour - TRAILING_HOURS * HOUR_MS;
  let sum = 0;
  for (const b of buckets) if (b.hour >= from && b.hour < hour) sum += b.count;
  return sum / TRAILING_HOURS;
}

/** The numeric parts of a release ("v1.2.3", "app@2.0.1+42" → [1,2,3], [2,0,1]), or null when it has none. */
function releaseParts(release: string): number[] | null {
  const m = /\d+(?:\.\d+)*/.exec(release);
  return m ? m[0].split(".").map(Number) : null;
}

/**
 * Whether `release` is known to be older than `than`. Releases without
 * comparable numbers are never "older": an unknown order counts as newer,
 * which is the side that announces a regression rather than hides one.
 */
export function isOlderRelease(release: string, than: string): boolean {
  if (release === than) return false;
  const a = releaseParts(release);
  const b = releaseParts(than);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return false;
}

// ── The state machine ──

/** The fields of an event_groups row the rules read and write. */
export interface GroupState {
  kind: GroupKind;
  status: GroupStatus;
  count: number;
  first_seen: number;
  last_seen: number;
  buckets: Bucket[];
  first_release?: string;
  last_release?: string;
  resolved_at?: number;
  resolved_in?: string;
  regressed_at?: number;
  last_transition?: Transition;
  last_transition_at?: number;
  meta?: { ok?: boolean };
}

export interface Occurrence {
  kind: GroupKind;
  at: number;
  release?: string;
  /** A check's reported state. */
  ok?: boolean;
}

export interface TransitionAt {
  transition: Transition;
  at: number;
}

function coolingDown(state: GroupState, transition: Transition, at: number, cooldownMs: number): boolean {
  return state.last_transition === transition && state.last_transition_at !== undefined && at - state.last_transition_at < cooldownMs;
}

/** Ignored and muted groups keep counting and never announce. */
function silenced(status: GroupStatus): boolean {
  return status === "ignored" || status === "muted";
}

function announce(next: GroupState, transition: Transition, at: number): { next: GroupState; transition: Transition } {
  next.last_transition = transition;
  next.last_transition_at = at;
  return { next, transition };
}

/**
 * Kinds whose occurrences report a state (ok or failing) rather than a
 * failure: a check, and a watched metric inside or across its line. Both
 * announce only when the state flips, so one rule serves them.
 */
const STATE_TRANSITIONS: Partial<Record<GroupKind, { failed: Transition; recovered: Transition }>> = {
  check: { failed: "check_failed", recovered: "check_recovered" },
  metric: { failed: "metric_alert", recovered: "metric_recovered" },
};

function firstOccurrence(occ: Occurrence, now: number): { next: GroupState; transition?: Transition } {
  const base: GroupState = {
    kind: occ.kind,
    status: "open",
    count: 1,
    first_seen: occ.at,
    last_seen: occ.at,
    buckets: addToBuckets([], occ.at, 1, now),
    ...(occ.release ? { first_release: occ.release, last_release: occ.release } : {}),
  };
  const state = STATE_TRANSITIONS[occ.kind];
  if (state) {
    // A state seen ok first is on record so its first failure is a flip; its
    // count and buckets measure failures only.
    if (occ.ok !== false) return { next: { ...base, status: "resolved", count: 0, buckets: [], meta: { ok: true } } };
    return announce({ ...base, meta: { ok: false } }, state.failed, occ.at);
  }
  return announce(base, occ.kind === "job" ? "job_failed" : "new", occ.at);
}

/**
 * One occurrence applied to a group (null: the fingerprint is new). Returns
 * the group after it and the transition it is, if any. `now` is the receive
 * time: buckets are pruned against it, and only an occurrence in the current
 * hour can spike or burst, so a backfilled batch never announces either.
 */
export function applyOccurrence(prev: GroupState | null, occ: Occurrence, now: number): { next: GroupState; transition?: Transition } {
  if (!prev) return firstOccurrence(occ, now);

  const next: GroupState = {
    ...prev,
    buckets: pruneBuckets(prev.buckets, now),
    last_seen: Math.max(prev.last_seen, occ.at),
    ...(occ.release ? { last_release: occ.release } : {}),
    ...(prev.meta ? { meta: { ...prev.meta } } : {}),
  };
  const hour = hourStart(occ.at);

  const state = STATE_TRANSITIONS[prev.kind];
  if (state) {
    const ok = occ.ok !== false;
    const wasOk = prev.meta?.ok !== false;
    if (!ok) {
      next.count += 1;
      next.buckets = addToBuckets(next.buckets, occ.at, 1, now);
    }
    next.meta = { ...next.meta, ok };
    // A check that stays red (a metric that stays across its line) is counted, not re-announced.
    if (ok === wasOk || silenced(prev.status)) return { next };
    if (ok) {
      next.status = "resolved";
      next.resolved_at = occ.at;
      return announce(next, state.recovered, occ.at);
    }
    next.status = "open";
    return announce(next, state.failed, occ.at);
  }

  next.count += 1;
  next.buckets = addToBuckets(next.buckets, occ.at, 1, now);
  if (silenced(prev.status)) return { next };

  if (prev.status === "resolved") {
    // Old clients still running the release before the fix are not a
    // regression; anything from the fixed release on, or unordered, is.
    if (prev.kind !== "job" && prev.resolved_in && occ.release && isOlderRelease(occ.release, prev.resolved_in)) return { next };
    next.status = "open";
    next.regressed_at = occ.at;
    return announce(next, prev.kind === "job" ? "job_failed" : "regressed", occ.at);
  }

  if (hour !== hourStart(now)) return { next };
  const inHour = bucketCount(next.buckets, hour);

  if (prev.kind === "job") {
    // The burst window is the clock hour the buckets keep, not a sliding hour.
    if (inHour >= GROUP_RULES.job_burst_count && !coolingDown(prev, "job_failed", occ.at, GROUP_RULES.job_cooldown_ms)) {
      return announce(next, "job_failed", occ.at);
    }
    return { next };
  }

  if ((prev.kind === "error" || prev.kind === "log") && spikes(prev, next, hour, occ.at)) return announce(next, "spike", occ.at);
  return { next };
}

/**
 * The spike rule (X3): the hour holds at least spike_min_count and
 * spike_factor times the trailing 24-hour mean, outside the cooldown. A group
 * born this hour already said "new"; its first hour has no baseline to spike
 * against.
 */
function spikes(prev: GroupState, next: GroupState, hour: number, at: number): boolean {
  if (prev.first_seen >= hour) return false;
  const inHour = bucketCount(next.buckets, hour);
  return (
    inHour >= GROUP_RULES.spike_min_count &&
    inHour >= GROUP_RULES.spike_factor * trailingMean(next.buckets, hour) &&
    !coolingDown(prev, "spike", at, GROUP_RULES.spike_cooldown_ms)
  );
}

/** A batch's occurrences of one group, applied oldest first, with every transition they made. */
export function foldOccurrences(prev: GroupState | null, occurrences: Occurrence[], now: number): { next: GroupState | null; transitions: TransitionAt[] } {
  let state = prev;
  const transitions: TransitionAt[] = [];
  for (const occ of [...occurrences].sort((a, b) => a.at - b.at)) {
    const step = applyOccurrence(state, occ, now);
    state = step.next;
    if (step.transition) transitions.push({ transition: step.transition, at: occ.at });
  }
  return { next: state, transitions };
}

// ── Mirrors ──
//
// A vendor that already groups (a Sentry issue) reports a group's whole state
// on every read, not one occurrence at a time. Its counts are absolute, so
// they replace ours rather than add, and its status is the truth the group
// follows. The transitions are the same names under the same silences.

/** One vendor group as read now. Counts and times are the vendor's totals. */
export interface MirrorSnapshot {
  kind: GroupKind;
  status: GroupStatus;
  count: number;
  first_seen: number;
  last_seen: number;
  release?: string;
  first_release?: string;
  /** The release a resolve names as carrying the fix. */
  resolved_in?: string;
  /** The vendor says this group came back after a resolve. */
  regressed?: boolean;
  /** Hourly counts the vendor reports; they replace ours for the hours they cover. */
  hourly?: Bucket[];
}

/** Our buckets with the vendor's hours laid over them, pruned to the window. */
export function overlayBuckets(buckets: Bucket[], hourly: Bucket[], now: number): Bucket[] {
  const byHour = new Map(pruneBuckets(buckets, now).map((b) => [b.hour, b.count]));
  for (const b of pruneBuckets(hourly, now)) byHour.set(hourStart(b.hour), b.count);
  return [...byHour].filter(([, count]) => count > 0).map(([hour, count]) => ({ hour, count })).sort((a, b) => a.hour - b.hour);
}

/**
 * A vendor snapshot applied to its group (null: first read). `since` is when
 * the mirror started: a group first seen before it is backfill and is never
 * announced as new, and a regression the vendor already reported at the first
 * read is recorded without being announced, so connecting a project does not
 * flood triggers and the line with its history.
 *
 * Statuses: the vendor's resolve and ignore are followed; a local mute sticks
 * (it is codecast's own silence); a group resolved here stays resolved while
 * the vendor shows nothing newer than the resolve, and regresses once it does,
 * the occurrence path's rule.
 */
export function applyMirror(prev: GroupState | null, snap: MirrorSnapshot, now: number, since: number): { next: GroupState; transitions: TransitionAt[] } {
  const delta = Math.max(0, snap.count - (prev?.count ?? 0));
  const buckets = snap.hourly ? overlayBuckets(prev?.buckets ?? [], snap.hourly, now) : addToBuckets(prev?.buckets ?? [], snap.last_seen, delta, now);
  const firstRelease = prev?.first_release ?? snap.first_release ?? snap.release;
  const lastRelease = snap.release ?? prev?.last_release;
  const base = {
    kind: snap.kind,
    count: Math.max(prev?.count ?? 0, snap.count),
    first_seen: Math.min(prev?.first_seen ?? snap.first_seen, snap.first_seen),
    last_seen: Math.max(prev?.last_seen ?? snap.last_seen, snap.last_seen),
    buckets,
    ...(firstRelease ? { first_release: firstRelease } : {}),
    ...(lastRelease ? { last_release: lastRelease } : {}),
  };
  const none = (next: GroupState) => ({ next, transitions: [] as TransitionAt[] });
  const one = (next: GroupState, transition: Transition, at: number) => ({ next: announce(next, transition, at).next, transitions: [{ transition, at }] });

  if (!prev) {
    const next: GroupState = {
      ...base,
      status: snap.status,
      ...(snap.regressed ? { regressed_at: snap.last_seen } : {}),
      ...(snap.status === "resolved" ? { resolved_at: now, ...(snap.resolved_in ? { resolved_in: snap.resolved_in } : {}) } : {}),
    };
    return snap.status === "open" && snap.first_seen >= since ? one(next, "new", snap.first_seen) : none(next);
  }

  const next: GroupState = { ...prev, ...base };
  if (prev.status === "muted") return none(next);

  if (snap.status === "resolved") {
    if (prev.status === "resolved") return none(next);
    next.status = "resolved";
    next.resolved_at = now;
    next.resolved_in = snap.resolved_in;
    return prev.status === "ignored" ? none(next) : one(next, "resolved", now);
  }
  if (snap.status !== "open") {
    next.status = snap.status;
    return none(next);
  }
  if (prev.status === "ignored") {
    // The vendor reopened what it had ignored: follow it, quietly.
    next.status = "open";
    return none(next);
  }
  if (prev.status === "resolved") {
    if (!snap.regressed && snap.last_seen <= (prev.resolved_at ?? 0)) return none(next);
    next.status = "open";
    next.regressed_at = snap.last_seen;
    return one(next, "regressed", snap.last_seen);
  }
  // Open here and open there. A regression the vendor reports that this group
  // has not announced since its last resolve (both read between two polls).
  const announced = prev.regressed_at !== undefined && prev.regressed_at >= (prev.resolved_at ?? 0);
  if (snap.regressed && !announced) {
    next.regressed_at = snap.last_seen;
    return one(next, "regressed", snap.last_seen);
  }
  const hour = hourStart(now);
  if (hourStart(snap.last_seen) === hour && (prev.kind === "error" || prev.kind === "log") && spikes(prev, next, hour, now)) {
    return one(next, "spike", now);
  }
  return none(next);
}

/** How a status change moves a source's groups_open counter. */
export function openGroupsDelta(prev: GroupStatus | undefined, next: GroupStatus): number {
  return (next === "open" ? 1 : 0) - (prev === "open" ? 1 : 0);
}

// ── Items to occurrences ──

/** What an occurrence keeps in event_samples. Free-form objects ride as JSON strings (ingestSchema.ts). */
export interface SampleInput {
  at: number;
  message?: string;
  stack?: string;
  level?: string;
  url?: string;
  user?: IngestUser;
  tags_json?: string;
  context_json?: string;
  release?: string;
  environment?: string;
  replay_external_id?: string;
}

export type ItemPlan =
  | {
      type: "group";
      kind: GroupKind;
      /** The kind's own fingerprint, before any segment or prefix. */
      fp: string;
      /** The stored group fingerprint: groupFingerprint(undefined, kind, fp). */
      fingerprint: string;
      title: string;
      culprit?: string;
      level?: string;
      occurrence: Occurrence;
      sample: SampleInput;
      /** Fields the group's meta takes from this occurrence beyond the rules' own (a metric's value and line). */
      meta?: MetricMeta;
    }
  | { type: "deploy"; version: string; sha?: string; environment?: string; at: number }
  /** Accepted and counted, never grouped: analytics events, logs below warn, replay manifests (X5 owns those). */
  | { type: "count" };

function titleOf(text: string): string {
  return (text.split("\n")[0].trim() || text.trim()).slice(0, INGEST_LIMITS.title_chars);
}

function json(value: Record<string, unknown> | undefined): string | undefined {
  return value && Object.keys(value).length ? JSON.stringify(value) : undefined;
}

function group(kind: GroupKind, fp: string, rest: Omit<Extract<ItemPlan, { type: "group" }>, "type" | "kind" | "fp" | "fingerprint">): ItemPlan {
  return { type: "group", kind, fp, fingerprint: groupFingerprint(undefined, kind, fp), ...rest };
}

/** What one validated item does to the store. */
export function planItem(item: IngestItem, envelope: { release?: string; environment?: string }): ItemPlan {
  const { release, environment } = envelope;
  const occurrence = (kind: GroupKind, extra: Partial<Occurrence> = {}): Occurrence => ({ kind, at: item.at, ...(release ? { release } : {}), ...extra });
  const sampleBase = { at: item.at, ...(release ? { release } : {}), ...(environment ? { environment } : {}) };
  switch (item.type) {
    case "error":
      return group("error", sdkErrorFingerprint(item), {
        title: titleOf(item.message),
        culprit: topInAppFrame(item.stack),
        level: item.level ?? "error",
        occurrence: occurrence("error"),
        sample: {
          ...sampleBase,
          message: item.message,
          stack: item.stack,
          level: item.level ?? "error",
          url: item.url,
          user: item.user,
          tags_json: json(item.tags),
          context_json: json(item.context),
          replay_external_id: item.replay_id,
        },
      });
    case "log":
      if (!isGroupedLogLevel(item.level)) return { type: "count" };
      return group("log", sdkErrorFingerprint(item), {
        title: titleOf(item.message),
        level: item.level,
        occurrence: occurrence("log"),
        sample: { ...sampleBase, message: item.message, level: item.level, context_json: json(item.context) },
      });
    case "job_failed":
      return group("job", jobFingerprint(item.job), {
        title: item.job,
        occurrence: occurrence("job"),
        sample: {
          ...sampleBase,
          message: item.error,
          context_json: json({ ...(item.attempt !== undefined ? { attempt: item.attempt } : {}), ...(item.job_id ? { job_id: item.job_id } : {}) }),
        },
      });
    case "check":
      return group("check", checkFingerprint(item.id), {
        title: item.title ?? item.id,
        occurrence: occurrence("check", { ok: item.ok }),
        sample: { ...sampleBase, message: item.detail ?? (item.ok ? "ok" : "failed") },
      });
    case "deploy":
      return { type: "deploy", version: item.version, sha: item.sha, environment: item.environment ?? environment, at: item.at };
    case "event":
    case "replay":
      return { type: "count" };
  }
}

// ── Watched metrics (X7) ──

export type MetricDirection = "above" | "below";

export interface MetricMeta {
  value: number;
  threshold: number;
  direction: MetricDirection;
  metric_watch_id?: string;
}

/** Whether a value is across the watch's line: an "above" watch alerts past it, a "below" watch under it. */
export function metricCrosses(value: number, threshold: number, direction: MetricDirection): boolean {
  return direction === "above" ? value > threshold : value < threshold;
}

/** The watch's points with one more, oldest first, cut to the newest GROUP_RULES.metric_points. */
export function appendMetricPoint(points: { at: number; value: number }[], point: { at: number; value: number }): { at: number; value: number }[] {
  return [...points, point].slice(-GROUP_RULES.metric_points);
}

/**
 * One polled value of a watch as a group occurrence. A metric is a state
 * kind (STATE_TRANSITIONS): inside its line it is ok, across it failing, and
 * only a flip announces metric_alert or metric_recovered. The fingerprint is
 * the watch's short id, so renaming the watch keeps its group.
 */
export function planMetric(
  watch: { short_id: string; name: string; threshold: number; direction: MetricDirection; id?: string },
  value: number,
  at: number,
): Extract<ItemPlan, { type: "group" }> {
  const crossed = metricCrosses(value, watch.threshold, watch.direction);
  const line = `${watch.direction} ${watch.threshold}`;
  return group("metric", metricFingerprint(watch.short_id), {
    title: titleOf(`${watch.name} ${line}`),
    occurrence: { kind: "metric", at, ok: !crossed },
    sample: { at, message: `${watch.name} = ${value} (alerts ${line})` },
    meta: { value, threshold: watch.threshold, direction: watch.direction, ...(watch.id ? { metric_watch_id: watch.id } : {}) },
  }) as Extract<ItemPlan, { type: "group" }>;
}
