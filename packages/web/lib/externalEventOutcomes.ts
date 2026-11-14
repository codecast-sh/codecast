// Which git and GitHub events say what a session shipped: the pull requests it
// touched and where each stands, and the commits it made and pushed. Two
// readers share these rules and must not drift apart:
//   - the Activity page's model (components/activity/activityModel), which
//     derives each row's PR chips and commit count from them;
//   - the cache's boot retention (store/cacheRetention), which keeps exactly
//     the rows that model reads and drops the rest.
// Pure data, no imports: the phone's cache engine reaches this file.

export type PrStateWord = "open" | "merged" | "closed" | "draft";

// The kinds that move a pull request's state. Every other PR kind (a review,
// a check, a push to it) says the session touched it, not where it stands.
export const PR_STATE_OF_KIND: Record<string, PrStateWord> = {
  pr_opened: "open",
  pr_reopened: "open",
  pr_ready_for_review: "open",
  pr_draft: "draft",
  pr_merged: "merged",
  pr_closed: "closed",
};

/** A commit a session made: counted by sha on that session's row. */
export const SESSION_COMMIT_KINDS: ReadonlySet<string> = new Set(["commit", "amend", "cherry_pick"]);

/** A push a session made: its `meta.commits_count` adds to that session's pushed count. */
export const SESSION_PUSH_KIND = "push";

/** One pull request across every event about it. */
export const prThreadKey = (repository: string, number: number) => `${repository}#${number}`;
