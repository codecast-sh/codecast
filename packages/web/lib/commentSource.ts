// Where conversation comments are read from. `comments` is the source of
// truth; every write also keeps a twin in review_comments (convex
// commentTwins). With the person's `comments_from_review` preference on, the
// conversation surfaces read the twins instead, through the same row shape,
// so they render exactly as before. Off by default.
//
// Pure: no store import, so the store's readers and the phone can use it.

type UiState = { clientState?: { ui?: { comments_from_review?: boolean } | null } | null };

/** The person's opt-in: per user, off unless set (clientState.ui.comments_from_review). */
export function commentsFromReviewOn(state: UiState): boolean {
  return state.clientState?.ui?.comments_from_review === true;
}
