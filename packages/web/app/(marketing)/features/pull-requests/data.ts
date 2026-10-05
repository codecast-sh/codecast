/**
 * The example every mock on /features/pull-requests shares: one pull request,
 * the session that owns it, one reviewer. The repository and people are
 * illustrative; every label, state name, command and output line follows the
 * real formatters (packages/cli/src/prCommand.ts, convex/prShepherd.ts,
 * components/pr/*).
 */

export const REPO = "acme/api";
export const PR_NUMBER = 214;
export const PR_TITLE = "Retry webhook deliveries with backoff";
export const HEAD = "webhook-retry";
export const BASE = "main";
export const AUTHOR = "lena";
export const REVIEWER = "omar";
export const SESSION = { id: "jx7c6zk", title: "Webhook retry backoff" };
export const TASK = { id: "ct-4102", title: "Retry failed webhook deliveries" };
export const TRIGGER = "tr-318";

export const NOTES = [
  { id: "q4c7b2xm", file: "src/retry.ts", line: 42, text: "Jitter can push the delay past the cap." },
  { id: "r81kd0ve", file: "src/retry.ts", line: 88, text: "Log the attempt number so a stuck delivery is findable." },
];

/** The wake reasons in the order a pile of them is ranked (WAKE_SEVERITY). */
export const SEVERITY = [
  ["conflict", "the branch no longer merges cleanly"],
  ["check_failed", "a check failed"],
  ["changes_requested", "a reviewer asked for changes"],
  ["behind", "the base branch moved ahead of this one"],
  ["review_comment_created", "a reviewer left a comment on the code"],
] as const;

/** What wakes the shepherd and what only lands in the timeline (docs: the owning session). */
export const WAKE_TABLE: { event: string; wakes: boolean; note: string }[] = [
  { event: "A check fails", wakes: true, note: "check_failed" },
  { event: "A person requests changes, or leaves a review with a body", wakes: true, note: "changes_requested" },
  { event: "A person comments on a line", wakes: true, note: "review_comment_created" },
  { event: "The branch no longer merges cleanly", wakes: true, note: "conflict" },
  { event: "The branch falls behind its base", wakes: false, note: "recorded as pr_behind" },
  { event: "Checks go green", wakes: false, note: "recorded" },
  { event: "New commits are pushed", wakes: false, note: "recorded" },
  { event: "A review is requested", wakes: false, note: "recorded" },
  { event: "The branch merges cleanly again", wakes: false, note: "recorded" },
  { event: "Anything from a bot, or from the PR's own author", wakes: false, note: "ignored" },
];

/** Shepherd states, with the phrase and accent the PR header uses (lib/externalEvents.ts). */
export const SHEPHERD_STATES: { key: string; phrase: string; color: string }[] = [
  { key: "ci_pending", phrase: "waiting on checks", color: "#b58900" },
  { key: "ci_red", phrase: "fixing failed checks", color: "#dc322f" },
  { key: "review_pending", phrase: "waiting for a review", color: "#b58900" },
  { key: "changes_requested", phrase: "has changes to make", color: "#cb4b16" },
  { key: "behind", phrase: "branch is behind its base", color: "#cb4b16" },
  { key: "conflicts", phrase: "has merge conflicts to resolve", color: "#dc322f" },
  { key: "approved", phrase: "approved", color: "#859900" },
  { key: "ready", phrase: "ready to merge", color: "#859900" },
  { key: "merged", phrase: "merged", color: "#6c71c4" },
];
