// Pure view logic for the pull request page.
//
// Two jobs. First, fold a PR's live state (checks, merge state, review
// decision) into the few words and colors the header shows. Second, fold the
// PR's code comments and its external events into the lists the tabs render.
// Both are plain functions over plain rows, so the page's arithmetic is
// testable without a DOM and the components stay layout only.

import type { ExternalEventAccent } from "./externalEvents";

// -- Checks -------------------------------------------------------------------

export type PrCheck = {
  name: string;
  status: string;
  conclusion?: string;
  url?: string;
  updated_at: number;
  external_id?: string;
};

export type CheckOutcome = "passed" | "failed" | "pending" | "skipped";

/** A check run reports `status` while it runs and `conclusion` once it ends.
 *  GitHub also reports commit statuses, whose state lands in `status`. */
export function checkOutcome(check: Pick<PrCheck, "status" | "conclusion">): CheckOutcome {
  const conclusion = (check.conclusion ?? "").toLowerCase();
  const status = (check.status ?? "").toLowerCase();
  if (conclusion) {
    if (conclusion === "success" || conclusion === "neutral") return "passed";
    if (conclusion === "skipped" || conclusion === "stale") return "skipped";
    return "failed";
  }
  if (status === "success") return "passed";
  if (status === "failure" || status === "error") return "failed";
  return "pending";
}

export const CHECK_OUTCOME_ACCENT: Record<CheckOutcome, ExternalEventAccent> = {
  passed: "green",
  failed: "red",
  pending: "yellow",
  skipped: "muted",
};

export type ChecksFold = {
  passed: number;
  failed: number;
  pending: number;
  skipped: number;
  total: number;
};

export function foldChecks(checks: PrCheck[] | undefined): ChecksFold {
  const fold: ChecksFold = { passed: 0, failed: 0, pending: 0, skipped: 0, total: 0 };
  for (const check of checks ?? []) {
    fold[checkOutcome(check)] += 1;
    fold.total += 1;
  }
  return fold;
}

const CHECK_SORT_RANK: Record<CheckOutcome, number> = { failed: 0, pending: 1, passed: 2, skipped: 3 };

/** Failed checks first, then still running, then the quiet ones. */
export function compareChecks(a: PrCheck, b: PrCheck): number {
  const rank = CHECK_SORT_RANK[checkOutcome(a)] - CHECK_SORT_RANK[checkOutcome(b)];
  return rank !== 0 ? rank : a.name.localeCompare(b.name);
}

// -- PR state, merge state, review decision -----------------------------------

export type PrStateKey = "open" | "draft" | "merged" | "closed";

export type PrStateRow = {
  state?: "open" | "closed" | "merged";
  draft?: boolean;
  mergeable_state?: string;
  behind_by?: number;
  review_decision?: string;
  checks?: PrCheck[];
};

export function prStateKey(pr: PrStateRow): PrStateKey {
  if (pr.state === "merged") return "merged";
  if (pr.state === "closed") return "closed";
  return pr.draft ? "draft" : "open";
}

export const PR_STATE_META: Record<PrStateKey, { label: string; accent: ExternalEventAccent }> = {
  open: { label: "Open", accent: "green" },
  draft: { label: "Draft", accent: "muted" },
  merged: { label: "Merged", accent: "violet" },
  closed: { label: "Closed", accent: "red" },
};

/** The one sentence about whether this PR can land: conflicts, behind, blocked,
 *  or ready. Null when GitHub has told us nothing yet. */
export function mergeStateMeta(pr: PrStateRow): { label: string; accent: ExternalEventAccent } | null {
  if (pr.state === "merged" || pr.state === "closed") return null;
  const state = (pr.mergeable_state ?? "").toLowerCase();
  if (state === "dirty") return { label: "Conflicts", accent: "red" };
  if ((pr.behind_by ?? 0) > 0) return { label: `Behind by ${pr.behind_by}`, accent: "yellow" };
  if (state === "behind") return { label: "Behind base", accent: "yellow" };
  if (state === "blocked") return { label: "Blocked", accent: "yellow" };
  if (state === "unstable") return { label: "Checks failing", accent: "red" };
  if (state === "clean") return { label: "Ready to merge", accent: "green" };
  return null;
}

export function reviewDecisionMeta(
  decision: string | undefined,
): { label: string; accent: ExternalEventAccent } | null {
  switch ((decision ?? "").toLowerCase()) {
    case "approved":
      return { label: "Approved", accent: "green" };
    case "changes_requested":
      return { label: "Changes requested", accent: "red" };
    case "review_required":
      return { label: "Review required", accent: "yellow" };
    default:
      return null;
  }
}

export const REVIEW_STATE_ACCENT: Record<string, ExternalEventAccent> = {
  approved: "green",
  changes_requested: "red",
  commented: "blue",
  pending: "yellow",
};

// -- Code comments ------------------------------------------------------------

export type CodeCommentRow = {
  _id: string;
  content: string;
  file_path?: string;
  line_number?: number;
  line_end?: number;
  side?: string;
  resolved?: boolean;
  resolved_at?: number;
  parent_id?: string;
  created_at: number;
  html_url?: string;
  author_kind?: "user" | "agent" | "github";
  author_github_username?: string;
  author_user_id?: string;
  author_avatar_url?: string;
};

export function commentResolved(comment: CodeCommentRow): boolean {
  return comment.resolved === true || comment.resolved_at !== undefined;
}

/** A thread is open while any comment in it is unresolved, so a reply after
 *  resolution reopens it — the same rule the conversation rail uses. */
export function threadResolved(thread: CodeCommentRow[]): boolean {
  return thread.length > 0 && thread.every(commentResolved);
}

const byCreatedAsc = (a: CodeCommentRow, b: CodeCommentRow) => a.created_at - b.created_at;

/** file path → line number → the thread on that line, oldest first. Comments
 *  with no file (a plain PR comment) are left out; `prComments` takes those. */
export function groupCommentsByFileLine(
  comments: CodeCommentRow[],
): Map<string, Map<number, CodeCommentRow[]>> {
  const byFile = new Map<string, Map<number, CodeCommentRow[]>>();
  for (const comment of comments) {
    if (!comment.file_path || comment.line_number === undefined) continue;
    let byLine = byFile.get(comment.file_path);
    if (!byLine) byFile.set(comment.file_path, (byLine = new Map()));
    const thread = byLine.get(comment.line_number);
    if (thread) thread.push(comment);
    else byLine.set(comment.line_number, [comment]);
  }
  for (const byLine of byFile.values()) for (const thread of byLine.values()) thread.sort(byCreatedAsc);
  return byFile;
}

/** Comments on the PR itself: no file anchor, and not a reply to another one. */
export function prComments(comments: CodeCommentRow[]): CodeCommentRow[] {
  return comments.filter((c) => !c.file_path && !c.parent_id).sort(byCreatedAsc);
}

export function unresolvedThreadCount(comments: CodeCommentRow[]): number {
  let open = 0;
  for (const byLine of groupCommentsByFileLine(comments).values()) {
    for (const thread of byLine.values()) if (!threadResolved(thread)) open += 1;
  }
  return open;
}

// -- The conversation timeline ------------------------------------------------

export type PrReviewRow = {
  _id: string;
  state: string;
  body?: string;
  submitted_at: number;
  html_url?: string;
  author_github_username?: string;
};

export type PrEventRow = { _id: string; created_at: number };

export type PrTimelineItem =
  | { key: string; at: number; kind: "event"; event: PrEventRow }
  | { key: string; at: number; kind: "review"; review: PrReviewRow }
  | { key: string; at: number; kind: "comment"; comment: CodeCommentRow; replies: CodeCommentRow[] };

/** One list, oldest first: what happened to the PR outside codecast (events),
 *  what reviewers said, and what people said here. Replies hang off their
 *  parent instead of taking a place in the list. */
export function buildPrTimeline(input: {
  events: PrEventRow[];
  reviews: PrReviewRow[];
  comments: CodeCommentRow[];
}): PrTimelineItem[] {
  const repliesByParent = new Map<string, CodeCommentRow[]>();
  for (const comment of input.comments) {
    if (!comment.parent_id) continue;
    const kids = repliesByParent.get(comment.parent_id);
    if (kids) kids.push(comment);
    else repliesByParent.set(comment.parent_id, [comment]);
  }

  const items: PrTimelineItem[] = [
    ...input.events.map<PrTimelineItem>((event) => ({
      key: `e:${event._id}`,
      at: event.created_at,
      kind: "event",
      event,
    })),
    ...input.reviews.map<PrTimelineItem>((review) => ({
      key: `r:${review._id}`,
      at: review.submitted_at,
      kind: "review",
      review,
    })),
    ...prComments(input.comments).map<PrTimelineItem>((comment) => ({
      key: `c:${comment._id}`,
      at: comment.created_at,
      kind: "comment",
      comment,
      replies: (repliesByParent.get(comment._id) ?? []).sort(byCreatedAsc),
    })),
  ];

  return items.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

/** The sticky divider's words. Same rule as the project timeline: relative for
 *  the two days a reader thinks of as recent, an absolute date before that. */
export function dayLabel(ts: number, now: number = Date.now()): string {
  const at = new Date(ts);
  const today = new Date(now);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(at)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return at.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(at.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
  });
}
