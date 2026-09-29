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

/** Split on whitespace, except inside double quotes: `path:"my folder"` and
 *  `"exact phrase"` each stay one token. An unterminated quote runs to the end
 *  of the input — the user is mid-typing, and results should keep up. */
export function tokenizeQuery(input: string): QueryToken[] {
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
