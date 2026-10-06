// When a hosted routine runs, as a person says it (plan pl-840): every day or
// every week on a weekday at a time, or once on a date at a time, rather than
// a duration ("30m"). Pure, so the form and its test read one rule. The form
// turns a choice into the same schedule fields a duration makes
// (schedule_type, run_at, interval_ms), so the backend and its plan check
// (routineRefusal) see nothing new.

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export type HostedRepeat = "daily" | "weekly" | "once" | "now";

export interface HostedWhen {
  repeat: HostedRepeat;
  /** 0 is Sunday, as Date.getDay. Read for "weekly". */
  weekday: number;
  /** "HH:MM", 24 hour, in the person's local time. */
  time: string;
  /** "YYYY-MM-DD", local. Read for "once". */
  date: string;
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** A local date as the date field holds it. */
export function localDateValue(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** The default a new routine starts from: every day at 9:00, which every plan allows. */
export function defaultHostedWhen(now: number): HostedWhen {
  const today = new Date(now);
  return { repeat: "daily", weekday: today.getDay(), time: "09:00", date: localDateValue(new Date(now + DAY_MS)) };
}

function atTime(day: Date, time: string): Date {
  const [h, m] = time.split(":").map(Number);
  const at = new Date(day);
  at.setHours(Number.isFinite(h) ? h : 9, Number.isFinite(m) ? m : 0, 0, 0);
  return at;
}

/** The schedule fields for a choice at `now`: the next time it falls on, and
 *  how often it repeats. Null for a one-off time already past. */
export function hostedSchedule(when: HostedWhen, now: number): { schedule_type: "recurring" | "once"; run_at: number; interval_ms?: number } | null {
  if (when.repeat === "now") return { schedule_type: "once", run_at: now };
  if (when.repeat === "once") {
    const [y, mo, d] = when.date.split("-").map(Number);
    if (!y || !mo || !d) return null;
    const at = atTime(new Date(y, mo - 1, d), when.time).getTime();
    return at > now ? { schedule_type: "once", run_at: at } : null;
  }
  const today = new Date(now);
  let next = atTime(today, when.time);
  if (when.repeat === "weekly") {
    const ahead = (when.weekday - today.getDay() + 7) % 7;
    next = atTime(new Date(today.getFullYear(), today.getMonth(), today.getDate() + ahead), when.time);
    if (next.getTime() <= now) next = atTime(new Date(next.getFullYear(), next.getMonth(), next.getDate() + 7), when.time);
    return { schedule_type: "recurring", run_at: next.getTime(), interval_ms: WEEK_MS };
  }
  if (next.getTime() <= now) next = atTime(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1), when.time);
  return { schedule_type: "recurring", run_at: next.getTime(), interval_ms: DAY_MS };
}

/** A stored routine as a choice, when it is one the picker can say: a daily
 *  or weekly repeat, or a single run. Null for anything else (every 3 hours),
 *  which the form keeps in its duration controls. */
export function hostedWhenOf(task: { schedule_type?: string; interval_ms?: number; run_at?: number } | undefined, now: number): HostedWhen | null {
  if (!task) return defaultHostedWhen(now);
  const at = task.run_at ? new Date(task.run_at) : null;
  const time = at ? `${pad(at.getHours())}:${pad(at.getMinutes())}` : "09:00";
  if (task.schedule_type === "recurring" && (task.interval_ms === DAY_MS || task.interval_ms === WEEK_MS)) {
    return { repeat: task.interval_ms === DAY_MS ? "daily" : "weekly", weekday: at?.getDay() ?? new Date(now).getDay(), time, date: localDateValue(at ?? new Date(now + DAY_MS)) };
  }
  if (task.schedule_type === "once" && at) return { repeat: "once", weekday: at.getDay(), time, date: localDateValue(at) };
  return null;
}

/** The plan's limits on routines, as the form says them under the picker. */
export function routineLimitLine(plan: { label: string; routines: { max: number | null } }, floorMs: number): string {
  const cadence = floorMs >= WEEK_MS ? "once a week" : floorMs >= DAY_MS ? "once a day" : floorMs >= 60 * 60 * 1000 ? "once an hour" : null;
  const parts = [
    plan.routines.max !== null ? `up to ${plan.routines.max} routine${plan.routines.max === 1 ? "" : "s"}` : null,
    cadence ? `each at most ${cadence}` : null,
  ].filter(Boolean);
  return parts.length ? `${plan.label} plan: ${parts.join(", ")}.` : "";
}
