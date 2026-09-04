// The pure parts of browsing a repository: line anchors, blame lookup, tree
// ordering and the small format helpers the source pages share.
//
// Everything here is a function of its arguments, so the pages stay about
// layout and the rules that are easy to get wrong (a reversed line range, a
// blame gap, a directory sorted after its files) get tested on their own.
//
// A selected run of lines (LineRange and the arithmetic over it) lives in
// patchParser, next to the diff anchor it also describes; the hash helpers
// below are the URL half of that, which only a source page needs.

import { type LineRange } from "./patchParser";

export type RepoTreeEntry = {
  path: string;
  type: string;
  sha: string;
  size?: number;
};

export type RepoBlameRange = {
  start_line: number;
  end_line: number;
  sha: string;
  message?: string;
  author_name?: string;
  author_login?: string;
  author_avatar_url?: string;
  committed_at?: number;
};

/** A file this long renders unhighlighted: Prism walks it on the main thread,
 *  and past a few thousand lines that stall costs more than the colour buys. */
export const HIGHLIGHT_LINE_LIMIT = 5000;

/**
 * The line or range a URL fragment names: `#L12` is one line, `#L12-L20` a
 * range. A backwards range (`#L20-L12`) is the same range written the other
 * way round, which is what a shift click up the file produces.
 */
export function parseLineHash(hash: string | undefined | null): LineRange | null {
  if (!hash) return null;
  const match = hash.replace(/^#/, "").match(/^L(\d+)(?:-L?(\d+))?$/i);
  if (!match) return null;
  const first = Number(match[1]);
  const second = match[2] === undefined ? first : Number(match[2]);
  if (!Number.isFinite(first) || !Number.isFinite(second) || first < 1 || second < 1) return null;
  return { start: Math.min(first, second), end: Math.max(first, second) };
}

/** The fragment for a selection, in the form parseLineHash reads back. */
export function formatLineHash(range: LineRange | null): string {
  if (!range) return "";
  return range.start === range.end ? `#L${range.start}` : `#L${range.start}-L${range.end}`;
}

/**
 * Blame as a lookup by line.
 *
 * GitHub returns ranges in file order, but a range can be missing (a line
 * nobody has touched in the window it walked), so the lookup binary searches
 * and answers undefined rather than guessing at a neighbour.
 */
export function indexBlameRanges(
  ranges: readonly RepoBlameRange[] | undefined,
): (line: number) => RepoBlameRange | undefined {
  const sorted = [...(ranges ?? [])].sort((a, b) => a.start_line - b.start_line);
  return (line: number) => {
    let lo = 0;
    let hi = sorted.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const range = sorted[mid];
      if (line < range.start_line) hi = mid - 1;
      else if (line > range.end_line) lo = mid + 1;
      else return range;
    }
    return undefined;
  };
}

/** True on the first line of a blame range, which is where its label goes. */
export function startsBlameRange(range: RepoBlameRange | undefined, line: number): boolean {
  return !!range && range.start_line === line;
}

/** The subject line and the rest of a commit message. */
export function splitCommitMessage(message: string | undefined): { subject: string; body: string } {
  const lines = (message ?? "").split("\n");
  return { subject: lines[0] ?? "", body: lines.slice(1).join("\n").trim() };
}

/** Folders before files, each group by name — the order every file browser uses. */
export function sortTreeEntries(entries: readonly RepoTreeEntry[]): RepoTreeEntry[] {
  return [...entries].sort((a, b) => {
    const aDir = a.type === "tree";
    const bDir = b.type === "tree";
    if (aDir !== bDir) return aDir ? -1 : 1;
    return entryName(a.path).localeCompare(entryName(b.path));
  });
}

/** The last segment of a path — a tree entry's own name. */
export function entryName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

/** Path segments with no empties, so "" and "/a//b" both behave. */
export function pathSegments(path: string | undefined | null): string[] {
  return (path ?? "").split("/").filter(Boolean);
}

export function joinPath(...parts: (string | undefined)[]): string {
  return parts.filter(Boolean).join("/").replace(/\/+/g, "/");
}

/** Every prefix of a path, for a breadcrumb: "a/b" gives a, then a/b. */
export function breadcrumbTrail(path: string | undefined): { name: string; path: string }[] {
  const segments = pathSegments(path);
  return segments.map((name, i) => ({ name, path: segments.slice(0, i + 1).join("/") }));
}

export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined || bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The accent a commit page wears: green when it mostly adds, red when it mostly
 * removes, yellow when it is a rewrite of about equal weight. A commit with no
 * counted change is quiet.
 */
export function commitBalanceAccent(insertions: number, deletions: number): string {
  const total = insertions + deletions;
  if (total === 0) return "var(--sol-text-dim)";
  const added = insertions / total;
  if (added >= 0.7) return "var(--sol-green)";
  if (added <= 0.3) return "var(--sol-red)";
  return "var(--sol-yellow)";
}

/** Case-insensitive substring filter over tree entries, matched on the name. */
export function filterTreeEntries(
  entries: readonly RepoTreeEntry[],
  filter: string,
): RepoTreeEntry[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return [...entries];
  return entries.filter((e) => entryName(e.path).toLowerCase().includes(needle));
}

/** Which entry the j/k keys land on next, clamped to the list. */
export function moveCursor(index: number, delta: number, length: number): number {
  if (length === 0) return 0;
  return Math.min(length - 1, Math.max(0, index + delta));
}

// ── Where the pages live ──
//
// Every repository page exists in two forms. The APP form lives under /repo
// inside the dashboard, so it can be a tab and sit beside the inbox. The
// STANDALONE form lives under /r, outside every shell, so a repository can be
// a window of its own and a public link somebody who has never signed in can
// open. Both forms render the same page components, so the only difference a
// page has to carry is which family it is in.
//
// The file path a tree or blob is showing rides in the query string, not the
// route: the tab shell matches a tab's path against a fixed set of segments, so
// a route with a variable-length tail could not be rendered in a tab at all.

export type RepoRouteFamily = "app" | "standalone";

/** The prefix a repository's pages hang off in one family. */
function repoBase(repository: string, family: RepoRouteFamily): string {
  return family === "standalone" ? `/r/${repository}` : `/repo/${repository}`;
}

/** The family a live path belongs to. Anything outside /r is the app form. */
export function repoFamilyOf(pathname: string | null | undefined): RepoRouteFamily {
  const clean = (pathname ?? "").split("?")[0].split("#")[0];
  return clean === "/r" || clean.startsWith("/r/") ? "standalone" : "app";
}

function query(parts: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(parts)) if (value) search.set(key, value);
  const text = search.toString();
  return text ? `?${text}` : "";
}

/** The repository itself: its default branch, its tree, its readme. */
export function repoHomeHref(repository: string, family: RepoRouteFamily = "app"): string {
  return repoBase(repository, family);
}

export function repoTreeHref(
  repository: string,
  ref: string,
  path?: string,
  family: RepoRouteFamily = "app",
): string {
  return `${repoBase(repository, family)}/tree/${encodeURIComponent(ref)}${query({ path })}`;
}

/**
 * No line fragment here on purpose. Inside the tab shell a tab holds one path
 * string and the pane splits it on "?", so a trailing "#L12" would be read as
 * part of the query. Selecting a line writes the fragment onto the real URL
 * instead, which is what a reader copies.
 */
export function repoBlobHref(
  repository: string,
  ref: string,
  path: string,
  family: RepoRouteFamily = "app",
): string {
  return `${repoBase(repository, family)}/blob/${encodeURIComponent(ref)}${query({ path })}`;
}

/**
 * The commit list at a ref. With `path` it is the history of one file, with
 * `author` it is the history of one person; both ride in the query for the
 * same reason the tree's path does.
 */
export function repoCommitsHref(
  repository: string,
  ref: string,
  opts: { path?: string; author?: string; family?: RepoRouteFamily } = {},
): string {
  const base = repoBase(repository, opts.family ?? "app");
  return `${base}/commits/${encodeURIComponent(ref)}${query({ path: opts.path, author: opts.author })}`;
}

/**
 * The older spelling of the commit list, kept because links to a repository's
 * history are already written down in sessions and comments.
 */
export function repoHistoryHref(
  repository: string,
  branch?: string,
  family: RepoRouteFamily = "app",
): string {
  return repoCommitsHref(repository, branch || "HEAD", { family });
}

/** Two refs compared. GitHub writes the range as `base...head`. */
export function repoCompareHref(
  repository: string,
  base: string,
  head: string,
  family: RepoRouteFamily = "app",
): string {
  return `${repoBase(repository, family)}/compare/${encodeURIComponent(`${base}...${head}`)}`;
}

/** The two refs a compare range names, or null when it is not a range. */
export function parseCompareRange(range: string | undefined | null): { base: string; head: string } | null {
  const decoded = decodeURIComponent(range ?? "");
  const at = decoded.indexOf("...");
  if (at <= 0 || at + 3 >= decoded.length) return null;
  return { base: decoded.slice(0, at), head: decoded.slice(at + 3) };
}

export function repoBranchesHref(repository: string, family: RepoRouteFamily = "app"): string {
  return `${repoBase(repository, family)}/branches`;
}

export function repoTagsHref(repository: string, family: RepoRouteFamily = "app"): string {
  return `${repoBase(repository, family)}/tags`;
}

export function repoPullsHref(repository: string, family: RepoRouteFamily = "app"): string {
  return `${repoBase(repository, family)}/pulls`;
}

export function repoSearchHref(
  repository: string,
  q?: string,
  family: RepoRouteFamily = "app",
): string {
  return `${repoBase(repository, family)}/search${query({ q })}`;
}

/**
 * One commit and one pull request. In the app form these are top level pages
 * of their own, which is where every link written so far points; in the
 * standalone form they sit under the repository, because /r is the whole of
 * what a signed-out reader may see.
 */
export function commitPageHref(
  repository: string,
  sha: string,
  family: RepoRouteFamily = "app",
): string {
  return family === "standalone" ? `/r/${repository}/commit/${sha}` : `/commit/${repository}/${sha}`;
}

export function prPageHref(
  repository: string,
  number: number | string,
  family: RepoRouteFamily = "app",
): string {
  return family === "standalone" ? `/r/${repository}/pull/${number}` : `/pr/${repository}/${number}`;
}

// ── Between the two families ──
//
// Both conversions are pure string work over the path, keeping the query and
// the fragment untouched, so a page can hand its own live URL across without
// knowing which builder made it. A path that is not a repository, commit or
// pull request page comes back unchanged.

function splitHref(href: string): [string, string] {
  const at = href.search(/[?#]/);
  return at === -1 ? [href, ""] : [href.slice(0, at), href.slice(at)];
}

export function toStandaloneHref(appHref: string): string {
  const [path, rest] = splitHref(appHref);
  const commit = path.match(/^\/commit\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (commit) return `/r/${commit[1]}/${commit[2]}/commit/${commit[3]}${rest}`;
  const pr = path.match(/^\/pr\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (pr) return `/r/${pr[1]}/${pr[2]}/pull/${pr[3]}${rest}`;
  const repo = path.match(/^\/repo\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (repo) return `/r/${repo[1]}/${repo[2]}${repo[3] ?? ""}${rest}`;
  return appHref;
}

export function toAppHref(standaloneHref: string): string {
  const [path, rest] = splitHref(standaloneHref);
  const commit = path.match(/^\/r\/([^/]+)\/([^/]+)\/commit\/([^/]+)$/);
  if (commit) return `/commit/${commit[1]}/${commit[2]}/${commit[3]}${rest}`;
  const pr = path.match(/^\/r\/([^/]+)\/([^/]+)\/pull\/([^/]+)$/);
  if (pr) return `/pr/${pr[1]}/${pr[2]}/${pr[3]}${rest}`;
  const repo = path.match(/^\/r\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (repo) return `/repo/${repo[1]}/${repo[2]}${repo[3] ?? ""}${rest}`;
  return standaloneHref;
}
