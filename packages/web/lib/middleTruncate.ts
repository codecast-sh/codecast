// A path cut in the middle: the file name stays whole and the directories in
// front of it give way. A row that cuts a path at its end hides the one word
// the reader wants (`packages/web/components/conversation/blo…`).
//
// splitPath is the part components/conversation/blocks/PathText draws: two
// spans, the directory one shrinking to an ellipsis in CSS and the file name
// never shrinking, so the cut costs no measuring. middleTruncate is the same
// rule in characters, for text that has no layout to lean on (a title, a
// label built as a string). Pure: no React, no DOM.

export type PathParts = {
  /** Everything up to and including the last separator ("src/lib/"), or "" for a bare name. */
  dir: string;
  /** The file or last directory name ("server.ts"); a trailing slash stays on it ("dist/"). */
  base: string;
};

const SEP = /[\\/]/;

export function splitPath(path: string): PathParts {
  const trimmed = path.replace(/[\\/]+$/, "");
  let cut = -1;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    if (SEP.test(trimmed[i])) { cut = i; break; }
  }
  if (cut < 0) return { dir: "", base: path };
  return { dir: trimmed.slice(0, cut + 1), base: path.slice(cut + 1) };
}

/**
 * `path` in at most `max` characters, the file name kept: the first directory,
 * an ellipsis for the ones that do not fit, then as many directories nearest
 * the file as there is room for ("packages/…/blocks/ModernRow.tsx"). A name
 * longer than `max` on its own keeps its end, where the extension is.
 */
export function middleTruncate(path: string, max: number): string {
  if (path.length <= max) return path;
  const { dir, base } = splitPath(path);
  if (base.length >= max) return base.length === max ? base : `…${base.slice(base.length - max + 1)}`;
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  const root = SEP.test(dir[0] ?? "") ? sep : "";
  const segments = dir.split(SEP).filter(Boolean);
  const head = segments.length > 1 ? `${root}${segments[0]}${sep}` : root;
  let tail = "";
  for (let i = segments.length - 1; i >= 1; i--) {
    const next = `${segments[i]}${sep}${tail}`;
    if (head.length + 2 + next.length + base.length > max) break;
    tail = next;
  }
  const kept = `${head}…${sep}${tail}${base}`;
  if (kept.length <= max) return kept;
  const bare = `…${sep}${base}`;
  return bare.length <= max ? bare : `…${base}`;
}
