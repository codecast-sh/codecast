// A routine that keeps a time on the person's clock: "weekdays at 8:00 AM",
// "every Sunday at 6:00 PM". A fixed interval drifts an hour at every
// daylight saving change and has no notion of a weekday, so a routine said as
// a time of day is stored as one and each run is found from the calendar of
// its zone. Pure, and built only on ./zone, so a server, a web page and a
// phone compute and word the same runs.
import { addDays, normalizeTimezone, wallClockAt, zonedInstant } from "./zone";

/** A time of day on some weekdays in one zone. `weekdays` holds 0 (Sunday)
 *  to 6, sorted and unique; all seven is every day. */
export interface WallCadence {
  zone: string;
  /** Minutes past local midnight. */
  minutes: number;
  weekdays: number[];
}

/** The weekday names a tool takes, in Date.getDay order. */
export const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

/** Weekday keys as sorted, unique day numbers; unknown keys are dropped. */
export function weekdayNumbers(keys: readonly string[]): number[] {
  const days = new Set<number>();
  for (const key of keys) {
    const at = WEEKDAY_KEYS.indexOf(key.trim().toLowerCase().slice(0, 3) as WeekdayKey);
    if (at >= 0) days.add(at);
  }
  return [...days].sort((a, b) => a - b);
}

/** The cadence a first run sets: its time of day on its zone's clock, on
 *  `weekdays` (every day when none are given). */
export function cadenceAt(firstRun: number, zone: string | null | undefined, weekdays?: readonly number[]): WallCadence {
  const timezone = normalizeTimezone(zone);
  const days = [...new Set(weekdays ?? [])].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
  return { zone: timezone, minutes: wallClockAt(firstRun, timezone).minutes, weekdays: days.length ? days : EVERY_DAY };
}

/** The first run of `cadence` strictly after `after`. */
export function nextCadenceRun(cadence: WallCadence, after: number): number {
  const days = cadence.weekdays.length ? cadence.weekdays : EVERY_DAY;
  const start = wallClockAt(after, cadence.zone).date;
  // Eight days always reach a listed weekday after today's slot has passed.
  for (let n = 0; n <= 8; n++) {
    const date = addDays(start, n);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (!days.includes(weekday)) continue;
    const at = zonedInstant(date, cadence.minutes, cadence.zone);
    if (at > after) return at;
  }
  return after + 7 * 24 * 60 * 60 * 1000;
}

/** Which days, as a person says them: "every day", "weekdays", "weekends",
 *  "every Monday", "Mondays and Thursdays". */
export function plainDays(weekdays: readonly number[]): string {
  const days = [...new Set(weekdays)].sort((a, b) => a - b);
  const key = days.join("");
  if (!days.length || key === "0123456") return "every day";
  if (key === "12345") return "weekdays";
  if (key === "06") return "weekends";
  if (days.length === 1) return `every ${WEEKDAY_NAMES[days[0]!]}`;
  const names = days.map((d) => `${WEEKDAY_NAMES[d]}s`);
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The time of day a cadence keeps, on its own clock: "8:00 AM". */
export function plainCadenceTime(cadence: WallCadence): string {
  const h = Math.floor(cadence.minutes / 60);
  const m = cadence.minutes % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** A cadence as one line: "weekdays at 8:00 AM", "every Sunday at 6:00 PM". */
export function plainCadence(cadence: WallCadence): string {
  return `${plainDays(cadence.weekdays)} at ${plainCadenceTime(cadence)}`;
}
