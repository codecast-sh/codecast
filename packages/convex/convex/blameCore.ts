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
  commit_message?: string;
  conversation_id: string;
  message_id: string;
  timestamp: number;
};

// A session's commit row and the actual `git commit` differ by the agent's
// round-trip time; minutes apart means it's a different commit.
export const SUMMARY_MATCH_WINDOW_MS = 15 * 60 * 1000;

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

// Fallback when no stored hash matches: sessions often commit via compound
// commands whose output has no `[branch hash]` line, so their rows carry only
// the parsed commit message. Match the blame commit's subject line against the
// row's message first line, preferring the row closest in time. Survives
// rebases and amends too — those rewrite the sha but keep the subject.
export function rankRowsBySummary(
  summary: string,
  authorTimeMs: number,
  candidates: CommitRowLite[],
): CommitRowLite[] {
  const subject = summary.trim();
  if (!subject) return [];
  return candidates
    .filter((row) => {
      const firstLine = row.commit_message?.split("\n")[0]?.trim();
      if (!firstLine || firstLine !== subject) return false;
      return Math.abs(row.timestamp - authorTimeMs) <= SUMMARY_MATCH_WINDOW_MS;
    })
    .sort((a, b) => Math.abs(a.timestamp - authorTimeMs) - Math.abs(b.timestamp - authorTimeMs));
}

export function pickRowBySummary(
  summary: string,
  authorTimeMs: number,
  candidates: CommitRowLite[],
): CommitRowLite | null {
  return rankRowsBySummary(summary, authorTimeMs, candidates)[0] ?? null;
}

export type MatchLine = {
  text: string;
  // Newest edit timestamp that may claim this line. Committed lines pass
  // commit-time + slack so an authoring edit (which precedes its commit) can
  // match but a later rewrite that happens to contain the same text cannot.
  // Uncommitted lines pass no deadline.
  deadline?: number;
};

// Attribute line texts to the newest eligible edit/write row (for the blamed
// file) whose new_content contains the line. Comparison is on trimmed lines so
// indentation-only drift between the edit and the working tree doesn't break
// the match.
export function matchLinesToEdits(
  lines: MatchLine[],
  rows: EditRowLite[],
): Map<string, EditRowLite> {
  const matched = new Map<string, EditRowLite>();
  const deadlines = new Map<string, number>();
  for (const line of lines) {
    const trimmed = line.text.trim();
    if (trimmed.length < MIN_LINE_MATCH_LEN) continue;
    // Duplicate text across commits: keep the most permissive deadline.
    const existing = deadlines.get(trimmed);
    const deadline = line.deadline ?? Infinity;
    if (existing === undefined || deadline > existing) deadlines.set(trimmed, deadline);
  }
  if (deadlines.size === 0) return matched;

  const newestFirst = [...rows].sort((a, b) => b.timestamp - a.timestamp);
  for (const row of newestFirst) {
    if (matched.size === deadlines.size) break;
    for (const raw of row.new_content.split("\n")) {
      const candidate = raw.trim();
      const deadline = deadlines.get(candidate);
      if (deadline === undefined || matched.has(candidate)) continue;
      if (row.timestamp <= deadline) matched.set(candidate, row);
    }
  }
  return matched;
}

// Back-compat shape used by tests: plain uncommitted lines have no deadline.
export function matchUncommittedLines(
  lines: string[],
  rows: EditRowLite[],
): Map<string, EditRowLite> {
  return matchLinesToEdits(lines.map((text) => ({ text })), rows);
}
