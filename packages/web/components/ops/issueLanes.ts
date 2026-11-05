// Lanes: what in an open issue list needs a person now (regressed,
// escalating, new, firing, flapping). No React, no store.
import { bucketSeries, GROUP_RULES } from "@codecast/shared/contracts/ingest";
import { isRecordNotIssue } from "@codecast/shared/contracts/signalFingerprint";
import type { OpsEvent, OpsGroup } from "./opsTypes";
import { DAY, HOUR, issueState, regressedAt } from "./issueState";

// ── Lanes: what in an open list needs a person now ──

/**
 * Where an open issue sits in triage. Regressed came back after a fix;
 * escalating is firing well above its own recent rate; new was first seen in
 * the last day; ongoing is still firing; quiet has not fired in QUIET_DAYS.
 */
export type IssueLane = "regressed" | "escalating" | "new" | "firing" | "flapping" | "ongoing" | "quiet";
export type LaneFilter = "attention" | IssueLane | "all";
export const LANE_FILTERS: { key: LaneFilter; label: string }[] = [
  { key: "attention", label: "Needs attention" },
  { key: "regressed", label: "Regressed" },
  { key: "escalating", label: "Escalating" },
  { key: "new", label: "New" },
  { key: "firing", label: "Firing" },
  { key: "flapping", label: "Flapping" },
  { key: "ongoing", label: "Ongoing" },
  { key: "quiet", label: "Quiet" },
  { key: "all", label: "All open" },
];
export const QUIET_DAYS = 3;
/** A regression stays in its lane this long after it came back; past it, it reads as ongoing (or quiet) and keeps its pill. */
export const REGRESSED_DAYS = 7;
/** A check or metric that failed this many times in FLAP_DAYS flaps: one lane and one pill, not a regression each time. */
export const FLAP_MIN = 3;
export const FLAP_DAYS = 7;

const FAILING_FLIP = new Set(["check_failed", "metric_alert", "regressed"]);

/**
 * How many times a check or metric flipped to failing in the last FLAP_DAYS:
 * the server's own list where it keeps one, or its transition rows this
 * device holds, whichever saw more. Zero for any other kind.
 */
export function failuresIn(g: Pick<OpsGroup, "_id" | "short_id" | "kind"> & Partial<Pick<OpsGroup, "failed_at">>, events: OpsEvent[], now: number): number {
  if (g.kind !== "check" && g.kind !== "metric") return 0;
  const since = now - FLAP_DAYS * DAY;
  const stored = (g.failed_at ?? []).filter((t) => t > since).length;
  let seen = 0;
  for (const e of events) {
    if (e.created_at <= since || (e.group_id !== g._id && e.data?.group_short_id !== g.short_id)) continue;
    if (FAILING_FLIP.has(e.data?.transition ?? e.kind)) seen++;
  }
  return Math.max(stored, seen);
}

/**
 * A check or metric that keeps flipping, whatever it reads now. A monitor
 * that recovers on its own is resolved for most of its life, so the flaps
 * are counted over its failures, not its status; only ignoring or muting it
 * settles it.
 */
export function isFlapping(g: Pick<OpsGroup, "kind" | "status">, failures: number): boolean {
  return (g.kind === "check" || g.kind === "metric") && failures >= FLAP_MIN && g.status !== "ignored" && g.status !== "muted";
}

/** The failure count a lane reads when no events are at hand: the server's list alone. */
export const storedFailures = (g: OpsGroup, now: number) => failuresIn(g, [], now);
const NEW_HOURS = 24;
/** Escalating: the last 24 hours hold at least this many and this many times the day before's average over the two days before. */
const ESCALATE_MIN = 10;
const ESCALATE_FACTOR = 3;

/** The hours read as "now": a spike whose rate has fallen back under the escalation line over these has settled. */
const NOW_HOURS = 3;

/** Firing: an ongoing issue this loud over the last 24 hours, still firing in the last NOW_HOURS. A steady flood is not escalating (it is its usual rate), but it is the loudest thing a person has. */
export const FIRING_MIN = 100;

/** Firing needs the rate now at least this share of its usual rate: one that fell well under it has calmed down, whatever its day adds up to. */
const FIRING_NOW_SHARE = 0.5;

/**
 * An ongoing issue that fires loud and steady right now: at least FIRING_MIN
 * events in the last 24 hours, the latest within NOW_HOURS, and its rate over
 * NOW_HOURS not fallen away (a spike that passed, or a rate under half its
 * usual, is calm, as the issue page's strip says). Whatever its fix says (a
 * dropped or dissolved task included), a person sees it under Needs attention.
 */
export function isFiring(g: Pick<OpsGroup, "buckets" | "last_seen"> & Partial<Pick<OpsGroup, "last_transition" | "last_transition_at">>, now: number): boolean {
  if (now - g.last_seen > NOW_HOURS * HOUR) return false;
  if (bucketSeries(g.buckets, now, 24).reduce((a, b) => a + b, 0) < FIRING_MIN) return false;
  const e = escalation(g, now);
  if (e.back) return false;
  return e.baseline <= 0 || e.perHourNow * 24 >= FIRING_NOW_SHARE * e.baseline;
}

export type Escalation = {
  /** Events in the last 24 hours. */
  recent: number;
  /** The daily mean of the 48 hours before them. */
  baseline: number;
  factor: number | null;
  /** The hourly rate over the last NOW_HOURS hours. */
  perHourNow: number;
  /** The busiest hour of the last day, and when it began. */
  peak: number;
  peakAt: number;
  /** The day ran past the escalation line, by the counts or the server's spike rule. */
  spiked: boolean;
  /** It spiked, and its rate now is back under the line: a spike that passed, not one going on. */
  settled: boolean;
  /** Settled and back within the normal band (under BACK_FACTOR times the usual rate): a spike that passed. One settled above it is still elevated. */
  back: boolean;
};

/** A settled spike's rate this close to its usual day reads as normal again; above it, still elevated. */
const BACK_FACTOR = 1.5;

/** The last 24 hours against the daily mean of the 48 before them, from the hourly buckets, with the rate now and the busiest hour. */
export function escalation(g: Pick<OpsGroup, "buckets"> & Partial<Pick<OpsGroup, "last_transition" | "last_transition_at">>, now: number): Escalation {
  const s = bucketSeries(g.buckets, now, GROUP_RULES.bucket_hours);
  const day = s.slice(-24);
  const recent = day.reduce((a, b) => a + b, 0);
  const baseline = s.slice(0, -24).reduce((a, b) => a + b, 0) / Math.max(1, (s.length - 24) / 24);
  const perHourNow = s.slice(-NOW_HOURS).reduce((a, b) => a + b, 0) / NOW_HOURS;
  const peak = Math.max(0, ...day);
  const hourStart = Math.floor(now / HOUR) * HOUR;
  const peakAt = hourStart - (day.length - 1 - day.indexOf(peak)) * HOUR;
  const line = ESCALATE_FACTOR * Math.max(1, baseline);
  const spiked = (g.last_transition === "spike" && (g.last_transition_at ?? 0) > now - 24 * HOUR) || (recent >= ESCALATE_MIN && recent >= line);
  const settled = spiked && perHourNow * 24 < line;
  return { recent, baseline, factor: baseline > 0 ? recent / baseline : null, perHourNow, peak, peakAt, spiked, settled, back: settled && perHourNow * 24 <= BACK_FACTOR * Math.max(1, baseline) };
}

/** Escalating: it spiked in the last day and is still running past the line now. One that fell back reads settled (escalation().settled), never escalating. */
export function isEscalating(g: Pick<OpsGroup, "buckets" | "first_seen" | "last_transition" | "last_transition_at">, now: number): boolean {
  if (now - g.first_seen < NEW_HOURS * HOUR) return false;
  const e = escalation(g, now);
  return e.spiked && !e.settled;
}

/** A per-day count as a person reads a rate: per hour once it runs past two an hour, else per day. */
export function rateWords(perDay: number, unit?: "h" | "day"): string {
  if (unit === "h") return `${(perDay / 24 >= 10 || perDay === 0 ? Math.round(perDay / 24) : Math.round(perDay / 2.4) / 10).toLocaleString()}/h`;
  if (unit === "day") return perDay > 0 && perDay < 1 ? "<1/day" : `${Math.round(perDay).toLocaleString()}/day`;
  return perDay >= 48 ? `${Math.round(perDay / 24).toLocaleString()}/h` : perDay > 0 && perDay < 1 ? "<1/day" : `${Math.round(perDay).toLocaleString()}/day`;
}

/**
 * An escalation in the words every surface uses: the day's count and its
 * average rate against the usual rate (the two the × factor divides), and
 * the rate now.
 */
/** How far over its usual day an escalating issue runs, as its pill says it ("2.1×"), or "" under 1.5×: the issue page's lane tag and the home's pill read this one rule. */
export function escalationFactor(e: Pick<Escalation, "factor">): string {
  return e.factor !== null && e.factor >= 1.5 ? `${e.factor >= 10 ? Math.round(e.factor) : e.factor.toFixed(1)}×` : "";
}

export function escalationWords(e: Escalation): string {
  const u = rateUnit(e.recent, e.baseline, e.perHourNow * 24);
  return `${e.recent.toLocaleString()} in 24h · avg ${rateWords(e.recent, u)} vs usual ${rateWords(e.baseline, u)} · now ${rateWords(e.perHourNow * 24, u)}`;
}

/** One unit for rates read side by side, so "now" and "usually" compare at a glance: per hour once any of them runs past two an hour. */
export function rateUnit(...perDay: number[]): "h" | "day" {
  return Math.max(0, ...perDay) >= 48 ? "h" : "day";
}

/**
 * An open issue's lane, or null for one that is not open. A check or metric
 * that keeps flipping is flapping. A regression is a lane while it is fresh:
 * one that came back over REGRESSED_DAYS ago, or has been quiet for
 * QUIET_DAYS, falls to the lane its firing says and keeps its pill.
 * `failures` is failuresIn over the events at hand.
 */
export function issueLane(g: OpsGroup, now: number, failures: number = storedFailures(g, now)): IssueLane | null {
  // A record (a CI run filed as its own group, a check that never failed) sits in no lane on any surface, as the list leaves it out.
  if (isRecordNotIssue(g)) return null;
  const s = issueState(g);
  if (s !== "open" && s !== "regressed" && s !== "ok") return null;
  if (failures >= FLAP_MIN) return "flapping";
  const quiet = now - g.last_seen > QUIET_DAYS * DAY;
  if (s === "regressed" && !quiet && now - (regressedAt(g) ?? 0) <= REGRESSED_DAYS * DAY) return "regressed";
  // A check that is passing now is watched, not firing.
  if (s === "ok") return "quiet";
  if (isEscalating(g, now)) return "escalating";
  if (now - g.first_seen < NEW_HOURS * HOUR) return "new";
  if (quiet) return "quiet";
  return isFiring(g, now) ? "firing" : "ongoing";
}

/** The lanes that ask a person to look now. */
export type AttentionLane = "regressed" | "escalating" | "new" | "firing";
const ATTENTION_LANES: ReadonlySet<IssueLane> = new Set<IssueLane>(["regressed", "escalating", "new", "firing"]);

/**
 * Whether an open issue needs a person now, and why: the one classifier the
 * Issues list's Needs attention lane, the Ops home's tiles and rows, and the
 * palette all read, so a count on one matches the lane it opens.
 */
export function attentionLane(g: OpsGroup, now: number, failures?: number): AttentionLane | null {
  const l = partitionLane(g, issueLane(g, now, failures), now);
  return l && ATTENTION_LANES.has(l) ? (l as AttentionLane) : null;
}

/** How many open issues sit in a Needs attention lane (one source's, when named): the Issues list's own count, for a surface that lists more beside them. */
export function attentionIssueCount(groups: readonly OpsGroup[], now: number, failures?: (g: OpsGroup) => number, sourceId?: string | null): number {
  let n = 0;
  for (const g of groups) if ((!sourceId || g.source_id === sourceId) && attentionLane(g, now, failures?.(g))) n++;
  return n;
}

export function laneAdmits(lane: LaneFilter, l: IssueLane | null): boolean {
  if (l === null) return false;
  if (lane === "all") return true;
  if (lane === "attention") return ATTENTION_LANES.has(l);
  return l === lane;
}

/**
 * The lane of the bar's partition an open issue sits in, so the lanes sum to
 * Open: a flapper is not one that asks for a person now (attentionLane
 * leaves it out on every surface), so it sits with Ongoing, or with Quiet
 * once it has been quiet that long. Flapping is the view across them.
 */
export function partitionLane(g: Pick<OpsGroup, "last_seen" | "status" | "kind" | "meta"> & Partial<Pick<OpsGroup, "regressed_at" | "resolved_at" | "last_transition" | "last_transition_at">>, lane: IssueLane | null, now: number): Exclude<IssueLane, "flapping"> | null {
  if (lane !== "flapping") return lane;
  // A flapper failing now that failed in the last day is firing: it keeps paging whoever owns it.
  const failing = issueState(g) === "open" || issueState(g) === "regressed";
  if (failing && now - g.last_seen <= DAY) return "firing";
  return now - g.last_seen > QUIET_DAYS * DAY ? "quiet" : "ongoing";
}
