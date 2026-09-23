// What a repo share exposes, in numbers a person can read before they click:
// how many sessions, from when to when, what a share start keeps private, and
// the words on the button. Pure, so the setup flows, the settings page and the
// CLI agree on one wording.
import { formatShortDate } from "../time";

/** One directory's true counts and start span (users.shareImpactForPaths). */
export type PathShareSummary = {
  count: number;
  first_started_at: number | null;
  last_started_at: number | null;
  truncated: boolean;
  /** Sessions started before the share start under review. */
  older?: number;
  /** Sessions the owner hid by hand; a share never re-opens them. */
  hidden?: number;
  /** Sessions the owner shared by hand; a share start never closes them. */
  manually_shared?: number;
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
  /** Sessions before the share start: they stay private. */
  older: number;
  hidden: number;
  manuallyShared: number;
  /** The count hit the scan cap: read "1,024+". */
  truncated: boolean;
  /** Every selected path has an exact summary; false while the preview loads. */
  exact: boolean;
};

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/** Local midnight of the day `now` falls on: the share start "from today". */
export function startOfDay(now: number = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "today" for the current day, else "Sep 1". */
export function describeSince(since: number, now: number = Date.now()): string {
  return sameDay(since, now) ? "today" : formatShortDate(since, now);
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
  let older = 0;
  let hidden = 0;
  let manuallyShared = 0;
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
      older += e.older ?? 0;
      hidden += e.hidden ?? 0;
      manuallyShared += e.manually_shared ?? 0;
      truncated = truncated || e.truncated;
      continue;
    }
    allExact = false;
    const row = byPath.get(path);
    if (row) fold(row.session_count, row.first_active ?? row.last_active, row.last_active);
  }
  return { repos: selectedPaths.length, sessions, first, last, older, hidden, manuallyShared, truncated, exact: allExact };
}

function repoWord(n: number): string {
  return `${n} repo${n === 1 ? "" : "s"}`;
}

/** Sessions a share with this start would expose: the total less the older ones. */
export function exposedCount(impact: ShareImpact, since: number | null): number {
  return since == null ? impact.sessions : Math.max(0, impact.sessions - impact.older);
}

/** The primary button: what the click does, with the number it exposes.
 *  Null when nothing is selected, so the caller keeps its idle label. */
export function shareActionLabel(impact: ShareImpact, since: number | null, now: number = Date.now()): string | null {
  if (impact.repos === 0) return null;
  const exposed = exposedCount(impact, since);
  if (since == null) {
    if (exposed === 0) return `Share ${repoWord(impact.repos)}`;
    return `Share ${repoWord(impact.repos)} · ${formatSessionCount(exposed, impact.truncated)}`;
  }
  const label = describeSince(since, now);
  if (exposed === 0) return `Share ${repoWord(impact.repos)} from ${label}`;
  return `Share ${repoWord(impact.repos)} · ${formatSessionCount(exposed)} since ${label}`;
}

/** "3 teammates", "1 teammate", "no teammates yet". */
export function describeTeammates(memberCount: number | undefined): string {
  const others = Math.max(0, (memberCount ?? 1) - 1);
  if (others === 0) return "no teammates yet";
  return `${others} teammate${others === 1 ? "" : "s"}`;
}

/** The count and span line under the summary, worded for the share start. */
export function describeShareSpan(impact: ShareImpact, since: number | null, now: number = Date.now()): string {
  if (impact.sessions === 0) return "No sessions there yet. New ones will be visible as they happen.";
  const count = formatSessionCount(impact.sessions, impact.truncated);
  const range = formatDateRange(impact.first, impact.last, now);
  const hiddenNote = impact.hidden > 0 ? ` ${formatSessionCount(impact.hidden)} you hid by hand stay hidden.` : "";
  if (since == null) return (range ? `${count}, ${range}.` : `${count}.`) + hiddenNote;
  const label = describeSince(since, now);
  const exposed = exposedCount(impact, since);
  const head = exposed > 0 ? `${formatSessionCount(exposed)} from ${label} on.` : `Nothing yet from ${label} on.`;
  const tail = impact.older > 0 ? ` The ${formatSessionCount(impact.older)} before that stay private.` : " Nothing older there.";
  return head + tail + hiddenNote;
}

/** "codecast", "codecast and mail", "codecast, mail and 2 more". */
export function listNames(names: string[], max = 3): string {
  if (names.length <= max) {
    if (names.length <= 1) return names[0] ?? "";
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }
  return `${names.slice(0, max - 1).join(", ")} and ${names.length - (max - 1)} more`;
}

/** One line for a live mapping's scope on a settings row. */
export function describeMappingScope(shareSince: number | null | undefined, older: number | undefined, now: number = Date.now()): string {
  if (shareSince == null) return "all sessions";
  const label = describeSince(shareSince, now);
  if (older == null) return `since ${label}`;
  return older > 0 ? `since ${label} · ${formatSessionCount(older)} earlier stay private` : `since ${label}`;
}
