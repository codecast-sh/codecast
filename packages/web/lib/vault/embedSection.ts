// Section-scoped transclusion: what `![[Note#Heading]]` and `![[Note#^id]]`
// actually put on screen.
//
// The whole-note embed is the easy case (strip frontmatter, render the rest).
// A subpath means the card shows ONE slice of the target, and the slice is
// defined by the index the vault already builds: a heading owns the lines from
// its own line down to `endLine` (which the parser closes at the next
// same-or-higher heading, so nested subheadings come along), and a block id
// names the line it sits on — plus, for a list item, the lines indented under
// it.
//
// A subpath that doesn't resolve renders the whole note rather than nothing:
// the reader still gets the note they linked, and the card says the section is
// missing. Silently showing everything as if it were the section is the one
// outcome that misleads.

import { splitFrontmatter } from "./frontmatter";
import { parseNote, slugifyHeading, type NoteBlock, type NoteHeading, type ParsedNote } from "./parseNote";

export interface EmbedSection {
  /** Markdown ready to render — frontmatter already stripped. */
  content: string;
  kind: "note" | "heading" | "block";
  /** A subpath was asked for and not found; `content` is the whole note. */
  missing: boolean;
}

/** Just the parts of a parsed note this module reads. Passing the index's
 *  existing parse avoids a second one; omit it and the content is parsed here. */
export type SectionSource = Pick<ParsedNote, "headings" | "blocks">;

const BARE_BLOCK_ID_RE = /^\s*\^[A-Za-z0-9-]+\s*$/;
const LIST_ITEM_RE = /^(\s*)(?:[-*+]|\d+[.)])\s/;

const splitLines = (content: string): string[] => content.split(/\r\n|\r|\n/);

/** Drop blank lines at both ends; embeds sit inside a card that supplies its
 *  own padding, so leading and trailing air reads as a rendering bug. */
function trimBlankEdges(lines: string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  return lines.slice(start, end).join("\n");
}

/** Walk a `#`-separated heading path (`Parent#Child`), each segment resolved
 *  inside the previous one's span. Matches heading text, or its slug so a link
 *  written in fragment form still lands. First occurrence wins, as in Obsidian. */
function findHeading(headings: NoteHeading[], subpath: string): NoteHeading | null {
  const segments = subpath.split("#").map((s) => s.trim()).filter(Boolean);
  if (!segments.length) return null;
  let from = 1;
  let to = Infinity;
  let found: NoteHeading | null = null;
  for (const segment of segments) {
    const wanted = segment.toLowerCase();
    const slug = slugifyHeading(segment);
    const hit = headings.find(
      (h) =>
        h.line >= from &&
        h.line <= to &&
        (h.text.toLowerCase() === wanted || (!!slug && h.slug === slug)),
    );
    if (!hit) return null;
    found = hit;
    from = hit.line + 1;
    to = hit.endLine;
  }
  return found;
}

/** The paragraph a bare `^id` line labels: the contiguous non-blank lines above
 *  it. (The parser models the same rule when it attributes the block's text.) */
function paragraphAbove(lines: string[], idLine: number): [number, number] | null {
  let end = idLine - 1; // 1-based line above the id
  while (end >= 1 && !lines[end - 1].trim()) end--;
  if (end < 1) return null;
  let start = end;
  while (start > 1 && lines[start - 2].trim() && !/^\s{0,3}#{1,6}\s/.test(lines[start - 2])) start--;
  return [start, end];
}

/** Visual width of an indent run. A raw character count reads one tab as
 *  shallower than two spaces, so a tab-indented continuation under a
 *  space-indented parent looked like a dedent and its lines were dropped
 *  (review finding, R12). Four columns per tab matches CommonMark's list
 *  handling and Obsidian's default.
 */
const TAB_WIDTH = 4;
function indentWidth(run: string): number {
  let width = 0;
  for (const ch of run) width += ch === "\t" ? TAB_WIDTH - (width % TAB_WIDTH) : 1;
  return width;
}

/** A list item owns everything indented under it — continuation text and
 *  nested items — so an embedded checklist item doesn't lose its children. */
function listItemSpan(lines: string[], line: number): [number, number] {
  const indent = indentWidth(LIST_ITEM_RE.exec(lines[line - 1])?.[1] ?? "");
  let end = line;
  for (let i = line; i < lines.length; i++) {
    const text = lines[i];
    // Blank lines inside an item are kept only if something indented follows:
    // `end` only advances on a deeper line, and the slice carries the gaps.
    if (!text.trim()) continue;
    const lead = indentWidth(text.slice(0, text.length - text.trimStart().length));
    if (lead <= indent) break;
    end = i + 1;
  }
  return [line, end];
}

function findBlock(blocks: NoteBlock[], id: string): NoteBlock | null {
  const wanted = id.trim().toLowerCase();
  return blocks.find((b) => b.id.toLowerCase() === wanted) ?? null;
}

/**
 * The markdown an embed card should render for `![[Note<subpath>]]`.
 *
 * `content` is the target note's full file text (frontmatter included) — line
 * numbers in the index are file-absolute, so slicing has to happen against the
 * same string the parser saw.
 */
export function extractEmbedSection(
  content: string,
  link: { subpath?: string; subpathType?: "heading" | "block" },
  parsed?: SectionSource | null,
): EmbedSection {
  const wholeNote = (missing: boolean): EmbedSection => ({
    content: trimBlankEdges(splitLines(splitFrontmatter(content)[1])),
    kind: "note",
    missing,
  });

  const subpath = link.subpath?.trim();
  if (!subpath) return wholeNote(false);

  const source = parsed ?? parseNote(content);
  const lines = splitLines(content);

  if (link.subpathType === "block") {
    const block = findBlock(source.blocks, subpath);
    if (!block) return wholeNote(true);
    const [start, end] = BARE_BLOCK_ID_RE.test(lines[block.line - 1] ?? "")
      ? (paragraphAbove(lines, block.line) ?? [block.line, block.line])
      : LIST_ITEM_RE.test(lines[block.line - 1] ?? "")
        ? listItemSpan(lines, block.line)
        : [block.line, block.line];
    return { content: trimBlankEdges(lines.slice(start - 1, end)), kind: "block", missing: false };
  }

  const heading = findHeading(source.headings, subpath);
  if (!heading) return wholeNote(true);
  return {
    content: trimBlankEdges(lines.slice(heading.line - 1, heading.endLine)),
    kind: "heading",
    missing: false,
  };
}
