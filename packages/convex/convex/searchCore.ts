// Pure text-search logic shared by the message search surfaces (web searchMessages,
// CLI searchForCLI, CLI feedForCLI). No ctx/db access — unit-testable with bun:test.
//
// Matching model: a query parses into quoted phrases (exact, always required) and
// words. Stop-words are dropped from words — they add no retrieval signal but each
// one costs a full search-index fetch and tightens the all-terms filter (the
// 7-word natural-language query that matches nothing). Matching is lowercase
// substring containment over a conversation's fetched messages.

export type ParsedTerms = { phrases: string[]; words: string[]; all: string[] };

// Function words common in natural-language task descriptions. Deliberately
// moderate: only words that are near-certain noise for retrieval.
const SEARCH_STOPWORDS = new Set([
  "a", "an", "the", "to", "of", "in", "on", "for", "and", "or", "with",
  "from", "into", "at", "by", "as", "is", "are", "was", "were", "be",
  "been", "it", "its", "this", "that", "these", "those", "my", "our",
  "your", "their", "we", "i", "you", "they", "do", "does", "did", "can",
  "could", "should", "would", "will", "may", "might", "must", "not", "no",
  "so", "if", "then", "than", "when", "where", "which", "who", "how",
  "what", "why", "about", "up", "out", "also", "just", "via",
]);

export function parseSearchTerms(query: string): ParsedTerms {
  const phrases: string[] = [];
  const rawWords: string[] = [];
  const regex = /"([^"]+)"|(\S+)/g;
  let match;
  while ((match = regex.exec(query)) !== null) {
    if (match[1]) {
      phrases.push(match[1].toLowerCase());
    } else if (match[2]) {
      rawWords.push(match[2].toLowerCase());
    }
  }
  const deduped = [...new Set(rawWords)];
  const meaningful = deduped.filter((w) => w.length >= 2 && !SEARCH_STOPWORDS.has(w));
  // A query made entirely of stop-words ("how to do it") still has to search
  // for something — keep the originals in that case.
  const words = meaningful.length > 0 ? meaningful : deduped;
  return { phrases, words, all: [...phrases, ...words] };
}

export function contentMatchesSearch(content: string, terms: { phrases: string[]; words: string[] }): boolean {
  const lowerContent = content.toLowerCase();
  for (const phrase of terms.phrases) {
    if (!lowerContent.includes(phrase)) return false;
  }
  for (const word of terms.words) {
    if (!lowerContent.includes(word)) return false;
  }
  return true;
}

export function contentMatchesAnyTerm(content: string, terms: ParsedTerms): boolean {
  const lowerContent = content.toLowerCase();
  return terms.all.some((t) => lowerContent.includes(t));
}

export function conversationMatchesAllTerms(
  messages: Array<{ content?: string | null }>,
  terms: { phrases: string[]; words: string[] }
): boolean {
  const allContent = messages.map((m) => (m.content || "").toLowerCase()).join(" ");
  return contentMatchesSearch(allContent, terms);
}

export type RankedConversation<M> = { convId: string; messages: M[]; coverage: number };

// Replaces the strict all-terms AND for CLI search surfaces. Quoted phrases stay
// required. Short word queries (≤2) keep exact AND semantics; longer queries
// degrade to best-effort: a conversation qualifies when at least half the words
// match, ranked full-coverage first. Sort is stable, so within a coverage tier
// the caller's relevance order is preserved.
export function rankConversationsByCoverage<M extends { content?: string | null }>(
  groups: Map<string, M[]>,
  terms: ParsedTerms
): Array<RankedConversation<M>> {
  const ranked: Array<RankedConversation<M>> = [];
  for (const [convId, messages] of groups) {
    const joined = messages.map((m) => (m.content || "").toLowerCase()).join(" ");
    if (terms.phrases.some((p) => !joined.includes(p))) continue;
    const total = terms.words.length;
    if (total === 0) {
      ranked.push({ convId, messages, coverage: 1 });
      continue;
    }
    const matched = terms.words.filter((w) => joined.includes(w)).length;
    const required = total <= 2 ? total : Math.ceil(total / 2);
    if (matched < required) continue;
    ranked.push({ convId, messages, coverage: matched / total });
  }
  return ranked.sort((a, b) => b.coverage - a.coverage);
}

export function calculateProximityScore(
  messages: Array<{ content?: string | null; _id: { toString(): string } }>,
  terms: { all: string[] }
): number {
  if (terms.all.length <= 1) return 0;

  const termPositions: Map<string, number[]> = new Map();
  for (const term of terms.all) {
    termPositions.set(term, []);
  }

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const content = (messages[msgIdx].content || "").toLowerCase();
    for (const term of terms.all) {
      if (content.includes(term)) {
        termPositions.get(term)!.push(msgIdx);
      }
    }
  }

  // Check if all terms appear in same message (best case)
  for (let i = 0; i < messages.length; i++) {
    const content = (messages[i].content || "").toLowerCase();
    if (terms.all.every((t) => content.includes(t))) {
      return 0; // Best score - all terms in one message
    }
  }

  // Calculate minimum span across messages
  let minSpan = Infinity;
  const firstTermPositions = termPositions.get(terms.all[0]) || [];

  for (const startPos of firstTermPositions) {
    let maxEnd = startPos;
    let valid = true;

    for (const term of terms.all.slice(1)) {
      const positions = termPositions.get(term) || [];
      if (positions.length === 0) {
        valid = false;
        break;
      }
      // Find closest position to current range
      let closest = positions[0];
      for (const pos of positions) {
        if (Math.abs(pos - startPos) < Math.abs(closest - startPos)) {
          closest = pos;
        }
      }
      maxEnd = Math.max(maxEnd, closest);
    }

    if (valid) {
      minSpan = Math.min(minSpan, maxEnd - startPos + 1);
    }
  }

  return minSpan === Infinity ? 1000 : minSpan;
}
