// The vault search query grammar: the small operator core, parsed before the
// text ever reaches minisearch.
//
// Why parse first instead of teaching the index: `path:`, `file:`, `tag:` and
// `-term` are FILTERS over metadata the index already has as maps (paths, tag
// index), and `"phrase"` is a constraint the bag-of-words index cannot express
// at all. Turning them into pre/post filters keeps one plain query going to
// minisearch — which is what its ranking is good at — and keeps every operator
// testable without an index.
//
// Pure and dependency-light on purpose: the pane composes these with the
// index; nothing here touches React or the store.

import { basenameOf, stripKnownExtension } from "./parseNote";
import { tokenizeQuery as tokenize } from "../search/tokenize";

export interface VaultQuery {
  /** Plain terms handed to minisearch (words inside phrases included). */
  text: string;
  /** Vault-relative path must contain EVERY one of these, case-insensitive. */
  paths: string[];
  /** Basename (no extension) must contain every one of these. */
  files: string[];
  /** Note must carry every one of these tags, or a tag nested under one. */
  tags: string[];
  /** A block must contain each phrase verbatim, case-insensitive. */
  phrases: string[];
  /** Files whose text contains any of these are dropped. */
  negations: string[];
  /** Nothing was asked for — the pane shows its teaching state. */
  isEmpty: boolean;
}

const EMPTY_QUERY: VaultQuery = {
  text: "",
  paths: [],
  files: [],
  tags: [],
  phrases: [],
  negations: [],
  isEmpty: true,
};

const OPERATOR = /^(path|file|tag):(.*)$/i;

export function parseVaultQuery(input: string): VaultQuery {
  const tokens = tokenize(input);
  if (tokens.length === 0) return EMPTY_QUERY;

  const terms: string[] = [];
  const q: VaultQuery = {
    text: "",
    paths: [],
    files: [],
    tags: [],
    phrases: [],
    negations: [],
    isEmpty: true,
  };

  for (const token of tokens) {
    if (token.value.startsWith("-") && token.value.length > 1) {
      q.negations.push(token.value.slice(1).toLowerCase());
      continue;
    }
    const op = OPERATOR.exec(token.value);
    if (op) {
      // A dangling operator (`tag:`) is a half-typed filter, not a search for
      // the word "tag" — it contributes nothing until it has a value.
      const value = op[2].trim();
      if (!value) continue;
      const name = op[1].toLowerCase();
      if (name === "path") q.paths.push(value.toLowerCase());
      else if (name === "file") q.files.push(value.toLowerCase());
      else q.tags.push(value.replace(/^#/, "").toLowerCase());
      continue;
    }
    if (token.quoted) {
      const phrase = token.value.trim();
      if (!phrase) continue;
      q.phrases.push(phrase.toLowerCase());
      // The phrase's words still go to the index: minisearch narrows to the
      // blocks that contain them all, and the phrase check filters what's left.
      terms.push(phrase);
      continue;
    }
    terms.push(token.raw);
  }

  q.text = terms.join(" ").trim();
  q.isEmpty =
    !q.text && !q.paths.length && !q.files.length && !q.tags.length && !q.negations.length;
  return q;
}

/** True when the query asks for something the index can rank — otherwise the
 *  pane lists filter matches instead of running a search. */
export function hasRankableText(q: VaultQuery): boolean {
  return q.text.trim().length > 0;
}

/** `path:` / `file:` / `-term`, everything decidable from one file's path and
 *  prose. Tags are decided by the index (nested tags), phrases per block. */
export function fileMatchesQuery(q: VaultQuery, path: string, text: string): boolean {
  const lowerPath = path.toLowerCase();
  if (!q.paths.every((p) => lowerPath.includes(p))) return false;
  if (q.files.length) {
    const base = stripKnownExtension(basenameOf(path)).toLowerCase();
    if (!q.files.every((f) => base.includes(f))) return false;
  }
  if (q.negations.length) {
    const haystack = `${lowerPath}\n${text.toLowerCase()}`;
    if (q.negations.some((n) => haystack.includes(n))) return false;
  }
  return true;
}

/** Phrases are checked against a block's own text with whitespace collapsed, so
 *  a phrase that straddles a soft wrap still counts as contiguous. */
export function blockMatchesPhrases(text: string, phrases: string[]): boolean {
  if (!phrases.length) return true;
  const flat = text.toLowerCase().replace(/\s+/g, " ");
  return phrases.every((p) => flat.includes(p.replace(/\s+/g, " ")));
}
