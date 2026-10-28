// Where conversation comments are read from. `comments` is the source of
// truth; every write also keeps a twin in review_comments (convex
// commentTwins). The conversation surfaces read the twins, through the same
// row shape, so they render exactly as before. A person whose
// `comments_from_review` preference is false reads `comments` directly.
//
// Pure: no store import, so the store's readers and the phone can use it.

type UiState = { clientState?: { ui?: { comments_from_review?: boolean } | null } | null };

/** On for everyone unless the person set clientState.ui.comments_from_review to false. */
export function commentsFromReviewOn(state: UiState): boolean {
  return state.clientState?.ui?.comments_from_review !== false;
}
