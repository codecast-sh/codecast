// Where the viewer's messages went (the bottom of /priorities): each
// workspace's typing per day (convex priorities.history) split by where the
// viewer's priorities rank today (priorityRanks.mine). There is no rank
// history, so past days use today's ranks.
import type { PriorityHistory } from "@codecast/shared/contracts/priorities";

/** Top to bottom of a day's stack: no priority, priorities 4+, priorities 1–3. */
export const TIERS = [
  { key: "none", word: "No priority", fill: "var(--sol-text-dim)", opacity: 0.3 },
  { key: "rest", word: "Priorities 4+", fill: "var(--sol-green)", opacity: 0.45 },
  { key: "top", word: "Priorities 1–3", fill: "var(--sol-green)", opacity: 1 },
] as const;
export type Tier = (typeof TIERS)[number]["key"];
export type BreakdownDay = Record<Tier, number> & { total: number };
export type WorkspaceDays = { workspace: string; name: string; days: BreakdownDay[]; total: number };

const empty = (): BreakdownDay => ({ top: 0, rest: 0, none: 0, total: 0 });

/**
 * One workspace's `days`, each split three ways: lanes with no priority, the
 * viewer's active priorities ranked 1–3 (`rank`: by short id, the viewer's
 * own active priorities only), and every other priority lane.
 * Teammates' lanes (any `owner`, even a blank name) are not the viewer's typing and are skipped.
 */
export function splitDays(history: PriorityHistory | undefined, rank: ReadonlyMap<string, number>, days: readonly string[]): BreakdownDay[] {
  return days.map((d) => {
    const out = empty();
    const at = history ? history.days.indexOf(d) : -1;
    if (!history || at === -1) return out;
    for (const lane of history.lanes) {
      if (lane.owner !== undefined) continue;
      const c = lane.counts[at] ?? 0;
      if (c <= 0) continue;
      const r = lane.short_id ? rank.get(lane.short_id) : null;
      out[!lane.short_id ? "none" : r != null && r <= 3 ? "top" : "rest"] += c;
      out.total += c;
    }
    return out;
  });
}

/** The workspaces to draw: those with messages in the window, busiest first. */
export function busiestFirst(spaces: readonly WorkspaceDays[]): WorkspaceDays[] {
  return spaces.filter((s) => s.total > 0).sort((a, b) => b.total - a.total);
}

/** Every workspace's messages on each of `n` days. */
export function dayTotals(spaces: readonly WorkspaceDays[], n: number): number[] {
  return Array.from({ length: n }, (_, i) => spaces.reduce((c, s) => c + (s.days[i]?.total ?? 0), 0));
}

/**
 * A day's bar height in px on a sqrt scale against the busiest workspace-day
 * (`peak`), so a quiet day still shows. Tall enough for each non-empty segment
 * to keep 2px and a 1px gap.
 */
export function barHeight(day: BreakdownDay, peak: number, max: number): number {
  if (day.total <= 0) return 0;
  const parts = TIERS.filter((t) => day[t.key] > 0).length;
  return Math.min(max, Math.max(4, 3 * parts - 1, Math.round(Math.sqrt(day.total / Math.max(1, peak)) * max)));
}

/**
 * Each tier's px in a bar `height` tall with 1px between parts: 2px each,
 * the rest shared by messages, whole pixels by largest remainder so they sum
 * to the bar.
 */
export function segmentHeights(day: BreakdownDay, height: number): Record<Tier, number> {
  const out: Record<Tier, number> = { top: 0, rest: 0, none: 0 };
  const parts = TIERS.filter((t) => day[t.key] > 0).map((t) => t.key);
  if (!parts.length) return out;
  const spare = Math.max(0, height - (parts.length - 1) - 2 * parts.length);
  const raw = parts.map((k) => (spare * day[k]) / day.total);
  let left = spare - raw.reduce((c, r) => c + Math.floor(r), 0);
  const byRemainder = parts.map((_, i) => i).sort((a, b) => raw[b] - Math.floor(raw[b]) - (raw[a] - Math.floor(raw[a])));
  parts.forEach((k, i) => { out[k] = 2 + Math.floor(raw[i]); });
  for (const i of byRemainder) {
    if (left-- <= 0) break;
    out[parts[i]] += 1;
  }
  return out;
}

/** A whole-number percent, 0 when there is nothing to divide by. */
export function percent(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

/** "Wed, Nov 25" for a local day key. */
export const dayDate = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

/** A day column's accessible text: "Wed, Nov 25: 12 messages, 1–3 6, 4+ 4, no priority 2". */
export function dayAriaLabel(label: string, day: BreakdownDay): string {
  return `${label}: ${day.total} message${day.total === 1 ? "" : "s"}, 1–3 ${day.top}, 4+ ${day.rest}, no priority ${day.none}`;
}
