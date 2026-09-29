// The session query language: free text, "quoted phrases", and operators that
// narrow which sessions the text is searched in. One parser for `cast search`,
// the web /search page (whose ?q= carries the whole query, so a filtered view
// is a link) and the server, so an operator means the same thing everywhere.
//
//   file:<path>      a file or folder the session edited (repo-relative or absolute)
//   commit:<sha>     a commit the session made (7 to 40 hex characters)
//   pr:<ref>         a pull request the session is linked to (123, owner/repo#123, or its URL)
//   label:<name>     a label the viewer filed the session under
//   author:<who>     who ran the session (name, email, or "me")
//   repo:<name>      the session's repository (owner/repo or the folder name)
//   after:<time>     the matching activity happened after this time
//   before:<time>    ... and before this one
//
// Operators of different kinds AND together, and so do repeats of one kind
// (`file:a file:b` is the sessions that touched both). A word that looks like
// an operator but is not one (`http:`, `todo:`) stays text. Values may be
// quoted: `file:"docs/a b.md"`.

import { parseEndDate, parseRelativeDate } from "../time";
import { tokenizeQuery } from "./tokenize";
import { extractRepoFromRemoteUrl, parseOwnerRepo, parsePrRef } from "../contracts/prRefs";

export type SessionQueryPr = { number: number; repository?: string };

export interface SessionQuery {
  /** What the text search runs on: plain words and "phrases", quotes kept. */
  text: string;
  files: string[];
  commits: string[];
  prs: SessionQueryPr[];
  labels: string[];
  authors: string[];
  repos: string[];
  after?: number;
  before?: number;
  /** One line per operator value that could not be read. */
  errors: string[];
  /** Any operator narrowed the query. */
  hasFilters: boolean;
}

export const SESSION_QUERY_OPERATORS = [
  { op: "file:", example: "file:src/auth.ts", hint: "sessions that edited a file or folder" },
  { op: "commit:", example: "commit:3f2a91c", hint: "the session that made a commit" },
  { op: "pr:", example: "pr:482", hint: "sessions linked to a pull request" },
  { op: "label:", example: "label:api", hint: "sessions filed under one of your labels" },
  { op: "author:", example: "author:me", hint: "who ran the session" },
  { op: "repo:", example: "repo:codecast", hint: "the session's repository" },
  { op: "after:", example: "after:7d", hint: "activity after a time (7d, 2w, yesterday, 2026-09-01)" },
  { op: "before:", example: "before:2026-09-01", hint: "activity before a time" },
] as const;

type OperatorName<T> = T extends `${infer N}:` ? N : never;
export type SessionQueryOperator = OperatorName<(typeof SESSION_QUERY_OPERATORS)[number]["op"]>;
const OPERATOR_NAMES = SESSION_QUERY_OPERATORS.map((o) => o.op.slice(0, -1));
const OPERATOR = new RegExp(`^(${OPERATOR_NAMES.join("|")}):([\\s\\S]*)$`, "i");
const SHA = /^[0-9a-f]{7,40}$/;
const TIME_HINT = "Try 7d, 2w, 24h, yesterday or 2026-09-01.";

/** "#482", "482", "owner/repo#482" or a pull request URL, read by the one
 *  pull request parser; a value naming a repository but no number is not one. */
function parsePr(value: string): SessionQueryPr | null {
  const ref = parsePrRef(value);
  if (ref?.number == null) return null;
  return ref.repository ? { repository: ref.repository, number: ref.number } : { number: ref.number };
}

/**
 * A repository as `repo:` and a session's git remote are compared: the
 * canonical lowercase "owner/repo" for anything GitHub names (an ssh or https
 * remote, a URL, owner/repo as typed), else the value trimmed and lowercased,
 * which is how a bare repository or folder name is written.
 */
export function normalizeRepoName(value: string): string {
  return (
    extractRepoFromRemoteUrl(value) ??
    parseOwnerRepo(value) ??
    value.trim().replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase()
  );
}

/** A session's absolute file path as the repository spells it, when it lies inside the checkout. */
export function pathInRepository(filePath: string, root: string | null | undefined): string | null {
  if (!root) return null;
  const base = root.replace(/\/+$/, "") + "/";
  return filePath.startsWith(base) ? filePath.slice(base.length) : null;
}

/** A file as a `file:` search spells it: repo-relative, and relative to its
 *  own worktree when the session edited a worktree nested in the checkout
 *  (`.codecast/worktrees/<name>/...`), since the index searches every
 *  checkout of a repository with the same relative path. Null outside the
 *  checkout. */
export function fileQueryPathFor(filePath: string, root: string | null | undefined): string | null {
  const rel = pathInRepository(filePath, root);
  return rel === null ? null : rel.replace(/^\.[^/]+\/worktrees\/[^/]+\//, "");
}

/** The repo-relative files a list of sessions edited, newest session first,
 *  each path once: what `file:` completes to. A path outside its session's
 *  checkout has no repo-relative spelling and is left out. */
export function recentFilesFromSessions(
  sessions: ReadonlyArray<{ recent_files?: string[] | null; git_root?: string | null }>,
  limit: number,
): string[] {
  const seen = new Set<string>();
  for (const s of sessions) {
    for (const file of s.recent_files ?? []) {
      const rel = fileQueryPathFor(file, s.git_root);
      if (rel) seen.add(rel);
      if (seen.size >= limit) return [...seen];
    }
  }
  return [...seen];
}

/** A file operator's path as the index compares it: no leading "./" and no
 *  trailing slash (a folder is matched as a prefix anyway). */
export function normalizeFileQueryPath(value: string): string {
  let path = value.trim().replace(/^(\.\/)+/, "");
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path;
}

export function parseSessionQuery(input: string, now: number = Date.now()): SessionQuery {
  const q: SessionQuery = {
    text: "",
    files: [],
    commits: [],
    prs: [],
    labels: [],
    authors: [],
    repos: [],
    errors: [],
    hasFilters: false,
  };
  const terms: string[] = [];

  const tokens = tokenizeQuery(input);
  tokens.forEach((token, i) => {
    const op = OPERATOR.exec(token.value);
    if (!op) {
      terms.push(token.raw);
      return;
    }
    // A dangling operator (`file:`) at the end is a filter being typed, not a
    // search for the word "file"; it adds nothing until it has a value. With
    // words after it (`file: src/a.ts`), the value was meant for it.
    const value = op[2].trim();
    if (!value) {
      if (i < tokens.length - 1) q.errors.push(`${op[1].toLowerCase()}: takes its value right after the colon, with no space (${op[1].toLowerCase()}:${tokens[i + 1].raw}).`);
      return;
    }
    const name = op[1].toLowerCase();
    if (name === "file") {
      if (value.startsWith("~")) {
        q.errors.push(`file: "${value}" starts with ~, which only your shell can expand. Use a repo-relative or absolute path.`);
      } else {
        q.files.push(normalizeFileQueryPath(value));
      }
    } else if (name === "commit") {
      const sha = value.toLowerCase();
      if (SHA.test(sha)) q.commits.push(sha);
      else q.errors.push(`commit: "${value}" is not a commit sha. Give at least 7 hex characters.`);
    } else if (name === "pr") {
      const pr = parsePr(value);
      if (pr) q.prs.push(pr);
      else q.errors.push(`pr: "${value}" is not a pull request. Use 482, owner/repo#482 or the pull request URL.`);
    } else if (name === "label") {
      q.labels.push(value);
    } else if (name === "author") {
      q.authors.push(value.toLowerCase());
    } else if (name === "repo") {
      q.repos.push(normalizeRepoName(value));
    } else {
      const at = name === "after" ? parseRelativeDate(value, now) : parseEndDate(value, now);
      if (at === null) q.errors.push(`${name}: can't read "${value}" as a time. ${TIME_HINT}`);
      // Repeats narrow: the latest after and the earliest before win.
      else if (name === "after") q.after = Math.max(q.after ?? at, at);
      else q.before = Math.min(q.before ?? at, at);
    }
  });

  q.text = terms.join(" ").trim();
  q.hasFilters =
    q.files.length + q.commits.length + q.prs.length + q.labels.length + q.authors.length + q.repos.length > 0 ||
    q.after !== undefined ||
    q.before !== undefined;
  return q;
}

/** A query that narrows or names something. A lone operator still being
 *  typed (`pr:`) parses to nothing, and searching nothing only spins. */
export function sessionQuerySearches(q: SessionQuery): boolean {
  return q.text.length > 0 || q.hasFilters;
}

/** One filter as query text, its value quoted when it holds a space or a
 *  quote would end it: `file:"docs/a b.md"`. The one writer every link and
 *  completion uses, so what it writes is what parseSessionQuery reads. */
export function sessionFilter(op: SessionQueryOperator, value: string): string {
  const v = value.trim().replace(/"/g, "");
  return /\s/.test(v) ? `${op}:"${v}"` : `${op}:${v}`;
}

/** The /search page narrowed to one filter: "sessions that touched this". */
export function sessionSearchHref(op: SessionQueryOperator, value: string): string {
  return `/search?q=${encodeURIComponent(sessionFilter(op, value))}`;
}

/**
 * What is being typed at the caret, for autocomplete: an operator name
 * (`fi` → file:) or an operator's value (`file:src/a`). `from`/`to` bound the
 * whole token, so a completion replaces it rather than inserting beside it.
 * A bare word only counts as a partial operator name when it is a prefix of
 * one (or the whole name, colon not yet typed); anything else is plain text
 * and completes nothing.
 */
export type SessionQueryCompletion =
  | { kind: "operator"; partial: string; from: number; to: number }
  | { kind: "value"; op: SessionQueryOperator; partial: string; from: number; to: number };

export function sessionQueryCompletion(input: string, caret: number = input.length): SessionQueryCompletion | null {
  // Token boundaries respect quotes, exactly as tokenizeQuery splits.
  let from = 0;
  let inQuotes = false;
  for (let i = 0; i < caret; i++) {
    const ch = input[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && /\s/.test(ch)) from = i + 1;
  }
  let to = caret;
  while (to < input.length && (inQuotes || !/\s/.test(input[to]))) {
    if (input[to] === '"') inQuotes = !inQuotes;
    to++;
  }
  const token = input.slice(from, caret);
  const op = OPERATOR.exec(token);
  if (op) {
    return { kind: "value", op: op[1].toLowerCase() as SessionQueryOperator, partial: op[2].replace(/"/g, ""), from, to };
  }
  const word = token.toLowerCase();
  // Two letters before a plain word is taken for a filter name ("pr" is the
  // shortest), so ordinary searching is not trailed by suggestions.
  if (!/^[a-z]{2,}$/.test(word) || !OPERATOR_NAMES.some((n) => n.startsWith(word))) return null;
  return { kind: "operator", partial: word, from, to };
}

/** The operators a partial name could be, in the list's order. */
export function matchingSessionOperators(partial: string) {
  const p = partial.toLowerCase();
  return SESSION_QUERY_OPERATORS.filter((o) => o.op.startsWith(p));
}

/** Put `text` where the completion's token was. A finished value gets a
 *  trailing space so the next word starts clean; an operator name does not,
 *  because its value comes next. */
export function applySessionQueryCompletion(
  input: string,
  completion: SessionQueryCompletion,
  text: string,
): { value: string; caret: number } {
  const tail = input.slice(completion.to);
  const sep = text.endsWith(":") || tail.startsWith(" ") ? "" : " ";
  const head = input.slice(0, completion.from) + text + sep;
  return { value: head + tail, caret: head.length };
}
