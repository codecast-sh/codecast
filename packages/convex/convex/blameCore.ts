// Pure resolution logic for `cast blame` (blame.ts wraps these with db access;
// tests hit them directly with bun:test).
//
// Attribution model: the CLI runs `git blame --porcelain` locally and sends the
// unique full 40-char SHAs here. Sessions record their commits as file_changes
// rows with change_type "commit" whose commit_hash is the SHORT hash parsed
// from git's `[branch abc1234]` output — so a stored hash attributes a blame
// SHA when it is a ≥7-char prefix of it. Uncommitted lines (blame SHA of all
// zeros) are attributed by content: the newest edit/write whose new_content
// contains the line verbatim.

export const MIN_SHA_PREFIX = 7;
// Lines shorter than this (trimmed) — `}`, `});`, `end` — appear in too many
// edits to attribute safely; leave them unresolved.
export const MIN_LINE_MATCH_LEN = 8;

export type CommitRowLite = {
  commit_hash?: string;
  conversation_id: string;
  message_id: string;
  timestamp: number;
};

export type EditRowLite = {
  conversation_id: string;
  message_id: string;
  file_path: string;
  change_type: string;
  new_content: string;
  timestamp: number;
};

export function isValidBlameSha(sha: string): boolean {
  return /^[0-9a-f]{7,40}$/.test(sha);
}

// Newest commit row whose stored short hash is a prefix of the full blame SHA.
// Candidates come from an index range scan over [sha.slice(0,7), sha], which
// can include same-prefix non-matches — verify before accepting.
export function pickRowForSha(fullSha: string, candidates: CommitRowLite[]): CommitRowLite | null {
  let best: CommitRowLite | null = null;
  for (const row of candidates) {
    const hash = row.commit_hash;
    if (!hash || hash.length < MIN_SHA_PREFIX) continue;
    if (!fullSha.startsWith(hash)) continue;
    if (!best || row.timestamp > best.timestamp) best = row;
  }
  return best;
}

// Attribute uncommitted line texts to the newest edit/write row (for the blamed
// file) whose new_content contains the line. Comparison is on trimmed lines so
// indentation-only drift between the edit and the working tree doesn't break
// the match.
export function matchUncommittedLines(
  lines: string[],
  rows: EditRowLite[],
): Map<string, EditRowLite> {
  const matched = new Map<string, EditRowLite>();
  const wanted = new Set<string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length >= MIN_LINE_MATCH_LEN) wanted.add(trimmed);
  }
  if (wanted.size === 0) return matched;

  const newestFirst = [...rows].sort((a, b) => b.timestamp - a.timestamp);
  for (const row of newestFirst) {
    if (wanted.size === 0) break;
    for (const raw of row.new_content.split("\n")) {
      const candidate = raw.trim();
      if (wanted.delete(candidate)) matched.set(candidate, row);
    }
  }
  return matched;
}
