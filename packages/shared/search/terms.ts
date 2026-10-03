// What a session search query means and how well a piece of text answers it.
// One home for parsing, matching, scoring and snippets: the server ranks with
// it (convex/searchCore.ts), `cast search` prints from it, and the web marks
// hits with it, so a word that ranked a session is the word that is drawn.
//
// Matching model: a query parses into quoted phrases (exact, always required)
// and words. Stop-words are dropped from words: they add no retrieval signal
// and tighten the coverage filter (the 7-word natural-language query that
// matches nothing). A word matches as a lowercase substring, and its parts may
// be written together, hyphenated or spaced ("k pop" finds "kpop" and "k-pop").
// HOW it matched is the ranking signal: a whole word beats the inside of a
// longer one, and query words found side by side beat the same words scattered.

export type ParsedTerms = {
  phrases: string[];
  words: string[];
  all: string[];
  /** Neighbouring query words as one hyphenated term each ("warm-intro",
   *  "k-pop"): found side by side in a text, they are the strongest sign the
   *  text is about what was typed. */
  joins: string[];
  /** The text for a token index (BM25): the words, their parts, and each
   *  neighbouring pair written as one token, so "warm intro" also reaches a row
   *  that says "warmintro". */
  lookup: string;
};

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

// A token index takes at most this many terms in one query.
const LOOKUP_TERM_CAP = 16;

const WORD_SEPARATORS = /[\s\-_]+/;
const SEPARATOR_RUN = "[\\s\\-_]*";

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function parseQueryTerms(query: string): ParsedTerms {
  const phrases: string[] = [];
  const rawWords: string[] = [];
  const regex = /"([^"]+)"|(\S+)/g;
  let match;
  while ((match = regex.exec(query)) !== null) {
    if (match[1]) {
      phrases.push(match[1].toLowerCase());
      // A phrase breaks the run of words: nothing joins across it.
      rawWords.push("");
    } else if (match[2]) {
      rawWords.push(match[2].toLowerCase());
    }
  }
  const typed = rawWords.filter(Boolean);
  const deduped = [...new Set(typed)];
  const meaningful = deduped.filter((w) => w.length >= 2 && !SEARCH_STOPWORDS.has(w));
  // A query made entirely of stop-words ("how to do it") still has to search
  // for something: keep the originals in that case.
  const words = meaningful.length > 0 ? meaningful : deduped;

  // Neighbours as typed. A lone letter is no word of its own, but beside its
  // neighbour it names something ("k pop", "plan b"), so it joins too.
  const kept = new Set(words);
  const joinable = (w: string) => kept.has(w) || (w.length === 1 && /[a-z0-9]/.test(w) && !SEARCH_STOPWORDS.has(w));
  const joins: string[] = [];
  for (let i = 0; i + 1 < rawWords.length; i++) {
    const [a, b] = [rawWords[i], rawWords[i + 1]];
    if (a !== b && joinable(a) && joinable(b) && (kept.has(a) || kept.has(b))) joins.push(`${a}-${b}`);
  }

  const squash = (w: string) => w.split(WORD_SEPARATORS).join("");
  const parts = words.flatMap((w) => w.split(WORD_SEPARATORS).filter(Boolean));
  const base = [...new Set([...phrases, ...parts])];
  // Joined forms go first: a token index prefix-matches its last term, which
  // should stay the last word the person typed.
  const joined = [...words.filter((w) => squash(w) !== w), ...joins].map(squash);
  const lookup = [...new Set([...joined.slice(0, Math.max(0, LOOKUP_TERM_CAP - base.length)), ...base])].join(" ");

  return { phrases, words, all: [...phrases, ...words], joins: [...new Set(joins)], lookup };
}

/** The query as the search read it, phrases quoted again: what a transcript
 *  opened from a result should mark, so a dropped letter or stop-word is not
 *  lit up through the whole conversation. */
export function searchedTermsText(query: string): string {
  const terms = parseQueryTerms(query);
  return [...terms.phrases.map((p) => `"${p}"`), ...terms.words].join(" ");
}

const patternCache = new Map<string, RegExp>();
function cachedPattern(source: string): RegExp {
  let re = patternCache.get(source);
  if (!re) {
    if (patternCache.size > 500) patternCache.clear();
    re = new RegExp(source, "g");
    patternCache.set(source, re);
  }
  return re;
}

/** The regex source one term matches with, over LOWERCASE text. A phrase (it
 *  holds a space) is literal; a word's parts may sit together, hyphenated or
 *  spaced. */
export function termSource(term: string): string {
  if (/\s/.test(term)) return escapeRegex(term);
  return term.split(WORD_SEPARATORS).filter(Boolean).map(escapeRegex).join(SEPARATOR_RUN);
}

const isPlain = (term: string) => /\s/.test(term) || !/[\-_]/.test(term);

/** Where `term` first occurs in lowercase text at or after `from`: [start, end), or null. */
export function findTerm(lower: string, term: string, from = 0): [number, number] | null {
  if (!term) return null;
  if (isPlain(term)) {
    const at = lower.indexOf(term, from);
    return at === -1 ? null : [at, at + term.length];
  }
  const re = cachedPattern(termSource(term));
  re.lastIndex = from;
  const m = re.exec(lower);
  return m && m[0].length > 0 ? [m.index, m.index + m[0].length] : null;
}

export function contentMatchesSearch(content: string, terms: { phrases: string[]; words: string[] }): boolean {
  const lower = content.toLowerCase();
  return terms.phrases.every((p) => lower.includes(p)) && terms.words.every((w) => findTerm(lower, w) !== null);
}

export function contentMatchesAnyTerm(content: string, terms: { all: string[] }): boolean {
  const lower = content.toLowerCase();
  return terms.all.some((t) => findTerm(lower, t) !== null);
}

// ---------------------------------------------------------------------------
// Match quality

const WHOLE = 1;
const WORD_START = 0.6; // "intro" in "introduce"
const INSIDE = 0.3; // "pop" in "laptop"
// An ending that leaves the word the same word: "videos", "intro's", "warmed".
const INFLECTION = /^(?:'s|s|es|ed|ing)(?![a-z0-9])/;
// Occurrences examined per term per text before settling for the best seen.
const QUALITY_PROBES = 6;

const isWordChar = (code: number) => (code >= 48 && code <= 57) || (code >= 97 && code <= 122);

function hitQuality(lower: string, start: number, end: number): number {
  const left = start === 0 || !isWordChar(lower.charCodeAt(start - 1));
  if (!left) return INSIDE;
  const right = end >= lower.length || !isWordChar(lower.charCodeAt(end));
  if (right || INFLECTION.test(lower.slice(end, end + 4))) return WHOLE;
  return WORD_START;
}

function bestQuality(lower: string, term: string): number {
  let best = 0;
  let from = 0;
  for (let i = 0; i < QUALITY_PROBES; i++) {
    const hit = findTerm(lower, term, from);
    if (!hit) break;
    best = Math.max(best, hitQuality(lower, hit[0], hit[1]));
    if (best === WHOLE) break;
    from = hit[1];
  }
  return best;
}

/** How one text answers the query: a quality per word (0 = absent), which of
 *  the query's joins sit side by side in it, and which phrases it holds. */
export type TextSignal = { quality: number[]; pairs: boolean[]; phrases: boolean[]; score: number };

/** null when the text holds none of the query. */
export function signalOf(content: string, terms: ParsedTerms): TextSignal | null {
  const lower = content.toLowerCase();
  const phrases = terms.phrases.map((p) => lower.includes(p));
  const quality = terms.words.map((w) => bestQuality(lower, w));
  if (!phrases.some(Boolean) && !quality.some((q) => q > 0)) return null;
  const pairs = terms.joins.map((join) => {
    const members = terms.words.map((w, i) => (join.startsWith(`${w}-`) || join.endsWith(`-${w}`) ? i : -1)).filter((i) => i >= 0);
    // Both words must be here before it is worth looking for them together.
    if (members.some((i) => quality[i] === 0) || findTerm(lower, join) === null) return false;
    // Two query words written as one ("warmintro") are each the whole word
    // the person meant.
    for (const i of members) quality[i] = WHOLE;
    return true;
  });
  const score = quality.reduce((a, b) => a + b, 0) + phrases.filter(Boolean).length + 0.5 * pairs.filter(Boolean).length;
  return { quality, pairs, phrases, score };
}

// ---------------------------------------------------------------------------
// Evidence: every text of one session, folded into what the ranking reads

export type Evidence = {
  /** Best quality per word over all of the session's text. */
  best: number[];
  /** Best quality per word in what a person wrote: prompts, title, summaries. */
  own: number[];
  pairs: boolean[];
  phrases: boolean[];
  /** Messages holding any of the query. */
  depth: number;
};

export function emptyEvidence(terms: ParsedTerms): Evidence {
  return {
    best: terms.words.map(() => 0),
    own: terms.words.map(() => 0),
    pairs: terms.joins.map(() => false),
    phrases: terms.phrases.map(() => false),
    depth: 0,
  };
}

/** Fold one text into the evidence. `own` marks text a person wrote; `message`
 *  marks a transcript row (a title or summary adds no depth). Returns the
 *  text's own signal, null when it holds none of the query. */
export function addEvidence(
  ev: Evidence,
  content: string | null | undefined,
  terms: ParsedTerms,
  opts: { own?: boolean; message?: boolean } = {},
): TextSignal | null {
  if (!content) return null;
  const signal = signalOf(content, terms);
  if (!signal) return null;
  signal.quality.forEach((q, i) => {
    if (q > ev.best[i]) ev.best[i] = q;
    if (opts.own && q > ev.own[i]) ev.own[i] = q;
  });
  signal.pairs.forEach((p, i) => { if (p) ev.pairs[i] = true; });
  signal.phrases.forEach((p, i) => { if (p) ev.phrases[i] = true; });
  if (opts.message) ev.depth++;
  // A person's own words are the likelier thing they remember the session by.
  if (opts.own) signal.score *= 1.25;
  return signal;
}

/** Share of the query's words the session holds at all, or null when it does
 *  not qualify: quoted phrases are required, a short query (two words or
 *  fewer) needs every word, a longer one at least half. */
export function coverageOf(ev: Evidence, terms: ParsedTerms): number | null {
  if (ev.phrases.some((p) => !p)) return null;
  const total = terms.words.length;
  if (total === 0) return 1;
  const matched = ev.best.filter((q) => q > 0).length;
  const required = total <= 2 ? total : Math.ceil(total / 2);
  return matched < required ? null : matched / total;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 1);
const DEPTH_FULL = 16;

/** 0..1: how well the session answers the query. Half is how many words it
 *  holds and how cleanly; the rest is the words sitting side by side, the words
 *  being in the person's own text, and how much of the session is about them. */
export function relevanceOf(ev: Evidence, terms: ParsedTerms): number {
  const quality = mean(ev.best);
  const together = ev.pairs.length ? ev.pairs.filter(Boolean).length / ev.pairs.length : quality;
  const own = mean(ev.own);
  const depth = Math.min(1, Math.log2(1 + ev.depth) / Math.log2(1 + DEPTH_FULL));
  return 0.5 * quality + 0.2 * together + 0.2 * own + 0.1 * depth;
}

/** Relevance in five steps: a sort by newest first ranks within a step, so a
 *  near tie goes to the recent session and a clear win does not. */
export const relevanceTier = (relevance: number) => Math.min(4, Math.floor(relevance * 5));

// ---------------------------------------------------------------------------
// Snippets and marks

/** Every [start, end) the query occupies in `text`, merged and in order. */
export function termSpans(text: string, terms: { all: string[]; joins?: string[] }): Array<[number, number]> {
  const lower = text.toLowerCase();
  const spans: Array<[number, number]> = [];
  for (const term of [...terms.all, ...(terms.joins ?? [])]) {
    let from = 0;
    for (let hit = findTerm(lower, term, from); hit; hit = findTerm(lower, term, from)) {
      spans.push(hit);
      from = hit[1];
    }
  }
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number]> = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([s[0], s[1]]);
  }
  return merged;
}

/** The stretch of `content` that shows the most of the query: the window is
 *  anchored on the hit with the most other terms inside it, with a quarter of
 *  the budget as lead-in. No hit: the opening of the text. */
export function snippetAround(content: string, terms: { all: string[] }, maxLen = 300): string {
  if (content.length <= maxLen) return content;
  const lower = content.toLowerCase();
  const lead = Math.round(maxLen / 4);
  const firsts: Array<{ term: string; at: number }> = [];
  for (const term of terms.all) {
    let from = 0;
    for (let i = 0; i < 3; i++) {
      const hit = findTerm(lower, term, from);
      if (!hit) break;
      firsts.push({ term, at: hit[0] });
      from = hit[1];
    }
  }
  if (firsts.length === 0) return content.slice(0, maxLen) + "...";
  let anchor = firsts[0].at;
  let most = 0;
  for (const f of firsts) {
    const inWindow = new Set(firsts.filter((o) => o.at >= f.at - lead && o.at < f.at - lead + maxLen).map((o) => o.term)).size;
    if (inWindow > most || (inWindow === most && f.at < anchor)) {
      most = inWindow;
      anchor = f.at;
    }
  }
  const start = Math.max(0, anchor - lead);
  const end = Math.min(content.length, start + maxLen);
  return (start > 0 ? "..." : "") + content.slice(start, end) + (end < content.length ? "..." : "");
}
