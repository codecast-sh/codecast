// The pure parts of browsing a repository: line anchors, blame lookup, tree
// ordering and the small format helpers the source pages share.
//
// Everything here is a function of its arguments, so the pages stay about
// layout and the rules that are easy to get wrong (a reversed line range, a
// blame gap, a directory sorted after its files) get tested on their own.

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

export type LineRange = { start: number; end: number };

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

/** Extend a selection to a shift-clicked line, anchored on where it started. */
export function extendLineRange(current: LineRange | null, line: number): LineRange {
  if (!current) return { start: line, end: line };
  return { start: Math.min(current.start, line), end: Math.max(current.start, line) };
}

export function isLineSelected(range: LineRange | null, line: number): boolean {
  return !!range && line >= range.start && line <= range.end;
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
// The file path a tree or blob is showing rides in the query string, not the
// route: the tab shell matches a tab's path against a fixed set of segments, so
// a route with a variable-length tail could not be rendered in a tab at all.

export function repoHistoryHref(repository: string, branch?: string): string {
  return `/repo/${repository}${branch ? `?branch=${encodeURIComponent(branch)}` : ""}`;
}

export function repoTreeHref(repository: string, ref: string, path?: string): string {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  return `/repo/${repository}/tree/${encodeURIComponent(ref)}${query}`;
}

/**
 * No line fragment here on purpose. Inside the tab shell a tab holds one path
 * string and the pane splits it on "?", so a trailing "#L12" would be read as
 * part of the query. Selecting a line writes the fragment onto the real URL
 * instead, which is what a reader copies.
 */
export function repoBlobHref(repository: string, ref: string, path: string): string {
  return `/repo/${repository}/blob/${encodeURIComponent(ref)}?path=${encodeURIComponent(path)}`;
}
