// What a repo share exposes, in numbers a person can read before they click:
// how many sessions, from when to when, and the words on the button. Pure, so
// the setup flows, the settings page and the CLI copy agree on one wording.
import { formatShortDate } from "../time";

/** One directory's true count and start span (users.shareImpactForPaths). */
export type PathShareSummary = {
  count: number;
  first_started_at: number | null;
  last_started_at: number | null;
  truncated: boolean;
};

/** A picker row's own numbers: a recent window, so a lower bound. */
export type ProjectCounts = {
  path: string;
  session_count: number;
  first_active?: number;
  last_active: number;
};

export type ShareImpact = {
  repos: number;
  sessions: number;
  first: number | null;
  last: number | null;
  /** The count hit the scan cap: read "1,024+". */
  truncated: boolean;
  /** Every selected path has an exact summary; false while the preview loads. */
  exact: boolean;
};

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/** "Jun 3 to today", "Jun 3 to Sep 22", "today", "Sep 22"; "" without dates. */
export function formatDateRange(first: number | null, last: number | null, now: number = Date.now()): string {
  if (first == null && last == null) return "";
  const a = first ?? last!;
  const b = last ?? first!;
  const bLabel = sameDay(b, now) ? "today" : formatShortDate(b, now);
  if (sameDay(a, b)) return bLabel;
  return `${formatShortDate(a, now)} to ${bLabel}`;
}

export function formatSessionCount(n: number, truncated = false): string {
  if (n === 0) return "no sessions";
  const num = n.toLocaleString("en-US") + (truncated ? "+" : "");
  return `${num} session${n === 1 && !truncated ? "" : "s"}`;
}

/** Fold the selected paths into one total, exact where the preview answered
 *  and the row's own window count where it has not yet. */
export function summarizeShareImpact(
  selectedPaths: string[],
  exact: Record<string, PathShareSummary> | undefined,
  rows: ProjectCounts[] | undefined,
): ShareImpact {
  const byPath = new Map((rows ?? []).map((r) => [r.path, r]));
  let sessions = 0;
  let first: number | null = null;
  let last: number | null = null;
  let truncated = false;
  let allExact = true;
  const fold = (count: number, a: number | null | undefined, b: number | null | undefined) => {
    sessions += count;
    if (a != null && Number.isFinite(a)) first = first == null ? a : Math.min(first, a);
    if (b != null && Number.isFinite(b)) last = last == null ? b : Math.max(last, b);
  };
  for (const path of selectedPaths) {
    const e = exact?.[path];
    if (e) {
      fold(e.count, e.first_started_at, e.last_started_at);
      truncated = truncated || e.truncated;
      continue;
    }
    allExact = false;
    const row = byPath.get(path);
    if (row) fold(row.session_count, row.first_active ?? row.last_active, row.last_active);
  }
  return { repos: selectedPaths.length, sessions, first, last, truncated, exact: allExact };
}

function repoWord(n: number): string {
  return `${n} repo${n === 1 ? "" : "s"}`;
}

/** The primary button: what the click does, with the number it exposes.
 *  Null when nothing is selected, so the caller keeps its idle label. */
export function shareActionLabel(impact: ShareImpact, includePast: boolean): string | null {
  if (impact.repos === 0) return null;
  if (!includePast) return `Share ${repoWord(impact.repos)} from today`;
  if (impact.sessions === 0) return `Share ${repoWord(impact.repos)}`;
  return `Share ${repoWord(impact.repos)} · ${formatSessionCount(impact.sessions, impact.truncated)}`;
}

/** "3 teammates", "1 teammate", "no teammates yet". */
export function describeTeammates(memberCount: number | undefined): string {
  const others = Math.max(0, (memberCount ?? 1) - 1);
  if (others === 0) return "no teammates yet";
  return `${others} teammate${others === 1 ? "" : "s"}`;
}

/** The count and span line under the summary, worded for the switch state. */
export function describeShareSpan(impact: ShareImpact, includePast: boolean, now: number = Date.now()): string {
  const count = formatSessionCount(impact.sessions, impact.truncated);
  const range = formatDateRange(impact.first, impact.last, now);
  if (impact.sessions === 0) return "No sessions there yet. New ones will be visible as they happen.";
  if (includePast) return range ? `${count}, ${range}.` : `${count}.`;
  return `Sessions from today on. The ${count} you already have${range ? ` (${range})` : ""} stay private.`;
}

/** "codecast", "codecast and mail", "codecast, mail and 2 more". */
export function listNames(names: string[], max = 3): string {
  if (names.length <= max) {
    if (names.length <= 1) return names[0] ?? "";
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }
  return `${names.slice(0, max - 1).join(", ")} and ${names.length - (max - 1)} more`;
}
