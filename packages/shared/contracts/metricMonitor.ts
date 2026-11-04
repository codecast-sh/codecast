// A metric watch as a monitor (docs/architecture/external-data.md X7): beyond
// its line and side, how many reads in a row decide a flip, a warning level
// short of the line, how many failed reads count as missing data, and a mute.
// The server's poll (convex/metrics.ts recordPoint) and the web editor share
// these rules, so the form refuses what the server would.

export type MonitorDirection = "above" | "below";

export const MONITOR_LIMITS = {
  eval_reads_max: 20,
  no_data_after_max: 50,
  /** A mute runs at most this long; a longer silence is a pause. */
  mute_max_ms: 30 * 24 * 3600_000,
} as const;

/** The monitor fields a watch stores beside its line. Absent: one read decides, no warning, missing data ignored, not muted. */
export type MonitorFields = {
  eval_reads?: number;
  warn?: number;
  no_data_after?: number;
  muted_until?: number;
};

function crosses(value: number, line: number, direction: MonitorDirection): boolean {
  return direction === "above" ? value > line : value < line;
}

/** Why these monitor settings cannot be saved, or null. */
export function monitorProblem(m: MonitorFields & { threshold?: number; direction: MonitorDirection }): string | null {
  if (m.eval_reads !== undefined && (!Number.isInteger(m.eval_reads) || m.eval_reads < 1 || m.eval_reads > MONITOR_LIMITS.eval_reads_max)) {
    return `Reads in a row is a whole number from 1 to ${MONITOR_LIMITS.eval_reads_max}`;
  }
  if (m.no_data_after !== undefined && (!Number.isInteger(m.no_data_after) || m.no_data_after < 1 || m.no_data_after > MONITOR_LIMITS.no_data_after_max)) {
    return `Missed reads is a whole number from 1 to ${MONITOR_LIMITS.no_data_after_max}`;
  }
  if (m.warn !== undefined) {
    if (!Number.isFinite(m.warn)) return "The warning level must be a number";
    if (m.threshold === undefined) return "A warning level needs an alert line";
    if (m.warn === m.threshold || crosses(m.warn, m.threshold, m.direction)) {
      return `The warning level sits ${m.direction === "above" ? "under" : "over"} the alert line`;
    }
  }
  return null;
}

/**
 * The alert state after a read, from the newest values (oldest first, the
 * new read last): a watch flips to alert when its last `eval_reads` values
 * all cross the line, and back to ok when its last `eval_reads` all sit
 * inside it. Anything between keeps the state it had, so one noisy read
 * never files or closes an issue.
 */
export function nextMonitorState(
  prev: "ok" | "alert",
  values: readonly number[],
  m: { threshold: number; direction: MonitorDirection; eval_reads?: number },
): "ok" | "alert" {
  const k = Math.max(1, m.eval_reads ?? 1);
  const tail = values.slice(-k);
  if (tail.length < k) return prev;
  if (tail.every((v) => crosses(v, m.threshold, m.direction))) return "alert";
  if (tail.every((v) => !crosses(v, m.threshold, m.direction))) return "ok";
  return prev;
}

/** Whether a watch is muted at `now`. */
export function isMuted(m: Pick<MonitorFields, "muted_until">, now: number): boolean {
  return m.muted_until !== undefined && m.muted_until > now;
}

/** What a watch's alert does: files a problem task, or lands on the timeline and the triggers only. */
export const ALERT_ROUTES = ["task", "timeline"] as const;
export type AlertRoute = (typeof ALERT_ROUTES)[number];

/** The route a watch's alert takes: its own when it set one, else its source's rule for metric_alert. */
export function alertRoute(onAlert: AlertRoute | undefined, sourcePromote: readonly string[]): AlertRoute {
  return onAlert ?? (sourcePromote.includes("metric_alert") ? "task" : "timeline");
}

/** A source's promote list as one watch's route rewrites it: metric_alert in or out, every other transition as the source has it. */
export function promoteFor<T extends string>(onAlert: AlertRoute | undefined, sourcePromote: readonly T[]): T[] {
  if (!onAlert) return [...sourcePromote];
  const rest = sourcePromote.filter((t) => t !== "metric_alert");
  return onAlert === "task" ? [...rest, "metric_alert" as T] : rest;
}

// ── Who else an alert reaches, beside its route ──

/**
 * The people, roles and channel a watch's alert reaches, and what more it
 * does: start a fix session on a crossing, say it again while it runs, say
 * when it recovers. `by` is the person who set it: a fix starts as them, and
 * a channel line with no team agent to speak it is posted in their name.
 * Ids are the server's (users, org_roles, chat_channels).
 */
export type AlertNotify = {
  users?: string[];
  roles?: string[];
  channel?: string;
  fix?: boolean;
  renotify_ms?: number;
  recovery?: boolean;
  by: string;
};

export type AlertNotifyInput = Omit<AlertNotify, "by">;

export const NOTIFY_LIMITS = { users_max: 10, roles_max: 5, renotify_min_ms: 30 * 60_000, renotify_max_ms: 7 * 24 * 3600_000 } as const;

/** The renotify choices the editor offers; 0 says it once per episode. */
export const RENOTIFY_CHOICES = [0, 30 * 60_000, 3600_000, 4 * 3600_000, 24 * 3600_000] as const;

/** How many deliveries a watch keeps, newest last. */
export const DELIVERIES_KEPT = 40;

export type AlertDeliveryKind = "crossed" | "still" | "recovered";

/** One thing an alert did: told a person, a role or a channel, or started a fix; `ok` false says it could not, and `note` why. */
export type AlertDelivery = { at: number; kind: AlertDeliveryKind; to: string; ok: boolean; href?: string; note?: string };

/**
 * One stored shape for a notify setting, so the store's optimistic write and
 * the server's echo are equal: ids unique and sorted, empty parts dropped,
 * renotify and recovery only beside someone to tell, and nothing at all when
 * it reaches no one and does nothing.
 */
export function normalizeNotify(input: AlertNotifyInput | null | undefined, by: string): AlertNotify | undefined {
  if (!input) return undefined;
  const ids = (xs: readonly string[] | undefined) => {
    const out = [...new Set((xs ?? []).filter(Boolean))].sort();
    return out.length ? out : undefined;
  };
  const users = ids(input.users);
  const roles = ids(input.roles);
  const channel = input.channel || undefined;
  const fix = input.fix ? true : undefined;
  const tells = !!(users || roles || channel);
  if (!tells && !fix) return undefined;
  const renotify = input.renotify_ms && input.renotify_ms > 0 ? Math.round(input.renotify_ms) : undefined;
  return {
    ...(users ? { users } : {}),
    ...(roles ? { roles } : {}),
    ...(channel ? { channel } : {}),
    ...(fix ? { fix } : {}),
    ...(renotify && tells ? { renotify_ms: renotify } : {}),
    ...(input.recovery && tells ? { recovery: true } : {}),
    by,
  };
}

/** Why this notify setting cannot be saved, or null. */
export function notifyProblem(n: AlertNotifyInput | null | undefined): string | null {
  if (!n) return null;
  if ((n.users?.length ?? 0) > NOTIFY_LIMITS.users_max) return `An alert tells at most ${NOTIFY_LIMITS.users_max} people`;
  if ((n.roles?.length ?? 0) > NOTIFY_LIMITS.roles_max) return `An alert tells at most ${NOTIFY_LIMITS.roles_max} roles`;
  if (n.renotify_ms !== undefined && n.renotify_ms !== 0) {
    if (!Number.isFinite(n.renotify_ms) || n.renotify_ms < NOTIFY_LIMITS.renotify_min_ms || n.renotify_ms > NOTIFY_LIMITS.renotify_max_ms) return "Renotify runs from every 30 minutes to every 7 days";
  }
  return null;
}

/** Whether an alert still running is due to be said again: a renotify interval set, and passed since it was last said. */
export function renotifyDue(n: Pick<AlertNotify, "renotify_ms"> | undefined, notifiedAt: number | undefined, now: number): boolean {
  return !!n?.renotify_ms && notifiedAt !== undefined && now - notifiedAt >= n.renotify_ms;
}

/** The deliveries with these appended, the oldest dropped past DELIVERIES_KEPT. */
export function appendDeliveries(prev: readonly AlertDelivery[] | undefined, next: readonly AlertDelivery[]): AlertDelivery[] {
  return [...(prev ?? []), ...next].slice(-DELIVERIES_KEPT);
}

function plainValue(v: number, unit: string | undefined): string {
  const n = Math.abs(v) >= 100 ? String(Math.round(v)) : String(Math.round(v * 100) / 100);
  if (!unit) return n;
  return unit === "$" ? `$${n}` : `${n}${/^[%/]/.test(unit) ? "" : " "}${unit}`;
}

function spanWords(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/**
 * The one line an alert says, the same in a bell row, a chat channel and a
 * role's session: which watch, what happened, its value against the line,
 * and for a running or ended one how long it ran.
 */
export function alertLine(
  w: { short_id: string; name: string; unit?: string; threshold: number; direction: MonitorDirection },
  e: { kind: AlertDeliveryKind; value: number | null; since?: number; now: number; noData?: boolean },
): string {
  const line = `${w.direction === "above" ? ">" : "<"} ${plainValue(w.threshold, w.unit)}`;
  const value = e.value === null ? "no value" : plainValue(e.value, w.unit);
  const head = `${w.short_id} ${w.name}`;
  if (e.kind === "recovered") return `${head} recovered: ${value}, line ${line}${e.since !== undefined ? `, after ${spanWords(e.now - e.since)}` : ""}`;
  if (e.kind === "still") return `${head} still alerting after ${spanWords(e.now - (e.since ?? e.now))}: ${value}, line ${line}`;
  return e.noData ? `${head} stopped answering, line ${line}` : `${head} crossed its line: ${value}, line ${line}`;
}
