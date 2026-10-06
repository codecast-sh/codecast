import type { SendDayRow } from "./userSend";
import type { UsageDayRow } from "./usageDaily";

// One credited slice of session activity, normalized across the three sources
// (live conversations, team_activity_events, session_insights). `hours` is the
// capped duration credit (exactly what the day heatmap has always added) and
// `end` is the legacy bucketing timestamp; `start` lets granular consumers
// distribute that credit across the hours the session actually spanned.
// `project` is the repo/folder basename — only the recent `conversations`
// branch knows it (events/insights don't carry a path), so consumers must
// treat it as best-effort. Used solely for anonymized distinct-project COUNTS.
export type ActivityInterval = { start: number; end: number; hours: number; msgs: number; project?: string | null };

// Hour-of-day bucketing shared by the authed and public punchcard queries:
// each session's credit is distributed across the (local date × hour) cells
// its interval overlaps, so the punchcard shows *when during the day* work
// actually happened. `tzOffsetMinutes` is the viewer's Date.getTimezoneOffset()
// — hour-of-day only means something in the viewer's local clock. (One offset
// is applied to the whole range, so cells across a DST switch can shift by an
// hour.) Returns only per-cell aggregates — nothing identifying leaks.
export function bucketPunchcardRows(intervals: ActivityInterval[], tzOffsetMinutes: number, sendDays?: SendDayRow[], usageDays?: UsageDayRow[]) {
  const HOUR = 3600000;
  const tzShift = tzOffsetMinutes * 60000;
  type Row = { hours: number[]; msgs: number[]; sends: number[]; words: number[]; tokens: number[]; spend: number[]; sessions: number[]; day_sessions: number };
  const rows: Record<string, Row> = {};
  const rowFor = (date: string) =>
    (rows[date] ||= {
      hours: new Array(24).fill(0),
      msgs: new Array(24).fill(0),
      sends: new Array(24).fill(0),
      words: new Array(24).fill(0),
      tokens: new Array(24).fill(0),
      spend: new Array(24).fill(0),
      sessions: new Array(24).fill(0),
      day_sessions: 0,
    });

  for (const iv of intervals) {
    // Bound the distribution loop: a zombie conversation idling for weeks
    // still only smears its (already 8h-capped) credit over the final 14d.
    let start = Math.min(iv.start, iv.end);
    if (iv.end - start > 14 * 24 * HOUR) start = iv.end - 14 * 24 * HOUR;
    const ls = start - tzShift;
    const le = iv.end - tzShift;
    const span = le - ls;
    const firstCell = Math.floor(ls / HOUR);
    const lastCell = Math.floor(le / HOUR);
    const touchedDates = new Set<string>();
    for (let cell = firstCell; cell <= lastCell; cell++) {
      const cellStart = cell * HOUR;
      const frac = span <= 0 ? 1 : (Math.min(le, cellStart + HOUR) - Math.max(ls, cellStart)) / span;
      if (frac <= 0) continue;
      const d = new Date(cellStart);
      const date = d.toISOString().split("T")[0];
      const hour = d.getUTCHours();
      const row = rowFor(date);
      row.hours[hour] += iv.hours * frac;
      row.msgs[hour] += iv.msgs * frac;
      row.sessions[hour]++;
      if (!touchedDates.has(date)) {
        touchedDates.add(date);
        row.day_sessions++;
      }
    }
  }

  // The day counters (sends, words, tokens, spend) are stored as (UTC day ×
  // UTC hour) buckets; re-project each bucket into the viewer's local clock
  // via a mid-bucket pseudo timestamp. Whole-hour offsets map exactly; :30
  // offsets land in the nearer cell.
  const project = (dayStart: number, utcHours: number[] | undefined, field: "sends" | "words" | "tokens" | "spend") => {
    for (let h = 0; h < 24; h++) {
      const n = utcHours?.[h] || 0;
      if (!n) continue;
      const local = dayStart + h * HOUR + HOUR / 2 - tzShift;
      const d = new Date(Math.floor(local / HOUR) * HOUR);
      rowFor(d.toISOString().split("T")[0])[field][d.getUTCHours()] += n;
    }
  };
  for (const day of sendDays ?? []) {
    project(day.day_start, day.hours, "sends");
    project(day.day_start, day.word_hours, "words");
  }
  for (const day of usageDays ?? []) {
    project(day.day_start, day.token_hours, "tokens");
    project(day.day_start, day.spend_hours, "spend");
  }

  return Object.entries(rows)
    .map(([date, r]) => ({
      date,
      hours: r.hours.map((h) => Math.round(h * 100) / 100),
      msgs: r.msgs.map((m) => Math.round(m)),
      sends: r.sends,
      words: r.words,
      tokens: r.tokens,
      spend: r.spend.map((v) => Math.round(v * 100) / 100),
      sessions: r.sessions,
      day_sessions: r.day_sessions,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
