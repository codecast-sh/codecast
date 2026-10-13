// A moment's times and delivery states as a reader says them (MomentView):
// ISO timestamps from now ("tomorrow 8:00 AM"), and a message's delivery as a
// badge ("Queued · sends tomorrow 8:00 AM"). Pure.

const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const DAY_MS = 86_400_000;
/** A time as a reader says it from now: "today 3:05 PM", "tomorrow 8:00 AM", "Oct 14 8:00 AM". */
export function whenWords(at: number, now = Date.now()): string {
  const day = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const diff = Math.round((day(at) - day(now)) / DAY_MS);
  const hm = clock(at);
  return diff === 0 ? `today ${hm}` : diff === 1 ? `tomorrow ${hm}` : diff === -1 ? `yesterday ${hm}` : `${new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${hm}`;
}
const ISO = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
/** Every ISO timestamp in a text said from now ("tomorrow 8:00 AM"). */
export const isoToWords = (text: string, now = Date.now()) => text.replace(ISO, (m) => { const t = Date.parse(m); return Number.isFinite(t) ? whenWords(t, now) : m; });

/** A message's delivery state as a badge: a queued send says when it goes, a held one that a person releases it. Null when it was delivered. */
export function deliveryBadge(delivery: string | null | undefined, now = Date.now()): { words: string; tone: "warn" | "bad" | "none" } | null {
  const d = (delivery ?? "").trim();
  if (!d || /^delivered$|^sent$/i.test(d)) return null;
  if (/fail|bounce/i.test(d)) return { words: "Failed", tone: "bad" };
  // Sent in the end, after being written earlier and held: when it was written, quietly.
  const held = /^sent;\s*written\s+(\S+)\s+and held/i.exec(d);
  if (held && Number.isFinite(Date.parse(held[1]))) return { words: `Held · written ${whenWords(Date.parse(held[1]), now)}`, tone: "none" };
  const at = /queued to go at\s+(\S+)/i.exec(d);
  if (at && Number.isFinite(Date.parse(at[1]))) return { words: `Queued · sends ${whenWords(Date.parse(at[1]), now)}`, tone: "warn" };
  if (/queued/i.test(d)) return { words: "Queued · next dispatch", tone: "warn" };
  if (/held for review/i.test(d)) return { words: "Held for review", tone: "warn" };
  if (/handed to the email provider/i.test(d)) return { words: "Sent · unconfirmed", tone: "warn" };
  return { words: isoToWords(d.replace(/^not yet delivered:?\s*/i, "")), tone: "warn" };
}

