// A pull request's state as its chips draw it (components/PrStatusChip, the
// inbox card's PR chip): glyphs, never words on the chip.
import {
  Check, CheckCheck, CircleX, Clock, Eye, FilePen, GitCompareArrows, GitMerge, GitPullRequestClosed,
  GitPullRequestDraft, TriangleAlert, type LucideIcon,
} from "lucide-react";

/**
 * A pull request's state as the chip draws it: the PR glyph its state calls for, and a glyph after the number for
 * what it waits on. Every state a chip can wear (a shepherd's, or a linked PR's own) is here; the words stay in
 * shepherdStyle and LINKED_PR_LOOK for tooltips and screen readers.
 */
export const PR_STATE_GLYPH: Record<string, { pr?: LucideIcon; after?: LucideIcon }> = {
  review_pending: { after: Eye },
  changes_requested: { after: FilePen },
  ci_pending: { after: Clock },
  ci_red: { after: CircleX },
  failing: { after: CircleX },
  behind: { after: GitCompareArrows },
  conflicts: { after: TriangleAlert },
  approved: { after: Check },
  ready: { after: CheckCheck },
  draft: { pr: GitPullRequestDraft },
  merged: { pr: GitMerge },
  closed: { pr: GitPullRequestClosed },
};
