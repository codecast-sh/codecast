// The query tokenizer every search box shares (vault notes, session search):
// whitespace splits terms, double quotes hold a phrase or an operator value
// together.

export interface QueryToken {
  /** The token with its quotes removed. */
  value: string;
  /** The token as typed, quotes and all — what plain terms contribute. */
  raw: string;
  /** A `"` opened somewhere in this token. */
  quoted: boolean;
}

// Phones and macOS smart punctuation turn a typed `"` into a curly quote, so
// the search box sees “exact phrase” far more often than "exact phrase".
const CURLY_DOUBLE_QUOTES = /[“”„‟″＂]/g;

/** A query with every double-quote look-alike written as `"`, so a phrase
 *  typed on a phone is a phrase. Every parser reads its input through this. */
export function normalizeQueryQuotes(input: string): string {
  return input.replace(CURLY_DOUBLE_QUOTES, '"');
}

/** Split on whitespace, except inside double quotes: `path:"my folder"` and
 *  `"exact phrase"` each stay one token. An unterminated quote runs to the end
 *  of the input — the user is mid-typing, and results should keep up. */
export function tokenizeQuery(input: string): QueryToken[] {
  input = normalizeQueryQuotes(input);
  const tokens: QueryToken[] = [];
  let value = "";
  let raw = "";
  let quoted = false;
  let inQuotes = false;
  const push = () => {
    if (raw) tokens.push({ value, raw, quoted });
    value = "";
    raw = "";
    quoted = false;
  };
  for (const ch of input) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      quoted = true;
      raw += ch;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      push();
      continue;
    }
    value += ch;
    raw += ch;
  }
  push();
  return tokens;
}
