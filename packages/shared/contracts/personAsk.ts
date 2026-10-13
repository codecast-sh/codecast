// A finding that asks a person to act (an agent's escalation: "Ask: Deliver,
// for the problem ..."), and the date its own words set for it
// (line-journeys.md LJ6.1 `ask`). The server reads the date off the whole
// detail when it feeds a finding, since the feeds carry only the head of a
// detail and the date often sits at its end; the web reads the same function.
// Pure.

/** A typed ask line, as Union's escalation filer writes it. */
export const ASK_LINE = /^Ask: ([^,\n]+), for the problem "([^"\n]+)"/m;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_MS = 86_400_000;

// "by Oct 15", "by Thu Oct 15", "decide by Oct 15", "by today (Oct 12)", "by tomorrow", "by 10/15", "by Friday".
const BY = new RegExp(
  String.raw`\bby\s+(?:(?:${DAYS.join("|")})[a-z]*,?\s+)?(?:(${MONTHS.join("|")})[a-z]*\.?\s+(\d{1,2})\b|(\d{1,2})/(\d{1,2})\b|(today|tonight|tomorrow)\b|(${DAYS.join("|")})[a-z]*day\b)`,
  "gi",
);

const dayStart = (t: number) => Math.floor(t / DAY_MS) * DAY_MS;

/**
 * The day an ask's words set for it, as the UTC midnight that starts it; null
 * when they set none. "Today", "tonight" and "tomorrow" count from when it was
 * written; a weekday alone is the next one after. A calendar date counts only
 * when it falls after the day it was written: a date on or before it reports
 * what happened ("no call by Oct 13"), it asks nothing. The first date that
 * counts is the deadline.
 */
export function askDueAt(text: string | null | undefined, writtenAt: number): number | null {
  if (!text) return null;
  const written = dayStart(writtenAt);
  const year = new Date(written).getUTCFullYear();
  for (const m of text.matchAll(BY)) {
    const [, monthWord, monthDay, numMonth, numDay, relative, weekday] = m;
    if (relative) return written + (relative.toLowerCase() === "tomorrow" ? DAY_MS : 0);
    if (weekday) {
      const want = DAYS.indexOf(weekday.slice(0, 3).toLowerCase());
      const ahead = ((want - new Date(written).getUTCDay() + 7) % 7) || 7;
      return written + ahead * DAY_MS;
    }
    const month = monthWord ? MONTHS.indexOf(monthWord.slice(0, 3).toLowerCase()) : Number(numMonth) - 1;
    const day = Number(monthDay ?? numDay);
    if (month < 0 || month > 11 || !(day >= 1 && day <= 31)) continue;
    // A date months behind the writing is next year's ("by Jan 5" written in December).
    let at = Date.UTC(year, month, day);
    if (at < written - 180 * DAY_MS) at = Date.UTC(year + 1, month, day);
    if (at > written) return at;
  }
  return null;
}

/** The deadline of a finding that asks a person to act; null when it is no ask or sets no date. */
export function personAskDue(detail: string | null | undefined, writtenAt: number): number | null {
  if (!detail || !ASK_LINE.test(detail)) return null;
  // The date is in the agent's own words, below the filer's lines; a date in "This one: ..., 2026-10-13T..." is no deadline.
  const fence = detail.indexOf("```");
  return askDueAt(fence >= 0 ? detail.slice(fence) : detail, writtenAt);
}
