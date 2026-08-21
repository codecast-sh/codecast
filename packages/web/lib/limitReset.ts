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

