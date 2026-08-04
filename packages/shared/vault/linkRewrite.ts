// Rewriting `[[wiki links]]` when a note is renamed or moved.
//
// This is the feature people judge a vault app by: rename a note and every
// link that pointed at it still works, with the author's own spelling style
// intact. Get it wrong once — a mangled link, a corrupted line — and nobody
// trusts the rename button again. So the whole module is built to SKIP rather
// than guess: every edit is verified against the exact text it expects to
// replace, every new target is checked to actually resolve back to the moved
// file, and anything that can't be expressed safely is left alone.
//
// Everything here is pure. The store's renamePath computes a plan from the
// index BEFORE the daemon moves anything, then applies it after the move
// succeeds (store/vaultStore.ts).
//
// COORDINATES follow parseNote: `line` is 1-BASED, `col` is 0-BASED, and
// `raw` is the exact source text of the link — including the `!` of an embed.
// maskCodeSpans is length preserving, so `col` indexes the raw line directly.

import {
  basenameOf,
  stripKnownExtension,
  type NoteLink,
} from "./parseNote";
import { VaultIndex, normalizeTarget } from "./vaultIndex";

/** One link's replacement, anchored at the span the index recorded for it. */
export interface SpanEdit {
  line: number;
  col: number;
  /** What must be at (line, col) for the edit to apply. */
  raw: string;
  newRaw: string;
}

/** Edits for one file. `source` is the path to WRITE — for a folder move that
 *  is the source's own POST-move path, since the plan is applied after the
 *  daemon has already moved the files. */
export interface FileRewrite {
  source: string;
  edits: SpanEdit[];
}

export interface Move {
  from: string;
  to: string;
}

export interface SpanEditResult {
  content: string;
  applied: number;
  /** Edits dropped because the text at their span was not what the index said
   *  (the file changed under us) or because they overlapped another edit. */
  skipped: number;
}

/** Start offset of every line, splitting exactly the way parseNote does. */
function lineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === "\n") {
      starts.push(i + 1);
    } else if (ch === "\r") {
      if (content[i + 1] === "\n") i++;
      starts.push(i + 1);
    }
  }
  return starts;
}

/**
 * Replace spans bottom-up so earlier offsets stay valid, verifying the text at
 * each span first. A mismatch means the index is stale relative to the file on
 * disk; that edit is skipped rather than applied blind, which is the whole
 * safety property of this function.
 */
export function applySpanEdits(content: string, edits: SpanEdit[]): SpanEditResult {
  const starts = lineStarts(content);
  const resolved: { at: number; end: number; newRaw: string }[] = [];
  let skipped = 0;

  for (const edit of edits) {
    const lineStart = starts[edit.line - 1];
    if (lineStart === undefined || !edit.raw || edit.col < 0) {
      skipped++;
      continue;
    }
    const at = lineStart + edit.col;
    if (content.slice(at, at + edit.raw.length) !== edit.raw) {
      skipped++;
      continue;
    }
    resolved.push({ at, end: at + edit.raw.length, newRaw: edit.newRaw });
  }

  resolved.sort((a, b) => b.at - a.at);
  let out = content;
  let applied = 0;
  // Lowest start offset applied so far: anything reaching past it would be
  // editing text a previous splice already replaced.
  let floor = content.length;
  for (const r of resolved) {
    if (r.end > floor) {
      skipped++;
      continue;
    }
    out = `${out.slice(0, r.at)}${r.newRaw}${out.slice(r.end)}`;
    floor = r.at;
    applied++;
  }
  return { content: out, applied, skipped };
}

/**
 * The link's source text with a new target spliced in — the `!` embed marker,
 * the `#heading` / `#^block` subpath, the `|alias` (which for an image embed
 * carries the width), and even the author's spacing are all preserved, because
 * only the target's own characters are touched.
 *
 * `newLinkRaw(link, link.target) === link.raw` for every link, by construction.
 */
export function newLinkRaw(link: NoteLink, newTarget: string): string {
  const raw = link.raw;
  const open = raw.indexOf("[[");
  if (open < 0) return raw;
  const inner = raw.slice(open + 2, raw.length - 2);
  // Same split parseWikiTarget uses: alias after the first `|`, subpath after
  // the first `#` on the left of it, target is what's before both.
  const pipe = inner.indexOf("|");
  const left = pipe >= 0 ? inner.slice(0, pipe) : inner;
  const hash = left.indexOf("#");
  const segment = hash >= 0 ? left.slice(0, hash) : left;
  const lead = segment.length - segment.trimStart().length;
  const trail = segment.length - segment.trimEnd().length;
  const start = open + 2 + lead;
  const end = open + 2 + segment.length - trail;
  return `${raw.slice(0, start)}${newTarget}${raw.slice(end)}`;
}

/** A target that would re-parse as something else can't be written at all. */
function isWritableTarget(target: string): boolean {
  return target.length > 0 && !/[[\]|#\n\r]/.test(target);
}

/**
 * The index as it will look after `moves` land: same paths, moved. Built with
 * empty bodies because only the NAME SPACE matters here — this exists so the
 * "will the short form still find the file?" question is answered by the real
 * resolver instead of a second, drifting copy of its rules. (Aliases are lost
 * in the shadow, which is harmless: a filename match always beats an alias, and
 * a short form is only accepted when it wins on filename.)
 */
export function simulateMoves(index: VaultIndex, moves: Move[]): VaultIndex {
  const exact = new Map(moves.map((m) => [m.from, m.to]));
  const remap = (path: string): string => {
    const direct = exact.get(path);
    if (direct !== undefined) return direct;
    for (const { from, to } of moves) {
      if (path.startsWith(`${from}/`)) return to + path.slice(from.length);
    }
    return path;
  };
  return VaultIndex.build(index.paths().map((p) => [remap(p), ""] as [string, string]));
}

/**
 * The target form a link should carry once the file it points at lives at
 * `newPath`, or null when the link should be left alone.
 *
 * Two things are preserved: whether the author wrote a path or a bare name,
 * and whether they wrote the extension. A bare name is only kept when it still
 * resolves — uniquely and unambiguously — to the moved file afterwards;
 * otherwise the link falls back to the full vault-relative path, which always
 * resolves by the exact-path rule.
 *
 * `sourcePath` and `after` are both POST-move: where the linking file will
 * live (the same-folder tie-break depends on it) and the post-move name space.
 */
export function renameTargetFor(
  link: NoteLink,
  sourcePath: string,
  newPath: string,
  after: VaultIndex,
): string | null {
  const written = normalizeTarget(link.target);
  // `[[#Heading]]` names no file — it's an anchor into the current one, and it
  // keeps working wherever that file moves.
  if (!written) return null;

  const keepExtension = stripKnownExtension(written) !== written;
  let candidate = keepExtension ? newPath : stripKnownExtension(newPath);

  if (!written.includes("/")) {
    const base = basenameOf(newPath);
    const shortForm = keepExtension ? base : stripKnownExtension(base);
    const hit = after.resolveLinkInfo(shortForm, sourcePath);
    if (hit.path === newPath && !hit.isAmbiguous) candidate = shortForm;
  }

  if (!isWritableTarget(candidate) || candidate === written) return null;
  return candidate;
}

/**
 * Every edit `moves` implies, grouped per file. Sources are the files that
 * link at a moved file — including a moved file linking at itself, which
 * arrives through the same backlink list.
 *
 * Only links that actually RESOLVE to a moved file are touched; a link whose
 * text merely looks similar is somebody else's link.
 */
export function planMoveRewrites(index: VaultIndex, moves: Move[]): FileRewrite[] {
  const real = moves.filter((m) => m.from !== m.to && index.note(m.from));
  const inbound = real.map((m) => ({ ...m, links: index.backlinks(m.from) }));
  // Nothing points at any of these files: the common case, and worth exiting
  // before building the two shadow indexes below.
  if (!inbound.some((m) => m.links.length)) return [];

  const after = simulateMoves(index, real);
  // The same name space WITHOUT the moves, and — like every shadow here —
  // without aliases: it answers "did this link find the file by its name?"
  const before = simulateMoves(index, []);
  const movedTo = new Map(real.map((m) => [m.from, m.to]));
  const bySource = new Map<string, Map<string, SpanEdit>>();

  for (const { from, to, links } of inbound) {
    for (const { source, link } of links) {
      // A link that reaches the note through one of its ALIASES is not ours:
      // the alias lives in the note's own frontmatter and travels with it, so
      // the link still works, and rewriting it would throw away the wording
      // the author chose.
      if (before.resolveLink(link.target, source) !== from) continue;
      // A source that is itself moving is written at its new path: by the time
      // the plan is applied the file already lives there.
      const sourceAfter = movedTo.get(source) ?? source;
      const newTarget = renameTargetFor(link, sourceAfter, to, after);
      if (newTarget === null) continue;
      const newRaw = newLinkRaw(link, newTarget);
      if (newRaw === link.raw) continue;
      let edits = bySource.get(sourceAfter);
      if (!edits) bySource.set(sourceAfter, (edits = new Map()));
      edits.set(`${link.line}:${link.col}`, {
        line: link.line,
        col: link.col,
        raw: link.raw,
        newRaw,
      });
    }
  }

  return [...bySource.entries()]
    .map(([source, edits]) => ({
      source,
      edits: [...edits.values()].sort((a, b) => a.line - b.line || a.col - b.col),
    }))
    .sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
}

/** One file's move. */
export function planLinkRewrites(index: VaultIndex, oldPath: string, newPath: string): FileRewrite[] {
  return planMoveRewrites(index, [{ from: oldPath, to: newPath }]);
}

/** A folder's move: the union of its files' plans, merged per source file. */
export function planFolderRewrites(index: VaultIndex, moves: Move[]): FileRewrite[] {
  return planMoveRewrites(index, moves);
}
