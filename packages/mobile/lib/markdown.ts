// Markdown parsing for the native renderer (components/MarkdownRenderer).
//
// Web renders message bodies with react-markdown + remark-gfm, which is
// micromark underneath. Mobile parses with the same micromark core and the GFM
// pieces a message body uses (tables, strikethrough, task lists), so a body has
// one structure on both: nested lists, multi-line items, quotes holding lists,
// `~~~` fences, escaped pipes in tables. Bare URLs, entity ids and mentions are
// left as text: the renderer's reference scanner turns those into links and
// pills the way mobile always has. Pure JS, so an OTA update can ship it.

import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmTable } from 'micromark-extension-gfm-table';
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough';
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import { gfmStrikethroughFromMarkdown } from 'mdast-util-gfm-strikethrough';
import { gfmTaskListItemFromMarkdown } from 'mdast-util-gfm-task-list-item';
import type { Root, Nodes, Table } from 'mdast';

export type { Root, Nodes, Table };

const extensions = [gfmTable(), gfmStrikethrough(), gfmTaskListItem()];
const mdastExtensions = [gfmTableFromMarkdown(), gfmStrikethroughFromMarkdown(), gfmTaskListItemFromMarkdown()];

// A virtualized transcript remounts rows as they scroll back into view; the
// cache keeps a remount from parsing the same body again.
const CACHE_LIMIT = 400;
const cache = new Map<string, Root>();

export function parseMarkdown(text: string): Root {
  const hit = cache.get(text);
  if (hit) return hit;
  const tree = fromMarkdown(text, { extensions, mdastExtensions });
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(text, tree);
  return tree;
}

/** The plain text of a node, the way it reads (markers dropped). */
export function plainText(node: Nodes): string {
  if ('value' in node && typeof node.value === 'string') return node.type === 'html' ? '' : node.value;
  if (node.type === 'image') return node.alt ?? '';
  if ('children' in node) return (node.children as Nodes[]).map(plainText).join('');
  return '';
}

// ── Table layout ─────────────────────────────────────────────────────────────
//
// A phone is too narrow for most tables an agent writes. The layout is chosen
// from the table's text and the width it gets, in monospace character cells
// (the app sets JetBrains Mono everywhere, so a character's width is known):
//
// - grid:  every column fits at its natural width, so the table reads as a
//          table, stretched to the full width;
// - wrap:  up to three columns, each wide enough for its longest word, so cells
//          wrap inside a table that still fits the width;
// - scroll: a data table (short cells, many columns) keeps its grid and
//          scrolls sideways, because a column of numbers reads down;
// - cards: anything else (several columns of prose) becomes one card per row,
//          the first cell as its title and each other cell under its header.

export type TableLayout =
  | { kind: 'grid'; widths: number[]; scroll: boolean; wraps: boolean }
  | { kind: 'cards' };

const MIN_COLUMN_CHARS = 8;
const SHORT_CELL_CHARS = 24;

export function planTable(rows: string[][], availWidth: number, charWidth: number, cellPadX: number): TableLayout {
  const cols = Math.max(0, ...rows.map((r) => r.length));
  if (cols === 0) return { kind: 'cards' };
  // One character of slack per column: text sized to the exact advance of
  // its glyphs still wraps on iOS, which breaks "120ms" into "120m" / "s".
  const pad = (2 * cellPadX) / charWidth + 1;
  const avail = availWidth / charWidth;
  const natural: number[] = [];
  const longestWord: number[] = [];
  for (let c = 0; c < cols; c++) {
    let n = 1;
    let w = 1;
    for (const r of rows) {
      const cell = r[c] ?? '';
      n = Math.max(n, cell.length);
      for (const word of cell.split(/\s+/)) w = Math.max(w, word.length);
    }
    natural.push(n);
    longestWord.push(w);
  }
  const toWidths = (chars: number[], fill: boolean) => {
    const px = chars.map((c) => (c + pad) * charWidth);
    const total = px.reduce((a, b) => a + b, 0);
    if (!fill || total >= availWidth) return px.map(Math.ceil);
    const extra = availWidth - total;
    const weight = chars.reduce((a, b) => a + b, 0);
    return px.map((p, i) => Math.floor(p + (extra * chars[i]) / weight));
  };

  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  if (sum(natural) + cols * pad <= avail) return { kind: 'grid', widths: toWidths(natural, true), scroll: false, wraps: false };

  const min = natural.map((n, c) => Math.max(longestWord[c], Math.min(n, MIN_COLUMN_CHARS)));
  if (cols <= 3 && sum(min) + cols * pad <= avail) {
    // Each column starts at its minimum; the rest of the width goes to the
    // columns in proportion to how much more they would take.
    const spare = avail - cols * pad - sum(min);
    const want = natural.map((n, c) => n - min[c]);
    const wantTotal = sum(want) || 1;
    const chars = min.map((m, c) => m + (spare * want[c]) / wantTotal);
    return { kind: 'grid', widths: toWidths(chars, false), scroll: false, wraps: true };
  }

  const body = rows.slice(1);
  if (body.every((r) => r.every((cell) => cell.length <= SHORT_CELL_CHARS))) {
    const chars = natural.map((n, c) => Math.max(longestWord[c], Math.min(n, SHORT_CELL_CHARS)));
    return { kind: 'grid', widths: toWidths(chars, false), scroll: true, wraps: false };
  }
  return { kind: 'cards' };
}
