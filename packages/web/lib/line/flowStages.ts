// The line as one continuous flow (learning-loop.md LL1): the stream stations
// that run once per moment (what arrives, the expectations judged against, the
// judges, grouping), the dispatcher that hands problems to runs, the run
// stations per problem (the graph's own), and the decision. Each stage carries
// its counts as the band draws them. Pure: the store rows in, numbers and
// words out, so a test pins what each stage says.

import { isPractice, needsOfLine, type LineNeed } from "./lineNeeds";

export const DAY = 86_400_000;

/** What For you lists for one line (ForYouView: the counted needs of the line, in its project), and how many of them
 *  are a trial's practice decisions, which it lists apart, last. The Decision stage reads these numbers. */
export function forYouOfLine(needs: ReadonlyArray<LineNeed>, line: string, project: string | null): { total: number; practice: number } {
  const list = needsOfLine(needs.filter((n) => n.counted), line, project);
  const practice = list.filter(isPractice).length;
  return { total: list.length, practice };
}

/** How the moments of one kind are arriving, from arrivals per day (oldest first, today last). */
export type Arrival = { tone: "live" | "quiet" | "none"; today: number; week: number; lastAt: number | null };

/** Live when anything arrived in the last day; quiet when the newest arrival is older; none when nothing ever did. */
export function arrivalOf(days: readonly number[], newestAt: number | null, now: number): Arrival {
  const today = days[days.length - 1] ?? 0;
  const week = days.slice(-7).reduce((a, b) => a + b, 0);
  if (!newestAt) return { tone: "none", today, week, lastAt: null };
  return { tone: now - newestAt < DAY ? "live" : "quiet", today, week, lastAt: newestAt };
}

/** The several kinds' arrivals as one: the newest arrival, the day's and week's sums, and per day. */
export function sumArrivals(kinds: ReadonlyArray<{ days: readonly number[]; newest_at: number | null }>, now: number): Arrival & { days: number[] } {
  const n = kinds.reduce((m, k) => Math.max(m, k.days.length), 0);
  const days = Array.from({ length: n }, (_, i) => kinds.reduce((s, k) => s + (k.days[i - (n - k.days.length)] ?? 0), 0));
  const newest = kinds.reduce<number | null>((m, k) => (k.newest_at && (!m || k.newest_at > m) ? k.newest_at : m), null);
  return { ...arrivalOf(days, newest, now), days };
}

/** How long ago, in the fewest words that read: "4 min", "5 h", "5 days". */
export function agoWords(at: number | null, now: number): string {
  if (!at) return "never";
  const ms = Math.max(0, now - at);
  if (ms < 60 * 60_000) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (ms < DAY) return `${Math.round(ms / 3_600_000)} h`;
  const d = Math.round(ms / DAY);
  return `${d} ${d === 1 ? "day" : "days"}`;
}

/** How grouping placed a finding (signals.attach), as a person reads it, in the order the rule tries them. */
export const PLACEMENTS = [
  { key: "fingerprint", label: "Same key", tone: "plain" },
  { key: "message", label: "Same message", tone: "plain" },
  { key: "similar", label: "Read the same", tone: "plain" },
  { key: "judge", label: "Attach judge chose", tone: "judge" },
  { key: "new", label: "Opened a problem", tone: "new" },
  { key: "person", label: "A person filed", tone: "person" },
  { key: "held", label: "Held, no problem", tone: "held" },
] as const;
export type PlacementKey = (typeof PLACEMENTS)[number]["key"];

type Placed = { attach?: string | null; created_at: number; project_id?: string | null; source?: string };

/** A case a person's "Judge is wrong" made against a judge (learning-loop.md LL11): grouped onto the judge's own
 *  problems, not a finding about the product. */
export const isJudgeCase = (s: { source?: string }) => s.source === "judge-review";

/** The live findings of `projectId` placed in the window (cases against a judge left out), counted by how grouping
 *  placed them, in PLACEMENTS order. */
export function placementMix(signals: readonly Placed[], projectId: string | null, since: number): Array<{ key: PlacementKey; label: string; tone: string; n: number }> {
  const n = new Map<string, number>();
  for (const s of signals) {
    if (s.created_at < since || (projectId && s.project_id !== projectId) || isJudgeCase(s)) continue;
    const k = s.attach ?? "held";
    n.set(k, (n.get(k) ?? 0) + 1);
  }
  return PLACEMENTS.map((p) => ({ ...p, n: n.get(p.key) ?? 0 })).filter((p) => p.n > 0);
}

/** A judge's marked-wrong share, as the band and its page say it: "4%" of its judged findings, or null with none judged. */
export function wrongShare(wrong: number, judged: number): string | null {
  if (!judged) return null;
  const p = (wrong / judged) * 100;
  return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
}

/** Dollars as a screen shows them: "$1,618", "$6.29" under $10, "$0" for nothing. */
export function usd(n: number | null | undefined): string {
  if (n == null) return "–";
  if (n === 0) return "$0";
  return n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n).toLocaleString("en-US")}`;
}

/** A blob sha or a document number as a version chip: "v12", "ae375ee". */
export const versionWords = (v: string | number | null | undefined): string | null => (v == null || v === "" ? null : /^\d+$/.test(String(v)) ? `v${v}` : String(v).slice(0, 7));
