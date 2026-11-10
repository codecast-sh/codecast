// One health reading per source, for every surface that names one: the chip
// in a source view's switcher, the Settings row, the Signals row and the
// source overview. Before this, each surface read a different field (the
// stored status, events_today, the flow map's state) and they disagreed: a
// PostHog source with a stalled import showed a green dot, and a source whose
// last event was 18 days old read "active".
//
// Activity is read from everything a source leaves behind, not only the
// ingest door's counters: a poll-based source (PostHog, Sentry, GitHub, an
// app) lands groups, replays and watch readings without ever touching
// events_today. Pure: no React, no store.
import { DAY_MS, normalDay, sourceState } from "@codecast/shared/contracts/flowMap";
import { bucketSeries, parseReaderQuery } from "@codecast/shared/contracts/ingest";
import { replayBackfillLine, replayBackfillState } from "@codecast/shared/contracts/replay";
import { relTimeShort } from "@codecast/shared/time";
import { appWatchVerdict, failureLine, verdictCounts, watchTally, watchVerdict, type LiveFailure, type WatchTally } from "./appsModel";
import { watchHealth } from "./metricModel";
import type { OpsGroup, OpsReplay, OpsSource, OpsWatch } from "./opsTypes";

export const HEALTH_DAYS = 14;
const HOUR = 3600_000;

export type HealthState = "flowing" | "quiet" | "stopped" | "waiting" | "failing" | "degraded" | "auth" | "paused";
export type HealthTone = "ok" | "calm" | "warn" | "bad" | "off";
/** The one press that fixes what the health names. */
export type HealthFix = "resume" | "reconnect" | "resume_import" | "setup" | "watches" | "calls" | "check";

export type SourceActivity = {
  /** The newest sign of life: an event, a group's last occurrence, a replay, a watch reading. */
  lastAt: number | null;
  /** The last 24 hours. */
  today: number;
  /** A normal day: the median of the earlier days that had any. */
  normal: number;
  /** HEALTH_DAYS daily counts, oldest first, the last is today (UTC). */
  days: number[];
  dropped: number;
};

export type SourceHealth = SourceActivity & {
  state: HealthState;
  tone: HealthTone;
  /** One or two words: "Flowing", "Import stalled". */
  label: string;
  /** What is behind the label, when something is wrong: the error, the import's line. */
  reason: string | null;
  fix: HealthFix | null;
  /** When the source last polled its vendor or app; null for a push source. */
  polledAt: number | null;
  /**
   * A failing reader: `watchIds` are the watches (by _id) it leaves with no
   * answer, `feeds` every active watch that reads through it. Set whenever a
   * reader fails, blind watches or not, so the home files it under Reader
   * failing on every load rather than by whether a watch's last read failed.
   */
  starves?: { reader: AppFailure; watchIds: string[]; feeds?: string[] };
  /** Every reader, action and check of an app failing now, each once: what the Apps board's "failing now" counts. */
  problems?: HealthProblem[];
  /** When what the label names began: the reader's first failure, the poll's last good run, the last event before a stop. Null when nothing dates it. */
  since?: number | null;
  /**
   * How much of the source is out: down (nothing arrives: stopped, its
   * connection or auth gone, the source itself on error), degraded (data
   * still arrives, but a reader, a poll or an import fails or runs late), or
   * ok. The home files a source under Sources down or Sources degraded by it.
   */
  level: HealthLevel;
  /** The source's metric watches, in one sentence: the same set Metrics and the home's band count for it. */
  watches: WatchTally;
  /** An app's own checks (its manifest's polls, `watch_state`), counted apart from metric watches and named "checks". */
  checks: WatchTally;
};

export type HealthLevel = "down" | "degraded" | "ok";

/** One failing piece of an app: a reader, an action, or a check (a manifest watch), with its line. */
export type HealthProblem = { kind: "read" | "act" | "check"; name: string; line: string };

export const HEALTH_TONE: Record<HealthState, HealthTone> = {
  flowing: "ok",
  quiet: "calm",
  waiting: "calm",
  stopped: "bad",
  failing: "warn",
  degraded: "warn",
  auth: "bad",
  paused: "off",
};

/** A vendor poll older than this means the numbers may be behind (the shell's freshness chip reads the same line). */
export const POLL_LATE_MS = 15 * 60_000;

/**
 * How long a polled source may go without a poll before it is late: three of
 * its own shortest watch intervals (a PostHog source polls when its watches
 * do), never under POLL_LATE_MS. One rule for the source's health and the
 * shell's freshness chip.
 */
export function pollLateAfter(source: Pick<OpsSource, "_id">, watches: readonly Pick<OpsWatch, "source_id" | "status" | "interval_ms">[] = []): number {
  const every = watches.filter((w) => w.source_id === source._id && w.status !== "paused" && w.interval_ms > 0).map((w) => w.interval_ms);
  return Math.max(POLL_LATE_MS, every.length ? 3 * Math.min(...every) : 0);
}

/** Providers that read through a connection, so a lost connection stops them. */
export const CONNECTION_PROVIDERS = new Set(["posthog", "sentry", "app", "github"]);
const POLLED = new Set(["posthog", "sentry", "app", "github"]);

const AUTH_ERROR = /\b(401|403)\b|unauthori[sz]ed|forbidden|token|expired|revoked|reconnect|connection (is )?(gone|lost)|refused/i;

const dayKey = (at: number) => new Date(at).toISOString().slice(0, 10);

/** The HEALTH_DAYS UTC day keys ending today, oldest first. */
export function healthDayKeys(now: number, n = HEALTH_DAYS): string[] {
  return Array.from({ length: n }, (_, i) => dayKey(now - (n - 1 - i) * DAY_MS));
}

/** What a source left behind that this reading counts: its groups, replays and watches. */
export type SourceTrail = { groups: readonly OpsGroup[]; replays: readonly OpsReplay[]; watches: readonly OpsWatch[] };

/**
 * A source's activity from every trail it leaves. Each day takes the largest
 * of its measures (the door's day counter, its groups' hourly buckets, the
 * replays that started that day) rather than their sum, since one event can
 * show in more than one of them.
 */
export function sourceActivity(source: Pick<OpsSource, "_id" | "last_event_at" | "events_today" | "dropped_today" | "days">, trail: SourceTrail, now: number, mapped?: { days: readonly number[]; lastAt: number | null }): SourceActivity {
  const keys = healthDayKeys(now);
  const index = new Map(keys.map((k, i) => [k, i]));
  const days = new Array<number>(keys.length).fill(0);
  const take = (key: string, n: number, into: number[]) => {
    const i = index.get(key);
    if (i !== undefined) into[i] += n;
  };
  const stat = new Array<number>(keys.length).fill(0);
  for (const d of source.days ?? []) take(d.day, d.events, stat);
  const grouped = new Array<number>(keys.length).fill(0);
  let lastAt = source.last_event_at ?? 0;
  let today = 0;
  const groups = trail.groups.filter((g) => g.source_id === source._id);
  for (const g of groups) {
    lastAt = Math.max(lastAt, g.last_seen);
    for (const b of g.buckets ?? []) take(dayKey(b.hour), b.count, grouped);
  }
  // The groups' last 24 hours, hour by hour.
  for (const g of groups) today += bucketSeries(g.buckets, now, 24).reduce((a, b) => a + b, 0);
  const replayed = new Array<number>(keys.length).fill(0);
  let replaysToday = 0;
  for (const r of trail.replays) {
    if (r.source_id !== source._id) continue;
    lastAt = Math.max(lastAt, r.started_at);
    take(dayKey(r.started_at), 1, replayed);
    if (now - r.started_at < DAY_MS) replaysToday++;
  }
  for (const w of trail.watches) if (w.source_id === source._id && w.last_at) lastAt = Math.max(lastAt, w.last_at);
  // The flow map's days (its problems per day) end today too, aligned from the right.
  const fromMap = (i: number) => (mapped ? mapped.days[mapped.days.length - days.length + i] ?? 0 : 0);
  if (mapped?.lastAt) lastAt = Math.max(lastAt, mapped.lastAt);
  for (let i = 0; i < days.length; i++) days[i] = Math.max(stat[i], grouped[i], replayed[i], fromMap(i));
  // Today against the door's own count (a UTC day) and the replays: the largest, as above.
  today = Math.max(today, replaysToday, source.events_today ?? 0);
  days[days.length - 1] = Math.max(days[days.length - 1], today);
  return { lastAt: lastAt || null, today, normal: normalDay(days.slice(0, -1)), days, dropped: source.dropped_today ?? 0 };
}

type HealthSource = Pick<OpsSource, "provider" | "status" | "last_error" | "created_at" | "last_poll_at" | "replay_backfill" | "watch_state" | "_id"> & { keyed?: boolean };

/** An app connector's reader or action that is failing right now, from its call log (appsModel liveFailures). */
export type AppFailure = Pick<LiveFailure, "kind" | "name" | "reason" | "count"> & Partial<Pick<LiveFailure, "reasons" | "since">>;

/**
 * The one reading. Anything a person has to fix wins over how busy the source
 * is: paused, its connection gone, a failing poll or import. Then its activity:
 * flowing, quiet past its usual gap, stopped, or a new source waiting for its
 * first event.
 */
export function sourceHealth(source: HealthSource, activity: SourceActivity, opts: { now: number; connected?: boolean | null; watches?: readonly OpsWatch[]; appFailures?: readonly AppFailure[]; /** A check's title by its watch_state key, from the app's manifest. */ checkName?: (key: string) => string | undefined }): SourceHealth {
  const { now } = opts;
  const tally = sourceWatchTally(source, opts.watches ?? []);
  const checkT = sourceCheckTally(source, opts.checkName);
  const base = { ...activity, polledAt: POLLED.has(source.provider) ? source.last_poll_at ?? null : null, watches: tally, checks: checkT };
  const out = (state: HealthState, label: string, reason: string | null = null, fix: HealthFix | null = null): SourceHealth => ({ ...base, state, tone: HEALTH_TONE[state], label, reason, fix, level: HEALTH_TONE[state] === "bad" ? "down" : HEALTH_TONE[state] === "warn" ? "degraded" : "ok" });

  if (source.status === "paused") return out("paused", "Paused", null, "resume");
  if (opts.connected === false && CONNECTION_PROVIDERS.has(source.provider)) return out("auth", "Connection lost", source.last_error ?? null, "reconnect");
  if (source.status === "error") {
    const err = source.last_error ?? null;
    // The source itself stopped on an error: nothing arrives, so it is down, not merely degraded.
    return err && AUTH_ERROR.test(err) ? out("auth", "Auth failing", err, "reconnect") : { ...out("failing", "Stopped on error", err, "resume"), level: "down" };
  }
  const b = source.replay_backfill;
  if (b) {
    const st = replayBackfillState(b, now);
    if (st === "stalled" || st === "error") return out("failing", st === "stalled" ? "Import stalled" : "Import stopped", replayBackfillLine(b, now), "resume_import");
  }
  const failing = opts.appFailures ?? [];
  // Every failing check and call, named once each: the Apps board's "failing now" lists the same, so no surface names one and hides another.
  const checks = (source.watch_state ?? []).filter((w) => w.last_error && !w.paused);
  const problems: HealthProblem[] = [
    ...failing.map((x) => ({ kind: x.kind === "read" ? ("read" as const) : ("act" as const), name: x.name, line: failureLine(x, now) })),
    ...checks.map((w) => {
      const name = opts.checkName?.(w.key) ?? w.key.replace(/^(check|job):/, "");
      return { kind: "check" as const, name, line: `${name}: ${w.last_error!.slice(0, 120)}` };
    }),
  ];
  const named = problems.length ? { problems } : {};
  const watchErr = checks[0];
  if (watchErr && !failing.length) return { ...out("failing", failingHeadline(tally, 0, checkT), problems.map((p) => p.line).join(" · "), "watches"), ...named };
  // Erroring is watchHealth's one rule (two failed reads in a row), the same the home, the band and Metrics count.
  const metricErrs = (opts.watches ?? []).filter((w) => w.source_id === source._id && watchHealth(w) === "error");
  // A watch that reads through a failing reader is one problem, named once: the reader, how it fails, and the watches it starves.
  // A failing reader is named as one, whether or not a watch's latest read happened to fail: the reader the most watches read through first.
  const live = (opts.watches ?? []).filter((w) => w.source_id === source._id && w.status !== "paused");
  const readers = failing.filter((f) => f.kind === "read");
  const feedsOf = (f: AppFailure) => live.filter((w) => readerFailure(w, failing) === f);
  const f = [...readers].sort((a, b) => feedsOf(b).length - feedsOf(a).length)[0];
  if (f) {
    const starvedWatches = metricErrs.filter((x) => readerFailure(x, failing) === f);
    const starved = starvedWatches.map((x) => x.name);
    const watches = starved.length > 1 ? `${starved.length} watches (${starved.join(", ")}) have` : `the ${starved[0]} watch has`;
    const others = problems.filter((p) => p.name !== f.name).map((p) => p.line);
    return { ...out("degraded", failingHeadline(tally, failing.length, checkT), [`${failureLine(f, now)}${starved.length ? `, so ${watches} no answer` : ""}`, ...others].join(" · "), "calls"), starves: { reader: f, watchIds: starvedWatches.map((x) => x._id), feeds: feedsOf(f).map((x) => x._id) }, since: f.since ?? null, ...named };
  }
  // A watch whose own query fails (a timeout, bad HogQL) is the watch's problem, not the source's: the home lists it as a watch error.
  // An app whose readers, actions or checks keep failing is not healthy, however busy it is: the same reading the Apps board gives.
  if (failing.length) {
    // The condition, not a log line: which reader, action or check fails, how, and how often over what window.
    return { ...out("degraded", failingHeadline(tally, failing.length, checkT), problems.map((p) => p.line).join(" · "), "calls"), since: failing[0].since ?? null, ...named };
  }
  // A polled source whose poll is late: what it shows may be behind, so it is not flowing, whatever it sent before.
  if (base.polledAt && source.status === "active" && now - base.polledAt > pollLateAfter(source, opts.watches)) {
    return { ...out("degraded", "Poll late", `Last poll ${relTimeShort(base.polledAt, now)} ago; numbers here may be behind`, null), since: base.polledAt };
  }

  // Silence: say what is missing and point at the step that brings events back.
  const silentFix: HealthFix = source.keyed ? "check" : "setup";
  if (!activity.lastAt) {
    return { ...(now - source.created_at < 2 * DAY_MS ? out("waiting", "No events yet", null, silentFix) : out("stopped", "Never sent", `Added ${shortDate(source.created_at)}, nothing since`, silentFix)), since: source.created_at };
  }
  const state = sourceState({ lastAt: activity.lastAt, days: activity.days, now });
  if (state === "flowing") return out(state, "Flowing");
  const usual = activity.normal ? `; it sent about ${activity.normal.toLocaleString()} a day before` : "";
  return { ...out(state, state === "quiet" ? "Quiet" : "Stopped", `Nothing since ${shortDate(activity.lastAt)}${usual}`, silentFix), since: activity.lastAt };
}

/**
 * What is failing on a source, each noun counting its own set: the app's
 * checks, its metric watches (the set Metrics counts), and the reads and
 * actions failing outside them. "Invariants check failing · 1 call failing".
 */
export function failingHeadline(tally: WatchTally, calls: number, checks?: WatchTally): string {
  const parts = [checks?.bad ? checks.text : null, tally.bad ? tally.text : null, calls ? `${calls.toLocaleString()} ${calls === 1 ? "call" : "calls"} failing` : null].filter(Boolean);
  return parts.join(" · ") || "Degraded";
}

/** A source's metric watches under the one verdict (appsModel watchVerdict): the set Metrics and the home's band count. */
export function sourceWatchTally(source: Pick<OpsSource, "_id">, watches: readonly OpsWatch[]): WatchTally {
  const own = watches.filter((w) => w.source_id === source._id);
  const verdicts = own.map(watchVerdict);
  const t = watchTally(verdicts, { noLine: own.filter((w, i) => verdicts[i] === "ok" && w.threshold === undefined).length });
  // Watches whose last read failed but still hold a value are Retrying, the band's and Metrics' word, never "failing".
  const c = verdictCounts(verdicts);
  if (!c.alerting && !c.failing && c.retrying) return { ...t, word: "retrying", text: `${c.retrying.toLocaleString()} of ${c.total.toLocaleString()} ${c.total === 1 ? "watch" : "watches"} retrying` };
  return t;
}

/**
 * An app's own checks (manifest polls) as their own tally, in the noun
 * "check": one failing check is named ("Invariants check failing"), more are
 * counted ("2 of 3 checks failing").
 */
export function sourceCheckTally(source: Pick<OpsSource, "watch_state">, checkName?: (key: string) => string | undefined): WatchTally {
  const states = source.watch_state ?? [];
  const t = watchTally(states.map(appWatchVerdict));
  const n = (x: number) => x.toLocaleString();
  const failing = states.filter((w) => appWatchVerdict(w) === "failing");
  const name = (key: string) => checkName?.(key) ?? key.replace(/^(check|job):/, "");
  const text = !t.bad
    ? `${n(t.total)} ${t.total === 1 ? "check" : "checks"} ok`
    : t.bad === 1 && failing.length === 1 ? `${name(failing[0].key)} check failing` : `${n(t.bad)} of ${n(t.total)} ${t.total === 1 ? "check" : "checks"} ${t.word}`;
  return { ...t, text };
}

/** The failing reader a `reader` watch polls through, if it is one of them. */
export function readerFailure(w: Pick<OpsWatch, "query_kind" | "query">, failures: readonly AppFailure[]): AppFailure | undefined {
  if (w.query_kind !== "reader") return undefined;
  const q = parseReaderQuery(w.query);
  return "reader" in q ? failures.find((f) => f.kind === "read" && f.name === q.reader) : undefined;
}

const shortDate = (at: number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });

// ── One counter for the numbers a person compares ──

/** The full days a baseline reads, and how many of them it needs before it says anything. */
export const BASELINE_DAYS = 7;
const BASELINE_MIN = 3;

export type EventCounter = {
  /** Events accepted today (UTC), from the source's own day counter. */
  today: number;
  /** The median of the same counter over the last BASELINE_DAYS full days it has history for; null without enough history. */
  baseline: number | null;
  /** How many full days the baseline read. */
  baselineDays: number;
  /** The first UTC day the counter holds, or null when it holds none. */
  since: string | null;
  /** Today against the baseline: a spike once today alone passes three normal days, low once today's pace is under a third past midday. */
  vs: "spike" | "low" | "normal" | null;
};

/**
 * Events per UTC day from one counter only (event_source_stats.days): today
 * and its baseline measure the same thing, and a day before the counter's
 * first day is unknown, never zero.
 */
export function eventCounter(source: Pick<OpsSource, "days" | "events_today">, now: number): EventCounter {
  const series = source.days ?? [];
  const todayKey = dayKey(now);
  const byDay = new Map(series.map((d) => [d.day, d.events]));
  const since = series.length ? series.reduce((a, d) => (d.day < a ? d.day : a), series[0].day) : null;
  const today = series.length ? byDay.get(todayKey) ?? 0 : source.events_today ?? 0;
  const window: number[] = [];
  for (let i = BASELINE_DAYS; i >= 1; i--) {
    const k = dayKey(now - i * DAY_MS);
    if (since && k >= since) window.push(byDay.get(k) ?? 0);
  }
  const baseline = window.length >= BASELINE_MIN ? median(window) : null;
  let vs: EventCounter["vs"] = null;
  if (baseline) {
    const elapsed = (now - Date.parse(`${todayKey}T00:00:00Z`)) / DAY_MS;
    if (today >= 3 * baseline && today >= 10) vs = "spike";
    else if (elapsed >= 0.5 && (today / elapsed) * 3 <= baseline) vs = "low";
    else vs = "normal";
  }
  return { today, baseline, baselineDays: window.length, since, vs };
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** A day series for a chart: one bin per UTC day, null for the days before the counter's first. */
export function counterDays(source: Pick<OpsSource, "days">, now: number, n: number): { day: string; from: number; events: number | null; dropped: number }[] {
  const series = source.days ?? [];
  const byDay = new Map(series.map((d) => [d.day, d]));
  const since = series.length ? series.reduce((a, d) => (d.day < a ? d.day : a), series[0].day) : null;
  return healthDayKeys(now, n).map((day) => {
    const d = byDay.get(day);
    const known = !!since && day >= since;
    return { day, from: Date.parse(`${day}T00:00:00Z`), events: known ? d?.events ?? 0 : null, dropped: d?.dropped ?? 0 };
  });
}

/** Today against a normal day, as a person reads it: a spike at three times normal, a drop to a third. */
export function todayVsNormal(today: number, normal: number): "spike" | "low" | "normal" | null {
  if (!normal) return null;
  if (today >= 3 * normal && today >= 10) return "spike";
  if (today * 3 <= normal) return "low";
  return "normal";
}

/** The ink a tone wears (theme variables only). */
export const TONE_VAR: Record<HealthTone, string> = {
  ok: "var(--sol-green)",
  calm: "var(--sol-text-muted)",
  warn: "var(--sol-orange)",
  bad: "var(--sol-red)",
  off: "var(--sol-text-dim)",
};


export { HOUR as HEALTH_HOUR };
