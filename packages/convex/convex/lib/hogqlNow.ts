// Binding a HogQL query's now() to a past instant (PostHog metric history,
// sources/posthog.ts fetchMetricHistory): a query that reads the clock some
// other way cannot be moved, and a comparison against now() names the window.

/** Clock reads other than now(): a query using one cannot be moved to a past instant. */
const OTHER_CLOCKS = /\b(today|yesterday|now64|nowInBlock|current_timestamp|current_date|currentDate|currentTimestamp|localtimestamp|utc_timestamp|unix_timestamp)\b/i;
const UNIT_MS: Record<string, number> = { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 7 * 864e5, month: 30 * 864e5, quarter: 91 * 864e5, year: 365 * 864e5 };
const UNITS = "second|minute|hour|day|week|month|quarter|year";
/** `<column> <op> ` right before a now(). */
const BEFORE_NOW = /([A-Za-z_][\w.]*)\s*(>=|<=|>|<)\s*$/;
/** What may come before a column compared against now(): the start, a paren, a comma, or a clause or boolean word. */
const COMPARISON_OPENS = /(^|[(,]|\b(?:and|or|not|where|prewhere|having|on|when|then|else))\s*$/i;
/** An optional ` - interval N unit` (or toIntervalUnit(N)) right after a now(). */
const AFTER_NOW = new RegExp(`^\\s*-\\s*(?:interval\\s+(\\d+)\\s+(${UNITS})s?\\b|toInterval(${UNITS})\\s*\\(\\s*(\\d+)\\s*\\))`, "i");

/**
 * The query with string literals, quoted names and comments blanked to
 * spaces at the same offsets, so a search sees only code. Null when a quote
 * or comment never closes.
 */
export function hogqlCodeOnly(q: string): string | null {
  let out = "";
  let i = 0;
  while (i < q.length) {
    const c = q[i];
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      for (; j < q.length; j++) {
        if (q[j] === "\\") j++;
        else if (q[j] === c) {
          if (q[j + 1] === c) j++;
          else break;
        }
      }
      if (j >= q.length) return null;
      out += " ".repeat(j + 1 - i);
      i = j + 1;
    } else if (c === "-" && q[i + 1] === "-") {
      const end = q.indexOf("\n", i);
      const j = end === -1 ? q.length : end;
      out += " ".repeat(j - i);
      i = j;
    } else if (c === "/" && q[i + 1] === "*") {
      const end = q.indexOf("*/", i + 2);
      if (end === -1) return null;
      out += " ".repeat(end + 2 - i);
      i = end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** A past instant as HogQL reads it: second precision, UTC. */
export function hogqlInstant(at: number): string {
  return `toDateTime('${new Date(Math.floor(at / 1000) * 1000).toISOString().replace(".000Z", "Z")}')`;
}

export type BoundQuery = { ok: true; query: string; window_ms: number | null } | { ok: false; error: string };

/**
 * A HogQL watch query as it would have read at `at`: every now() becomes a
 * fixed instant. Only a now() compared straight against a column
 * (`timestamp > now() - interval 1 day`, `timestamp < now()`) is bound; a
 * lower bound also gains `<column> <= <instant>`, because the window the
 * query names must end at the instant, not at the present. Anything else
 * that reads the clock is refused, since binding it would quietly answer a
 * different question. `window_ms` is the longest lower-bound window, so the
 * caller can space points by it.
 */
export function bindHogqlNow(query: string, at: number): BoundQuery {
  const code = hogqlCodeOnly(query);
  if (code === null) return { ok: false, error: "The query has an unclosed quote or comment" };
  const clock = OTHER_CLOCKS.exec(code);
  if (clock) return { ok: false, error: `The query reads the clock through ${clock[1]}(), which cannot be moved to a past instant; use now()` };
  const instant = hogqlInstant(at);
  const edits: { start: number; end: number; text: string }[] = [];
  let window: number | null = null;
  const calls = /\bnow\s*\(/gi;
  for (let m = calls.exec(code); m; m = calls.exec(code)) {
    // The original text, not the blanked one: now('UTC') blanks to now(     ).
    const close = /^\s*\)/.exec(query.slice(m.index + m[0].length));
    if (!close) return { ok: false, error: "now() with an argument cannot be bound to a past instant" };
    const nowEnd = m.index + m[0].length + close[0].length;
    const before = BEFORE_NOW.exec(code.slice(0, m.index));
    const after = AFTER_NOW.exec(code.slice(nowEnd));
    const end = nowEnd + (after ? after[0].length : 0);
    const start = m.index - (before?.[0].length ?? 0);
    // The comparison must stand alone: anything but a clause or a boolean
    // before the column, or arithmetic after the bound, makes it another one.
    const next = code.slice(end).trimStart()[0];
    if (!before || !COMPARISON_OPENS.test(code.slice(0, start)) || (next && "+-*/%(".includes(next))) {
      return { ok: false, error: "Only a now() compared straight against a column (timestamp > now() - interval 1 day) can be bound to a past instant" };
    }
    const [, column, op] = before;
    const shift = query.slice(nowEnd, end);
    if (op.startsWith(">")) {
      const n = after ? Number(after[1] ?? after[4]) : 0;
      const unit = (after?.[2] ?? after?.[3] ?? "").toLowerCase();
      if (after) window = Math.max(window ?? 0, n * UNIT_MS[unit]);
      edits.push({ start, end, text: `(${column} ${op} ${instant}${shift} AND ${column} <= ${instant})` });
    } else {
      edits.push({ start: m.index, end: nowEnd, text: instant });
    }
  }
  if (!edits.length) return { ok: false, error: "The query has no now() to bind, so every past instant would read the same" };
  let out = query;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return { ok: true, query: out, window_ms: window };
}
