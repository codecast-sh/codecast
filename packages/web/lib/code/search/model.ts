// The results of one project search, as the daemon streams them: files sorted
// by path (ripgrep's threads finish in any order, and a list that reshuffles on
// every rerun walks F4 differently each time), each with its matching lines. The pane draws a flat
// list of rows from it (a file header, then one row per match), which is what
// the virtualized list and keyboard navigation walk.
//
// Mutable on purpose: a search over a big repo lands thousands of matches in a
// few hundred milliseconds, and each NDJSON line appends in place and bumps
// `version`. Readers rebuild their rows from the version, at most once a frame.

import type { CodeSearchEvent, CodeSearchLine } from "@codecast/shared/contracts";
import type { ProjectQuery } from "./query";
import type { MatchTarget } from "./replace";

export interface FileResult {
  path: string;
  lines: CodeSearchLine[];
}

export interface MatchRef {
  file: FileResult;
  line: CodeSearchLine;
  /** Index into `line.ranges`. */
  range: number;
  key: string;
}

export type ResultRow = { kind: "file"; file: FileResult; key: string; count: number; collapsed: boolean } | ({ kind: "match" } & MatchRef);

export interface SearchSummary {
  files: number;
  matches: number;
  truncated: boolean;
  elapsedMs: number;
  engine: string;
}

/** Column of a match in the full line (a trimmed long line starts at `offset`). */
export const matchColumn = (line: CodeSearchLine, range: number) => (line.offset ?? 0) + line.ranges[range].start;

export const matchKey = (path: string, line: number, column: number) => `${path}\u0000${line}:${column}`;

export class SearchResults {
  files: FileResult[] = [];
  private byPath = new Map<string, FileResult>();
  readonly collapsed = new Set<string>();
  /** File paths the person dismissed. A dismissed match leaves `ranges`
   *  itself: a positional key would go stale once a replace moves its
   *  neighbours, and the match would come back. */
  readonly dismissed = new Set<string>();
  summary: SearchSummary | null = null;
  error: string | null = null;
  /** Milliseconds from the request to the first file. */
  firstResultMs: number | null = null;
  version = 0;
  private rowsCache: { version: number; rows: ResultRow[]; matches: MatchRef[] } | null = null;

  /** `vaultId`: the vault searched. Replace, F4 and the results editor act
   *  only while that vault is the one Files shows. `query`: what was asked,
   *  which replace and the preview use, since the box may already hold the
   *  next search while these rows are still on screen. */
  constructor(
    readonly vaultId: string | null = null,
    readonly query: ProjectQuery | null = null,
    readonly startedAt = performance.now(),
  ) {}

  add(event: CodeSearchEvent): void {
    if (event.type === "file") {
      if (this.firstResultMs === null) this.firstResultMs = performance.now() - this.startedAt;
      const existing = this.byPath.get(event.path);
      if (existing) existing.lines.push(...event.lines);
      else {
        const file = { path: event.path, lines: event.lines };
        this.files.splice(this.sortedIndex(event.path), 0, file);
        this.byPath.set(event.path, file);
      }
    } else if (event.type === "done") {
      this.summary = { files: event.files, matches: event.matches, truncated: event.truncated, elapsedMs: event.elapsed_ms, engine: event.engine };
    } else {
      this.error = event.message;
    }
    this.version++;
  }

  /** Where a new path goes in `files` to keep them sorted. */
  private sortedIndex(path: string): number {
    let lo = 0;
    let hi = this.files.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.files[mid].path < path) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  fail(message: string): void {
    this.error = message;
    this.version++;
  }

  file(path: string): FileResult | undefined {
    return this.byPath.get(path);
  }

  toggleCollapsed(path: string): void {
    if (!this.collapsed.delete(path)) this.collapsed.add(path);
    this.version++;
  }

  setAllCollapsed(collapsed: boolean): void {
    this.collapsed.clear();
    if (collapsed) for (const f of this.files) this.collapsed.add(f.path);
    this.version++;
  }

  /** Dismiss a file (its path) or one match (its key). */
  dismiss(key: string): void {
    const m = this.byPath.has(key) ? null : this.matches().find((x) => x.key === key);
    if (m) {
      m.line.ranges = m.line.ranges.filter((_, i) => i !== m.range);
      this.prune(m.file);
    } else this.dismissed.add(key);
    this.version++;
  }

  /** Drop lines left with no match, and the file when none are left. */
  private prune(file: FileResult): void {
    file.lines = file.lines.filter((l) => l.ranges.length > 0);
    if (!file.lines.length) {
      this.files = this.files.filter((f) => f !== file);
      this.byPath.delete(file.path);
    }
  }

  /** The visible matches of a file, in order. */
  matchesOf(file: FileResult): MatchRef[] {
    if (this.dismissed.has(file.path)) return [];
    const out: MatchRef[] = [];
    for (const line of file.lines) {
      for (let r = 0; r < line.ranges.length; r++) out.push({ file, line, range: r, key: matchKey(file.path, line.line, matchColumn(line, r)) });
    }
    return out;
  }

  private build() {
    if (this.rowsCache?.version === this.version) return this.rowsCache;
    const rows: ResultRow[] = [];
    const matches: MatchRef[] = [];
    for (const file of this.files) {
      const fileMatches = this.matchesOf(file);
      if (!fileMatches.length) continue;
      const collapsed = this.collapsed.has(file.path);
      rows.push({ kind: "file", file, key: file.path, count: fileMatches.length, collapsed });
      for (const m of fileMatches) {
        matches.push(m);
        if (!collapsed) rows.push({ kind: "match", ...m });
      }
    }
    this.rowsCache = { version: this.version, rows, matches };
    return this.rowsCache;
  }

  /** Rows to draw: headers, and the matches of expanded files. */
  rows(): ResultRow[] {
    return this.build().rows;
  }

  /** Every visible match, collapsed files included: what F4 walks. */
  matches(): MatchRef[] {
    return this.build().matches;
  }

  /** Visible match and file counts. */
  counts(): { matches: number; files: number } {
    const { rows, matches } = this.build();
    return { matches: matches.length, files: rows.filter((r) => r.kind === "file").length };
  }

  /** The visible matches by file, as replace targets. */
  targets(only?: string): Map<string, MatchTarget[]> {
    const out = new Map<string, MatchTarget[]>();
    for (const m of this.matches()) {
      if (only && m.file.path !== only) continue;
      const list = out.get(m.file.path) ?? [];
      list.push({ line: m.line.line, column: matchColumn(m.line, m.range) });
      out.set(m.file.path, list);
    }
    return out;
  }

  /**
   * A replace landed: the replaced matches leave the results, and the line's
   * text and its other matches move by what the replacement changed, so the
   * rows stay true without searching again.
   */
  replaced(path: string, edits: ReadonlyArray<{ line: number; column: number; length: number; insert: string }>): void {
    const file = this.byPath.get(path);
    if (!file) return;
    // Bottom up and right to left, so an edit never moves one still to come.
    for (const e of [...edits].sort((a, b) => b.line - a.line || b.column - a.column)) {
      const line = file.lines.find((l) => l.line === e.line);
      if (!line) continue;
      const offset = line.offset ?? 0;
      const at = e.column - offset;
      const idx = line.ranges.findIndex((r) => r.start === at);
      if (idx < 0) continue;
      const delta = e.insert.length - e.length;
      line.text = line.text.slice(0, at) + e.insert + line.text.slice(at + e.length);
      line.ranges = line.ranges.filter((_, i) => i !== idx).map((r) => (r.start > at ? { start: r.start + delta, end: r.end + delta } : r));
      // A replacement that inserted line breaks moves every line below it.
      const breaks = (e.insert.match(/\r\n|\r|\n/g) ?? []).length;
      if (breaks) for (const l of file.lines) if (l.line > e.line) l.line += breaks;
    }
    this.prune(file);
    this.version++;
  }
}
