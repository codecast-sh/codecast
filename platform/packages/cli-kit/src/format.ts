// Numbers and moments, spelled the same in every terminal view: cost,
// duration, tokens, a clock reading, a date. `relativeTime` in text.ts is the
// age formatter; these are the rest of the set union-mobile's agentRuns
// views settled on, so the CLI and a web page report identical figures.

export function formatCost(usd?: number | null): string {
  if (!usd) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatDuration(ms?: number | null): string {
  if (!ms) return "--";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/** Virtual time, which runs to days: "3.5h" under two days, "2.1d" past it. */
export function formatVirtual(ms: number): string {
  const hours = ms / 3_600_000;
  return hours < 48 ? `${hours.toFixed(1)}h` : `${(hours / 24).toFixed(1)}d`;
}

export function formatTokens(n?: number | null): string {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

const toDate = (d: Date | string | number | null | undefined): Date | null => {
  if (d === null || d === undefined) return null;
  const t = d instanceof Date ? d : new Date(d);
  return Number.isNaN(t.getTime()) ? null : t;
};

/** `2026-03-05 14:30`, UTC. What a log line and a table cell show. */
export function formatTimestamp(d: Date | string | number | null | undefined): string {
  const t = toDate(d);
  return t ? t.toISOString().slice(0, 16).replace("T", " ") : "--";
}

/** `14:30:12`, UTC. For dense chronological traces. */
export function formatClock(d: Date | string | number | null | undefined): string {
  const t = toDate(d);
  return t ? t.toISOString().slice(11, 19) : "--";
}

/** `03-05 14:30`: the date without the year, for a run that spans days. */
export function formatDayClock(d: Date | string | number | null | undefined): string {
  const t = toDate(d);
  return t ? t.toISOString().slice(5, 16).replace("T", " ") : "--";
}

/**
 * `d02 14:05`: days into a run plus the clock, the way a simulation reads.
 * A row a scenario seeded before its opening instant reads `d-1`.
 */
export function formatDayOffset(at: Date | string | number, start: Date | string | number): string {
  const t = toDate(at);
  const s = toDate(start);
  if (!t || !s) return "--";
  const minutes = Math.floor((t.getTime() - s.getTime()) / 60_000);
  const d = Math.floor(minutes / 1440);
  const minOfDay = minutes - d * 1440;
  const hh = String(Math.floor(minOfDay / 60)).padStart(2, "0");
  const mm = String(minOfDay % 60).padStart(2, "0");
  return `${d < 0 ? `d${d}` : `d${String(d).padStart(2, "0")}`} ${hh}:${mm}`;
}

/** The first eight characters: how every id is shown and what every command accepts. */
export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : "";
}
