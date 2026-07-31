// Full-text search over the vault, block-granular.
//
// ONE DOCUMENT PER BLOCK, not per file. A note is a long document with many
// unrelated paragraphs; indexing it whole gives a single score and no idea
// where the hit is, so results can't show a line, a snippet, or a section.
// Per-block documents give the hit's line, heading trail and block id for free
// — which is also what makes the `line:`/`section:`/`block:` operators
// possible later (they become scope filters over stored fields rather than a
// second index). File-level results are a rollup computed at query time.
//
// Plain search only. The operator grammar (tag: path: file: -neg "phrase"
// /regex/) is a separate, larger task: a hand-written query parser over the
// metadata index. Nothing here should grow toward it.
//
// Pure and isomorphic: this runs inside the index worker.

import MiniSearch, { type SearchResult as MiniSearchResult } from "minisearch";
import type { ParsedNote } from "./parseNote";

interface BlockDoc {
  id: string;
  path: string;
  title: string;
  text: string;
  /** Heading trail joined for matching; boosted above body text. */
  headings: string;
  headingPath: string[];
  line: number;
  endLine: number;
  blockId?: string;
}

export interface SearchMatch {
  line: number;
  endLine: number;
  headingPath: string[];
  blockId?: string;
  /** A window of the block's text around the first matched term. */
  snippet: string;
  /** [start, end) ranges within `snippet` covering matched terms. */
  highlights: [number, number][];
  score: number;
  terms: string[];
}

export interface FileSearchResult {
  path: string;
  title: string;
  /** Best block score in this file. */
  score: number;
  matches: SearchMatch[];
}

export interface VaultSearchOptions {
  /** Max files returned. */
  limit?: number;
  /** Max blocks shown per file. */
  matchesPerFile?: number;
  /** Recency, pinning, "currently open" — anything that should tilt ranking
   *  without touching the index. Returns a multiplier; 1 is neutral. */
  boostFile?: (path: string) => number;
  /** Prefix-match the final term (type-ahead). Defaults to true. */
  prefix?: boolean;
  /** Edit distance as a fraction of term length. Defaults to 0.15. */
  fuzzy?: number | false;
}

const SNIPPET_RADIUS = 90;
const SNIPPET_MAX = 220;

function newEngine(): MiniSearch<BlockDoc> {
  return new MiniSearch<BlockDoc>({
    fields: ["text", "title", "headings"],
    storeFields: ["path", "title", "text", "headingPath", "line", "endLine", "blockId"],
    searchOptions: {
      boost: { title: 3, headings: 2 },
      prefix: true,
      combineWith: "AND",
    },
  });
}

export class VaultSearchIndex {
  private engine = newEngine();
  /** path → the block ids it contributed, so removal needs no rescan. */
  private docsByPath = new Map<string, string[]>();

  upsertNote(path: string, parsed: ParsedNote): void {
    this.removeNote(path);
    const title = parsed.title ?? "";
    const docs: BlockDoc[] = parsed.chunks.map((chunk) => ({
      id: `${path}#${chunk.line}`,
      path,
      title,
      text: chunk.text,
      headings: chunk.headingPath.join(" "),
      headingPath: chunk.headingPath,
      line: chunk.line,
      endLine: chunk.endLine,
      ...(chunk.blockId ? { blockId: chunk.blockId } : {}),
    }));
    // A heading with no prose under it would otherwise be unfindable — its
    // text only ever reaches the index through its children's headingPath.
    for (const heading of parsed.headings) {
      if (!heading.text) continue;
      const covered = parsed.chunks.some((c) => c.line > heading.line && c.line <= heading.endLine);
      if (covered) continue;
      docs.push({
        id: `${path}#${heading.line}`,
        path,
        title,
        text: heading.text,
        headings: heading.text,
        headingPath: [heading.text],
        line: heading.line,
        endLine: heading.endLine,
      });
    }
    if (!docs.length) return;
    this.engine.addAll(docs);
    this.docsByPath.set(
      path,
      docs.map((d) => d.id),
    );
  }

  removeNote(path: string): void {
    const ids = this.docsByPath.get(path);
    if (!ids) return;
    // `discard` marks by id without needing the original document back — the
    // caller has already replaced the note's content by the time we get here.
    for (const id of ids) this.engine.discard(id);
    this.docsByPath.delete(path);
  }

  renameNote(oldPath: string, newPath: string, parsed: ParsedNote): void {
    this.removeNote(oldPath);
    this.upsertNote(newPath, parsed);
  }

  clear(): void {
    this.engine = newEngine();
    this.docsByPath.clear();
  }

  get size(): number {
    return this.docsByPath.size;
  }

  search(query: string, options: VaultSearchOptions = {}): FileSearchResult[] {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const { limit = 50, matchesPerFile = 5, boostFile, prefix = true, fuzzy = 0.15 } = options;

    const raw = this.engine.search(trimmed, {
      prefix,
      fuzzy,
      boostDocument: boostFile
        ? (_id, _term, stored) => boostFile(String((stored as { path?: string } | undefined)?.path ?? ""))
        : undefined,
    });

    const byFile = new Map<string, FileSearchResult>();
    for (const hit of raw as (MiniSearchResult & Partial<BlockDoc>)[]) {
      const path = hit.path;
      if (!path) continue;
      const terms = hit.terms ?? [];
      let file = byFile.get(path);
      if (!file) {
        file = { path, title: hit.title || path, score: 0, matches: [] };
        byFile.set(path, file);
      }
      file.score = Math.max(file.score, hit.score);
      file.matches.push({
        line: hit.line ?? 1,
        endLine: hit.endLine ?? hit.line ?? 1,
        headingPath: hit.headingPath ?? [],
        ...(hit.blockId ? { blockId: hit.blockId } : {}),
        ...snippetFor(hit.text ?? "", terms),
        score: hit.score,
        terms,
      });
    }

    const files = [...byFile.values()].sort((a, b) => b.score - a.score).slice(0, limit);
    for (const file of files) {
      file.matches.sort((a, b) => b.score - a.score || a.line - b.line);
      file.matches = file.matches.slice(0, matchesPerFile);
    }
    return files;
  }
}

/** A readable window around the first match, with highlight ranges the UI can
 *  paint without re-running the matcher. */
export function snippetFor(
  text: string,
  terms: string[],
): { snippet: string; highlights: [number, number][] } {
  if (!text) return { snippet: "", highlights: [] };
  const lower = text.toLowerCase();
  const hits: [number, number][] = [];
  for (const term of terms) {
    const needle = term.toLowerCase();
    if (!needle) continue;
    let at = lower.indexOf(needle);
    while (at >= 0) {
      hits.push([at, at + needle.length]);
      at = lower.indexOf(needle, at + needle.length);
      if (hits.length > 64) break;
    }
  }
  hits.sort((a, b) => a[0] - b[0]);

  const first = hits[0]?.[0] ?? 0;
  let start = Math.max(0, first - SNIPPET_RADIUS);
  let end = Math.min(text.length, start + SNIPPET_MAX);
  if (start > 0) {
    // Don't cut mid-word.
    const space = text.indexOf(" ", start);
    if (space >= 0 && space < start + 20) start = space + 1;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > start + 20) end = space;
  }

  const snippet = `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
  const shift = (start > 0 ? 1 : 0) - start;
  const highlights = hits
    .filter(([s, e]) => s >= start && e <= end)
    .map(([s, e]) => [s + shift, e + shift] as [number, number]);
  return { snippet, highlights };
}
