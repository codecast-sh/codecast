// When a hosted routine runs, as a person says it (plan pl-840): every day or
// every week on a weekday at a time, or once on a date at a time, rather than
// a duration ("30m"). Pure, so the form and its test read one rule. The form
// turns a choice into the same schedule fields a duration makes
// (schedule_type, run_at, interval_ms), so the backend and its plan check
// (routineRefusal) see nothing new.

import { plainCadence, type WallCadence } from "@platform/assistant/cadence";
import { taskStateLabel } from "../triggerCadence";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** A stored routine's schedule fields, as the helpers below read them. A
 *  hosted routine said as a time of day carries its wall-clock `cadence`
 *  (convex assistant/routines.ts hostedWallCadence), which wins over the
 *  interval for words. */
type ScheduleFields = { schedule_type?: string; interval_ms?: number; run_at?: number; cadence?: WallCadence };

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

/** The plan's limits on routines, as the form says them under the picker.
 *  `armed` counts the person's other running routines: at the plan's limit
 *  the line says what to do, since a new one would be refused (the plan
 *  runs the oldest, routineRefusal in contracts/assistant). */
export function routineLimitLine(plan: { label: string; routines: { max: number | null } }, floorMs: number, armed = 0): string {
  const cadence = floorMs >= WEEK_MS ? "once a week" : floorMs >= DAY_MS ? "once a day" : floorMs >= 60 * 60 * 1000 ? "once an hour" : null;
  const { max } = plan.routines;
  const parts = [
    max !== null ? `up to ${max} routine${max === 1 ? "" : "s"} at a time` : null,
    cadence ? `each at most ${cadence}` : null,
  ].filter(Boolean);
  const line = parts.length ? `${plan.label} plan: ${parts.join(", ")}.` : "";
  if (max !== null && armed >= max) return `${line} ${armed === 1 ? "One is" : `${armed} are`} running already, so pause one to make room for this.`;
  return line;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** A repeat that is not a whole day or week, in words: "30 minutes", "3 hours". */
function intervalWords(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return plural(Math.max(1, minutes), "minute");
  if (minutes % (60 * 24) === 0) return plural(minutes / (60 * 24), "day");
  if (minutes % 60 === 0) return plural(minutes / 60, "hour");
  return `${plural(Math.floor(minutes / 60), "hour")} ${plural(minutes % 60, "minute")}`;
}

/** A stored routine's schedule as a person says it, in the words the form
 *  uses: "Every day at 9:00 AM", "Every Monday at 9:00 AM", "Every 30
 *  minutes", "Once, Oct 9 at 9:00 AM". Null for a schedule this cannot say
 *  (an event), which the caller words its own way. */
export function describeHostedCadence(task: ScheduleFields): string | null {
  if (task.schedule_type === "recurring" && task.cadence) {
    const line = plainCadence(task.cadence);
    return line.charAt(0).toUpperCase() + line.slice(1);
  }
  const at = task.run_at ? new Date(task.run_at) : null;
  const time = at ? at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
  if (task.schedule_type === "recurring" && task.interval_ms) {
    if (task.interval_ms === DAY_MS) return time ? `Every day at ${time}` : "Every day";
    if (task.interval_ms === WEEK_MS) return at ? `Every ${WEEKDAYS[at.getDay()]} at ${time}` : "Every week";
    return `Every ${intervalWords(task.interval_ms)}`;
  }
  if (task.schedule_type === "once") {
    return at ? `Once, ${at.toLocaleDateString([], { month: "short", day: "numeric" })} at ${time}` : "Once";
  }
  return null;
}

/** What a routine row adds after its schedule about the next run, or null
 *  when the schedule already says it. "Every day at 9:00 AM" needs only
 *  "today" or "tomorrow"; a weekly one only on those days; a once routine
 *  names its date already. A run within the hour reads "in 25 min" whatever
 *  the cadence, and any other interval says the time. Only for a scheduled
 *  routine with a run ahead; other states read their own word. */
export function hostedNextWords(task: ScheduleFields, now: number): string | null {
  if (!task.run_at || task.run_at <= now) return null;
  const until = task.run_at - now;
  if (until < 60 * 60 * 1000) return `in ${Math.max(1, Math.round(until / 60_000))} min`;
  if (task.schedule_type === "once") return null;
  const at = new Date(task.run_at);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(at) - startOf(new Date(now))) / DAY_MS);
  const day = days === 0 ? "today" : days === 1 ? "tomorrow" : null;
  if (task.cadence || task.interval_ms === DAY_MS || task.interval_ms === WEEK_MS) return day ?? (task.cadence && task.cadence.weekdays.length > 1 && task.cadence.weekdays.length < 7 ? WEEKDAYS[at.getDay()] : null);
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return day ? `next ${day} at ${time}` : `next ${at.toLocaleDateString([], { month: "short", day: "numeric" })} at ${time}`;
}

/** When a new routine first runs, as the form says it under When: "right
 *  away", "today at 9:00 AM", "tomorrow at 9:00 AM", or the day and date
 *  past that. */
export function firstRunWords(runAt: number, now: number): string {
  if (runAt <= now + 60_000) return "right away";
  const at = new Date(runAt);
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(at) - startOf(new Date(now))) / DAY_MS);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days < 7) return `${WEEKDAYS[at.getDay()]} at ${time}`;
  return `${at.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} at ${time}`;
}

/** When a plain (hosted) routine runs next, labelled so it never reads as
 *  the last run: "Next: today at 8:00 AM", in the words the form and the card
 *  use for a first run. With no run ahead, the state word ("Paused").
 *  The list row (TriggerRow), the routine's page and the rail's footer
 *  (GlobalSessionPanel) read this one rule. */
export function plainNextRun(task: ScheduleFields & { status: string; run_count?: number; last_run_at?: number }, now: number): string {
  const ended = plainEndedWords(task);
  if (ended) return ended;
  const next = task.status === "scheduled" && task.run_at !== undefined && task.run_at > now
    ? `Next: ${firstRunWords(task.run_at, now)}`
    : taskStateLabel(task, now);
  return next.charAt(0).toUpperCase() + next.slice(1);
}

/** How a routine that no longer runs reads in hosted mode, or null while it
 *  still runs: a one-off that ran is "Finished"; anything else that ended
 *  was stopped, never "Done", with its last run or "Never ran" so a routine
 *  stopped before it fired says so. */
export function plainEndedWords(task: { status: string; schedule_type?: string; run_count?: number; last_run_at?: number }): string | null {
  const day = (at: number) => new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
  const last = task.last_run_at ? `Last ran ${day(task.last_run_at)}` : (task.run_count ?? 0) > 0 ? null : "Never ran";
  if (task.status === "failed") return last ? `Didn't finish · ${last}` : "Didn't finish";
  if (task.status !== "completed" && task.status !== "cancelled") return null;
  if (task.schedule_type === "once" && (task.run_count ?? 0) > 0) return task.last_run_at ? `Finished ${day(task.last_run_at)}` : "Finished";
  return last ? `Stopped · ${last}` : "Stopped";
}

/** A routine a newcomer can start from: what it does, and when, as a choice
 *  the picker holds. Each needs only what works today unless `mail` says the
 *  person's mail is connected (the same split as lane.ts firstAsks). */
export interface RoutineExample {
  /** The tap target, cadence included: "Every Monday at 9, help me plan the week". */
  label: string;
  /** What the routine asks each time, without the cadence the picker holds. */
  prompt: string;
  when: Pick<HostedWhen, "repeat" | "weekday" | "time">;
}

export function routineExamples(mail: boolean): RoutineExample[] {
  return [
    { label: "Every Monday at 9, help me plan the week", prompt: "Help me plan the week with a short checklist.", when: { repeat: "weekly", weekday: 1, time: "09:00" } },
    { label: "Each evening, list what's still open", prompt: "List my to-dos that are still open, most pressing first.", when: { repeat: "daily", weekday: 0, time: "18:00" } },
    mail
      ? { label: "Every morning at 8, tell me what came in overnight", prompt: "Tell me what came in overnight that matters, in a few lines.", when: { repeat: "daily", weekday: 0, time: "08:00" } }
      : { label: "Every morning at 8, a short news summary", prompt: "Give me a short summary of today's top news.", when: { repeat: "daily", weekday: 0, time: "08:00" } },
  ];
}

/** An example as the form's seed: a hosted routine with the example's prompt
 *  and its next run, so the form opens filled and the picker says its when. */
export function routineExampleSeed(example: RoutineExample, now: number) {
  const schedule = hostedSchedule({ ...example.when, date: localDateValue(new Date(now + DAY_MS)) }, now);
  // A routine the person picked runs as written, like one they typed.
  return { prompt: example.prompt, hosted_home: true, mode: "apply" as const, ...schedule };
}
