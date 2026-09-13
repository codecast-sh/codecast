// The parts of a usage-limit banner the parked-session card renders. Claude
// Code prints one line ("You've hit your weekly limit · resets 7am (UTC)") and
// the card takes it apart: which window closed, when it opens again in the
// banner's own zone, and that instant resolved against the banner's timestamp
// so the card can count down in the viewer's clock.

// When a limit banner names its reset ("resets 8:40pm (America/New_York)"),
// resolve that wall-clock time in the named zone to the first instant at or
// after the banner's own timestamp. Lets the card say "the window reset at
// 8:40pm" instead of "paused until the limit resets" hours after the fact.
// Returns undefined when the banner carries no parseable reset.
export function parseLimitResetAt(message: string, bannerTs?: number): number | undefined {
  if (bannerTs == null) return undefined;
  const m = message.match(/resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i);
  if (!m) return undefined;
  let hour = Number(m[1]) % 12;
  if (m[3].toLowerCase() === "pm") hour += 12;
  const minute = Number(m[2] ?? "0");
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: m[4], hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" }).formatToParts(new Date(bannerTs));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
    const bannerMins = get("hour") * 60 + get("minute") + get("second") / 60;
    let delta = hour * 60 + minute - bannerMins;
    if (delta < 0) delta += 24 * 60;
    return bannerTs + delta * 60_000;
  } catch {
    return undefined;
  }
}

// Which window the banner names: "Weekly limit", "Session limit", or the
// generic "Usage limit" when the line carries no window ("You've hit your
// usage limit."). Works on the raw banner and on the card's shaped message
// (lead-in already stripped) alike.
export function limitWindowLabel(message: string): string {
  // The word right before "limit" names the window ("weekly", "session",
  // "Fable"); anything earlier ("You've hit your", "Claude") is lead-in.
  const m = message.match(/([A-Za-z]+)\s+limit\b/i);
  const word = m?.[1]?.toLowerCase();
  if (!word || word === "usage") return "Usage limit";
  return `${word.charAt(0).toUpperCase()}${word.slice(1)} limit`;
}

// The reset as the banner printed it, zone included ("7am UTC",
// "8:40pm America/New_York") — the provider's own words, kept so the viewer
// can check the card against the terminal. Undefined when the banner names no
// reset.
export function limitResetAsPrinted(message: string): string | undefined {
  const m = message.match(/resets?\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))\s*\(([^)]+)\)/i);
  return m ? `${m[1].replace(/\s+/g, "")} ${m[2]}` : undefined;
}

// The reset instant in the viewer's clock: "7:00 AM" today, "tomorrow 7:00 AM",
// or "Mon 7:00 AM" further out. `now` is the viewer's clock; the day words are
// relative to it, so a card left open overnight keeps reading true.
export function formatResetLocal(resetAt: number, now: number, timeZone?: string): string {
  const opts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) };
  const time = new Intl.DateTimeFormat("en-US", opts).format(new Date(resetAt));
  const dayOf = (ts: number) => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", ...(timeZone ? { timeZone } : {}) }).format(new Date(ts));
  const today = dayOf(now);
  const target = dayOf(resetAt);
  if (target === today) return time;
  if (target === dayOf(now + 86_400_000)) return `tomorrow ${time}`;
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", ...(timeZone ? { timeZone } : {}) }).format(new Date(resetAt));
  return `${weekday} ${time}`;
}
