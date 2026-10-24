// A composer quote (quoteDrafts.ts) lives in review_comments beside code
// comments and review notes, but it is not one: it has no file, no pull
// request and no thread, and it is its author's alone. Every reader that lists
// review_comments for a file, a ref, a pull request or a conversation skips it
// (lib/commentTwins withoutBorrowedRows).
// A leaf module so codeComments.ts and quoteDrafts.ts share the rule without
// importing each other.

export function isQuoteRow(row: { origin?: string | null }): boolean {
  return row.origin === "quote";
}
