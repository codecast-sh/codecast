// Numbers and times the way people say them (DESIGN 3: "Numbers are human").

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Chat timestamps: "now", "2m", then the clock ("4:12"), then the date. */
export function chatTime(at: number, now: number): string {
  const age = now - at;
  if (age < MIN) return "now";
  if (age < HOUR) return `${Math.floor(age / MIN)}m`;
  const d = new Date(at);
  if (age < DAY) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M$/i, "");
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** History: "just now", "6 min ago", "3 h ago", "yesterday", "Oct 2". */
export function ago(at: number, now: number): string {
  const age = Math.max(0, now - at);
  if (age < MIN) return "just now";
  if (age < HOUR) return `${Math.floor(age / MIN)} min ago`;
  if (age < DAY) return `${Math.floor(age / HOUR)} h ago`;
  if (age < 2 * DAY) return "yesterday";
  return new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** "since Sunday", "since today", "since Oct 2". */
export function since(at: number, now: number): string {
  const age = now - at;
  if (age < DAY && new Date(at).getDate() === new Date(now).getDate()) return "since today";
  if (age < 6 * DAY) return `since ${new Date(at).toLocaleDateString([], { weekday: "long" })}`;
  return `since ${new Date(at).toLocaleDateString([], { month: "short", day: "numeric" })}`;
}

/** A running build's clock: "0:11", "1:05". */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A fork's suggested name, "{app}, {you}'s take", within `max` characters.
 *  A fork of a fork keeps one "take", and a long app name gives way on a word
 *  boundary rather than cutting your name. */
export function forkName(app: string, you: string, max: number): string {
  const take = `, ${you}'s take`;
  let base = app.replace(/, [^,]+'s take$/, "");
  if (base.length + take.length > max) {
    base = base.slice(0, Math.max(0, max - take.length)).replace(/[\s,]+\S*$/, "") || base.slice(0, max - take.length);
  }
  return `${base}${take}`.slice(0, max);
}
