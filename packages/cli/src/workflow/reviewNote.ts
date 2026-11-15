// An approving reviewer's note is the change card's words (templates/line/review.md):
// its first line is the question the person answers, the lines up to a line
// holding only `---` are the card's document, and what follows that line is the
// review's record (findings, the ids it checked), which stays on the task's
// verdict for the implementer. decide.cast reads the first two through the run
// context ($review_question, $review_body), and the review-note eval renders
// its card from the same split. A note with no `---` line is all card.
export function splitReviewNote(note: string): { question: string; body: string; record: string } {
  const text = note.trim();
  const cut = text.indexOf("\n");
  if (cut < 0) return { question: text, body: "", record: "" };
  const rest = text.slice(cut + 1);
  const rule = /^---[ \t]*$/m.exec(rest);
  return {
    question: text.slice(0, cut).trim(),
    body: (rule ? rest.slice(0, rule.index) : rest).trim(),
    record: rule ? rest.slice(rule.index + rule[0].length).trim() : "",
  };
}
