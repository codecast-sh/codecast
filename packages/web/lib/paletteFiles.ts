// The palette's file results: notes everywhere, and on a local vault every
// text file the code editor opens too. Pure, so the ranking is testable; the
// palette snapshots the vault's file table at open and calls this per query.

import { isVaultMarkdownPath, isVaultTextPath } from "@codecast/shared/contracts";
import { score } from "./mentionRanking";

export interface PaletteFileMatch {
  path: string;
  /** The name shown: a note's title (no extension), a code file's file name. */
  base: string;
  kind: "note" | "code";
  rank: number;
  mtime: number;
}

/**
 * Files matching `query`, best first, `cap` of each kind. Code files join only
 * when `includeCode` (a local vault: a read-only mirror has no editor).
 */
export function rankPaletteFiles(
  files: Record<string, { dir?: boolean; mtime?: number }>,
  query: string,
  opts: { includeCode: boolean; cap: number },
): { notes: PaletteFileMatch[]; code: PaletteFileMatch[] } {
  const q = query.trim().toLowerCase();
  if (!q) return { notes: [], code: [] };
  const notes: PaletteFileMatch[] = [];
  const code: PaletteFileMatch[] = [];
  for (const [path, entry] of Object.entries(files)) {
    if (entry.dir) continue;
    const note = isVaultMarkdownPath(path);
    if (!note && !(opts.includeCode && isVaultTextPath(path))) continue;
    const name = path.split("/").pop() || path;
    const base = note ? name.replace(/\.[^.]+$/, "") : name;
    const rank = Math.min(score(base, q), score(path, q));
    if (rank === Infinity) continue;
    (note ? notes : code).push({ path, base, kind: note ? "note" : "code", rank, mtime: entry.mtime || 0 });
  }
  const order = (a: PaletteFileMatch, b: PaletteFileMatch) => a.rank - b.rank || b.mtime - a.mtime;
  return { notes: notes.sort(order).slice(0, opts.cap), code: code.sort(order).slice(0, opts.cap) };
}
