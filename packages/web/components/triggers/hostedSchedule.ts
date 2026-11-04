// A hosted-assistant routine's schedule as a person says it (plan pl-840):
// "Every day at 9:00 AM", "Every Monday at 9:00 AM", rather than a duration
// ("30m"). Pure, so its readers and its test share one rule.

import { plainCadence, type WallCadence } from "@platform/assistant/cadence";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** A stored routine's schedule fields, as the helpers below read them. A
 *  hosted routine said as a time of day carries its wall-clock `cadence`
 *  (convex assistant/routines.ts hostedWallCadence), which wins over the
 *  interval for words. */
type ScheduleFields = { schedule_type?: string; interval_ms?: number; run_at?: number; cadence?: WallCadence };

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

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
