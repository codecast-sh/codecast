// Pure text-search logic shared by the message search surfaces (web searchMessages,
// CLI searchForCLI, CLI feedForCLI). No ctx/db access — unit-testable with bun:test.
//
// What a query means and how a text answers it live in @codecast/shared/search
// (terms.ts), shared with the CLI and the web marks. This file applies that
// model to a pool of messages: which conversations qualify, and in what order.

import {
  parseQueryTerms,
  contentMatchesSearch,
  contentMatchesAnyTerm,
  emptyEvidence,
  addEvidence,
  coverageOf,
  relevanceOf,
  snippetAround,
  type ParsedTerms,
  type Evidence,
} from "@codecast/shared/search";

export { contentMatchesSearch, contentMatchesAnyTerm, type ParsedTerms, type Evidence };
export const parseSearchTerms = parseQueryTerms;

export function conversationMatchesAllTerms(
  messages: Array<{ content?: string | null }>,
  terms: { phrases: string[]; words: string[] }
): boolean {
  return contentMatchesSearch(messages.map((m) => m.content || "").join(" "), terms);
}

// Pool messages grouped by conversation, keeping each message that holds any
// term so a match across several messages still counts and every snippet is
// at hand. rankConversationsByCoverage then decides which groups qualify.
export function groupMessagesByConversation<M extends { content?: string | null; role: string; conversation_id: { toString(): string } }>(
  pool: M[],
  terms: ParsedTerms,
  userOnly = false,
): Map<string, M[]> {
  const groups = new Map<string, M[]>();
  for (const msg of pool) {
    if (userOnly && msg.role !== "user") continue;
    if (!contentMatchesAnyTerm(msg.content || "", terms)) continue;
    const convId = msg.conversation_id.toString();
    const list = groups.get(convId);
    if (list) list.push(msg);
    else groups.set(convId, [msg]);
  }
  return groups;
}

export type RankedConversation<M> = {
  convId: string;
  messages: M[];
  coverage: number;
  /** What the messages say about the query, for callers that add the
   *  session's title and summaries before ranking (relevanceWithFields). */
  evidence: Evidence;
  /** One score per message, parallel to `messages`: which rows show the query best. */
  scores: number[];
};

type RankableMessage = { content?: string | null; role?: string; tool_results_count?: number };

// A user row that carries tool results is the harness talking, not the person.
const isOwnText = (m: RankableMessage) => m.role === "user" && !m.tool_results_count;

// Which conversations qualify, best coverage first. Quoted phrases stay
// required. Short word queries (≤2) keep exact AND semantics; longer queries
// degrade to best-effort: a conversation qualifies when at least half the words
// match. Sort is stable, so within a coverage tier the caller's pool order is
// preserved (it decides who survives a candidate slice, see
// fetchMessageSearchPool); the order a person sees comes from relevance, once
// the caller has the conversation's own fields to add.
export function rankConversationsByCoverage<M extends RankableMessage>(
  groups: Map<string, M[]>,
  terms: ParsedTerms
): Array<RankedConversation<M>> {
  const ranked: Array<RankedConversation<M>> = [];
  for (const [convId, messages] of groups) {
    const evidence = emptyEvidence(terms);
    const scores = messages.map((m) => addEvidence(evidence, m.content, terms, { own: isOwnText(m), message: true })?.score ?? 0);
    const coverage = coverageOf(evidence, terms);
    if (coverage === null) continue;
    ranked.push({ convId, messages, coverage, evidence, scores });
  }
  return ranked.sort((a, b) => b.coverage - a.coverage);
}

/** Relevance of a ranked conversation once its own fields (title, summaries,
 *  opening prompt, earlier titles) count as text the person wrote. */
export function relevanceWithFields(
  ranked: { evidence: Evidence },
  fields: Array<string | null | undefined>,
  terms: ParsedTerms,
): number {
  const evidence: Evidence = {
    ...ranked.evidence,
    best: [...ranked.evidence.best],
    own: [...ranked.evidence.own],
    pairs: [...ranked.evidence.pairs],
    phrases: [...ranked.evidence.phrases],
  };
  for (const field of fields) addEvidence(evidence, field, terms, { own: true });
  return relevanceOf(evidence, terms);
}

/** The messages that show the query best, best first; ties keep pool order. */
export function bestMessages<M>(ranked: { messages: M[]; scores: number[] }, limit: number): M[] {
  return ranked.messages
    .map((m, i) => ({ m, score: ranked.scores[i] ?? 0, i }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.m);
}

// Everything a session says about itself outside its messages. first_prompt
// and earlier_titles are what it was when it began and what it was called
// since: a long session drifts, and the person looking for it remembers the
// start as often as the end.
type SearchableConversation = {
  title?: string | null;
  subtitle?: string | null;
  idle_summary?: string | null;
  first_prompt?: string | null;
  earlier_titles?: string[] | null;
};

export function searchFieldsOf(conv: SearchableConversation): string[] {
  return [conv.title, conv.subtitle, conv.idle_summary, conv.first_prompt, ...(conv.earlier_titles ?? [])]
    .filter((f): f is string => !!f);
}

/** The session's beginnings that answer the query, for a result row to show
 *  beside a title that has since moved on. Absent when neither matches. */
export function originMatch(
  conv: SearchableConversation,
  terms: ParsedTerms,
): { started_as?: string; earlier_titles?: string[] } | undefined {
  const started = conv.first_prompt && contentMatchesAnyTerm(conv.first_prompt, terms)
    ? snippetAround(conv.first_prompt, terms, 200)
    : undefined;
  const earlier = (conv.earlier_titles ?? []).filter((t) => t !== conv.title && contentMatchesAnyTerm(t, terms));
  if (!started && earlier.length === 0) return undefined;
  return { ...(started ? { started_as: started } : {}), ...(earlier.length ? { earlier_titles: earlier } : {}) };
}

const EARLIER_TITLES_KEPT = 6;
/** A session's earlier titles once `next` replaces its current one: distinct,
 *  oldest dropped first. undefined when the title is not changing. */
export function earlierTitlesAfter(conv: { title?: string | null; earlier_titles?: string[] | null }, next: string): string[] | undefined {
  const current = conv.title?.trim();
  if (!current || current === next.trim()) return undefined;
  const kept = (conv.earlier_titles ?? []).filter((t) => t !== current && t !== next.trim());
  return [...kept, current].slice(-EARLIER_TITLES_KEPT);
}
