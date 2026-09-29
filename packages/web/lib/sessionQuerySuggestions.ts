// Autocomplete for the session query language, shared by the /search input and
// the command palette. The grammar (operator names, their hints, how a value is
// quoted, where the token being typed starts) lives in @codecast/shared/search;
// this file only picks candidates for a value from what the client already
// holds: the viewer's labels, teammates, the repositories and pull requests in
// the store, and the files the viewer's recent sessions edited.

import {
  extractRepoFromRemoteUrl,
} from "@codecast/shared/contracts";
import {
  matchingSessionOperators,
  sessionFilter,
  type SessionQueryCompletion,
  type SessionQueryOperator,
} from "@codecast/shared/search";
import { matchScore } from "./mentionRanking";

export type QuerySuggestion = {
  /** The query text that replaces the token being typed. */
  text: string;
  /** What the row shows in monospace: the operator, or the value. */
  label: string;
  hint?: string;
};

export type SuggestionSources = {
  files?: string[];
  labels?: string[];
  people?: Array<{ name?: string | null; email?: string | null; github_username?: string | null }>;
  repos?: string[];
  prs?: Array<{ repository: string; number: number; title?: string }>;
  commits?: Array<{ sha: string; message?: string }>;
};

const TIME_PRESETS: Array<[string, string]> = [
  ["1d", "the last day"],
  ["7d", "the last week"],
  ["30d", "the last month"],
  ["yesterday", "since yesterday began"],
];

const LIMIT = 8;

type Candidate = { value: string; hint?: string; match?: string };

function candidatesFor(op: SessionQueryOperator, src: SuggestionSources): Candidate[] {
  switch (op) {
    case "file":
      return (src.files ?? []).map((value) => ({ value }));
    case "label":
      return (src.labels ?? []).map((value) => ({ value }));
    case "author":
      return [
        { value: "me", hint: "your own sessions" },
        ...(src.people ?? []).flatMap((p) => {
          const value = p.github_username || p.name || p.email;
          return value ? [{ value, hint: p.name && p.name !== value ? p.name : undefined, match: [p.name, p.email, p.github_username].filter(Boolean).join(" ") }] : [];
        }),
      ];
    case "repo":
      return (src.repos ?? []).map((value) => ({ value }));
    case "pr":
      return (src.prs ?? []).map((p) => ({ value: `${p.repository}#${p.number}`, hint: p.title, match: `${p.repository}#${p.number} ${p.title ?? ""}` }));
    case "commit":
      return (src.commits ?? []).map((c) => ({ value: c.sha.slice(0, 7), hint: c.message?.split("\n")[0], match: `${c.sha} ${c.message ?? ""}` }));
    case "after":
    case "before":
      return TIME_PRESETS.map(([value, hint]) => ({ value, hint }));
  }
}

/** The rows to offer for what is being typed, best first. */
export function sessionQuerySuggestions(
  completion: SessionQueryCompletion | null,
  src: SuggestionSources,
  limit = LIMIT,
): QuerySuggestion[] {
  if (!completion) return [];
  if (completion.kind === "operator") {
    return matchingSessionOperators(completion.partial).map((o) => ({ text: o.op, label: o.op, hint: o.hint }));
  }
  const q = completion.partial.trim();
  const seen = new Set<string>();
  const ranked = candidatesFor(completion.op, src)
    .map((c, i) => ({ c, i, s: q ? matchScore(c.match ?? c.value, q) : 0 }))
    .filter(({ c, s }) => s !== Infinity && !seen.has(c.value) && (seen.add(c.value), true))
    // The sources arrive newest first; a tie keeps that order.
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .slice(0, limit);
  // A value typed in full is already done; offering it back is noise.
  if (ranked.length === 1 && ranked[0].c.value.toLowerCase() === q.toLowerCase()) return [];
  return ranked.map(({ c }) => ({ text: sessionFilter(completion.op, c.value), label: c.value, hint: c.hint }));
}

/** Repositories named by a set of sessions, most recently active first. */
export function reposFromSessions(
  sessions: Iterable<{ git_remote_url?: string | null; git_root?: string | null; updated_at?: number }>,
): string[] {
  const latest = new Map<string, number>();
  for (const s of sessions) {
    const name =
      (s.git_remote_url && extractRepoFromRemoteUrl(s.git_remote_url)) ||
      (s.git_root ? s.git_root.replace(/\/+$/, "").split("/").pop() : null);
    if (!name) continue;
    latest.set(name, Math.max(latest.get(name) ?? 0, s.updated_at ?? 0));
  }
  return [...latest.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
}
