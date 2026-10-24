// An approving reviewer's note is the change card's words (templates/line/review.md):
// its first line is the question the person answers, the rest is the card's
// document. decide.cast reads both through the run context ($review_question,
// $review_body), and the review-note eval renders its card from the same split.
export function splitReviewNote(note: string): { question: string; body: string } {
  const text = note.trim();
  const cut = text.indexOf("\n");
  return cut < 0 ? { question: text, body: "" } : { question: text.slice(0, cut).trim(), body: text.slice(cut + 1).trim() };
}
