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

const OPERATOR = /^(file|commit|pr|label|author|repo|after|before):([\s\S]*)$/i;
const SHA = /^[0-9a-f]{7,40}$/;
const TIME_HINT = "Try 7d, 2w, 24h, yesterday or 2026-09-01.";

/** "#482", "482", "owner/repo#482" or a GitHub pull request URL. */
function parsePr(value: string): SessionQueryPr | null {
  const url = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i.exec(value);
  if (url) return { repository: url[1], number: Number(url[2]) };
  const qualified = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(value);
  if (qualified) return { repository: qualified[1], number: Number(qualified[2]) };
  const bare = /^#?(\d+)$/.exec(value);
  return bare ? { number: Number(bare[1]) } : null;
}

/** "owner/repo" in its original case, whatever form a repository was written
 *  in (URL, ssh remote, trailing .git): the key pull requests are stored by. */
export function repoSlugOf(value: string): string {
  return value
    .trim()
    .replace(/^(https?:\/\/|ssh:\/\/)?(git@)?github\.com[:/]/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
}

/** repoSlugOf lowercased, for comparing; a bare folder name passes through. */
export function normalizeRepoName(value: string): string {
  return repoSlugOf(value).toLowerCase();
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
