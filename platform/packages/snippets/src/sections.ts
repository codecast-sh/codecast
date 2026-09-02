// The section engine: recognize the blocks an installer owns inside a markdown
// instruction file, rewrite them in place, remove them, and leave every other
// byte alone. Pure functions over strings; the filesystem lives in install.ts.

import type { SectionSpec, SnippetInstallResult } from "./types";

/** A `## ` heading at the start of a line: the boundary between top-level
 *  sections. Snippet bodies only ever go as deep as `### `, so this never
 *  matches inside one of our own blocks. */
const NEXT_SECTION = /\n## /;

export interface OwnedBlock {
  start: number;
  end: number;
}

/**
 * Every owned block matching `spec`, as [start, end) offsets.
 *
 * The rule that makes this correct: a block is OURS only when its end marker
 * appears after its heading AND before the next `## ` heading. Detection and
 * removal therefore share one window. The per-snippet copies this replaced
 * tested `text.includes(endMarker)` across the whole file but cut with
 * `indexOf(endMarker, start)`, so a marker sitting anywhere ABOVE the heading
 * left the cut running to end of file and deleted every later section, user
 * content included.
 *
 * A heading whose block carries no marker is left alone unless a content probe
 * matches, so a user's own `## Tasks & Plans` survives while the real block
 * further down is the one replaced.
 */
export function findOwnedSections(text: string, spec: SectionSpec): OwnedBlock[] {
  const found: OwnedBlock[] = [];

  for (const heading of spec.headings) {
    let from = 0;
    for (;;) {
      const start = text.indexOf(heading, from);
      if (start === -1) break;
      from = start + heading.length;

      // Must be a real heading: at file start or immediately after a newline.
      if (start !== 0 && text[start - 1] !== "\n") continue;

      const bodyFrom = start + heading.length;
      const rel = text.slice(bodyFrom).search(NEXT_SECTION);
      // Keep the newline with the block we cut, so the next heading lands
      // exactly where this block began.
      const nextSection = rel === -1 ? text.length : bodyFrom + rel + 1;

      const markerIdx = text.indexOf(spec.endMarker, bodyFrom);
      const owned = markerIdx !== -1 && markerIdx < nextSection;

      let end: number;
      if (owned) {
        end = markerIdx + spec.endMarker.length;
        // Take the blank lines that separated this block from what follows.
        // The separator is ours to re-emit: an update writes exactly one blank
        // line back when something follows the block, so a run over a file we
        // already wrote reproduces it byte for byte. Leaving the old separator
        // in place instead would stack a second blank line on every refresh.
        while (text[end] === "\n") end++;
      } else if (spec.contentProbes?.some((p) => text.slice(start, nextSection).includes(p))) {
        // A block written before end markers existed: bounded by the next
        // heading, never by EOF.
        end = nextSection;
      } else {
        continue; // Someone else's section that happens to share our heading.
      }

      found.push({ start, end });
    }
  }

  // Outermost first so callers can cut back to front without shifting offsets,
  // and drop any block nested inside another.
  found.sort((a, b) => a.start - b.start);
  return found.filter((b, i) => i === 0 || b.start >= found[i - 1].end);
}

/**
 * Rewrite the blocks we own in one pass: the first becomes `body`, the rest go
 * away. `body: null` removes them all; that is uninstall.
 *
 * Back to front, so the offsets `findOwnedSections` measured on the original
 * text still address the same bytes when we reach them.
 *
 * Collapsing to the FIRST block, rather than the last, is what makes an update
 * idempotent: our section lands where our section already was, so running the
 * writer again finds one block in that same place and reproduces the same file.
 */
function replaceOwnedBlocks(text: string, blocks: OwnedBlock[], body: string | null): string {
  let out = text;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const after = out.slice(blocks[i].end);
    // The block's end swallowed whatever blank lines separated it from the next
    // section, so re-emit exactly one, and none at end of file.
    const insert = body !== null && i === 0 ? (after === "" ? body : body + "\n") : "";
    let head = out.slice(0, blocks[i].start);
    // A block's window covers the blank lines BELOW it, never the one above.
    // Remove a block that ended the file and that blank line is orphaned: the
    // file ends "last line\n\n", and re-enabling the snippet then appends onto
    // two newlines instead of one, so a disable/enable cycle grows the file by
    // a line every time. Nothing follows it to separate, so end the file after
    // its last real line.
    if (insert === "" && after === "") head = head.replace(/\n+$/, "\n");
    out = head + insert + after;
  }
  return out;
}

/** Remove every block we own, leaving everything else byte-identical. */
export function cutOwnedSections(text: string, spec: SectionSpec): string {
  return replaceOwnedBlocks(text, findOwnedSections(text, spec), null);
}

/**
 * A snippet as a standalone block: no leading blank line (the text above the
 * block already ends in one, or the block starts the file) and exactly one
 * trailing newline. Bodies are template literals padded with a newline at each
 * end, which is what the append path wants and the in-place path does not.
 */
export function sectionBody(snippet: string): string {
  return snippet.replace(/^\n+/, "").replace(/\n+$/, "") + "\n";
}

/**
 * The single install algorithm behind every snippet: skip when present and not
 * updating, append when absent, otherwise refresh what we own IN PLACE.
 *
 * In place matters. Cutting the block and re-appending it at the end walked
 * the installer's sections downward past the user's own content a little
 * further on every update, quietly reordering a file they wrote. Duplicate
 * blocks left by an older writer collapse into the first one's position.
 *
 * `unchanged` reports that the result is byte-identical to `existing`, so a
 * caller can skip a pointless write.
 */
export function applySnippet(
  existing: string,
  spec: SectionSpec,
  snippet: string,
  update: boolean,
): SnippetInstallResult & { text: string } {
  const blocks = findOwnedSections(existing, spec);
  const has = blocks.length > 0;
  if (has && !update) return { text: existing, installed: false, updated: false, unchanged: true };
  const text = has ? replaceOwnedBlocks(existing, blocks, sectionBody(snippet)) : existing + snippet;
  return { text, installed: true, updated: has, unchanged: text === existing };
}
