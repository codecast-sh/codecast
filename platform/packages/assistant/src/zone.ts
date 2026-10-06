// Calendar days and wall clocks in an IANA time zone. Day bounds come from
// the zone's real offsets, so a DST day is 23 or 25 hours long and a day whose
// midnight is skipped starts at the first instant that exists. Pure and
// dependency free, so a server, a web page and a phone cut days the same way.

const DAY_MS = 24 * 60 * 60 * 1000;

/** A local day in one zone: its YYYY-MM-DD and its bounds, `start` inclusive
 *  and `end` exclusive (the next day's start). */
export type ZonedDay = { date: string; start: number; end: number; timezone: string };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(zone, f);
  }
  return f;
}

/** `zone` when it names a real IANA zone, else UTC. */
export function normalizeTimezone(zone: string | null | undefined): string {
  if (!zone) return "UTC";
  try { formatterFor(zone); return zone; } catch { return "UTC"; }
}

/** The wall clock in `zone` at instant `t`, read back as if it were UTC. */
function wallAsUtc(t: number, zone: string): number {
  const p = Object.fromEntries(formatterFor(zone).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
}

/** The zone's offset from UTC at instant `t`, in ms (east positive). */
function offsetAt(t: number, zone: string): number {
  return wallAsUtc(t, zone) - Math.floor(t / 1000) * 1000;
}

function isoDate(wall: number): string {
  return new Date(wall).toISOString().slice(0, 10);
}

/** The YYYY-MM-DD `n` calendar days after `date` (negative for before). */
export function addDays(date: string, n: number): string {
  return isoDate(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS);
}

/** The local date in `zone` at instant `t`. */
export function localDate(t: number, zone: string): string {
  return isoDate(wallAsUtc(t, normalizeTimezone(zone)));
}

/** The wall clock in `zone` at instant `t`: its local date, minutes past
 *  local midnight, and weekday (0 is Sunday). An unknown zone reads as UTC. */
export function wallClockAt(t: number, zone: string | null | undefined): { date: string; minutes: number; weekday: number } {
  const wall = wallAsUtc(t, normalizeTimezone(zone));
  return { date: isoDate(wall), minutes: Math.floor((((wall % DAY_MS) + DAY_MS) % DAY_MS) / 60_000), weekday: new Date(wall).getUTCDay() };
}

/** The first instant of `date` in `zone`. The offset at local midnight is the
 *  one in force a day before or a day after (zones change offset months
 *  apart), so both are tried and the earliest instant that still reads as
 *  `date` wins. That also answers a skipped midnight with the moment the
 *  clocks jump to, and a repeated one with its first occurrence. */
function startOfDate(date: string, zone: string): number {
  const wall = Date.parse(`${date}T00:00:00Z`);
  const candidates = [offsetAt(wall - DAY_MS, zone), offsetAt(wall + DAY_MS, zone)]
    .map((offset) => wall - offset)
    .filter((t) => localDate(t, zone) === date);
  return Math.min(...candidates);
}

/** The bounds of `date` in `zone`. */
export function dayBounds(date: string, zone: string | null | undefined): ZonedDay {
  const timezone = normalizeTimezone(zone);
  return {
    date,
    start: startOfDate(date, timezone),
    end: startOfDate(addDays(date, 1), timezone),
    timezone,
  };
}

/** The day in `zone` that contains instant `t`. */
export function zonedDay(t: number, zone: string | null | undefined): ZonedDay {
  const timezone = normalizeTimezone(zone);
  return dayBounds(localDate(t, timezone), timezone);
}
