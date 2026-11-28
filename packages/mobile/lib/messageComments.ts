// Comments on a message, on the phone: the rules for where each one draws and
// what of its quote shows. A comment is an item of the conversation's quote
// batch (store reviewComments, lib/reviewActions on the web), so it rides the
// next send as a blockquote with the person's words under it.
//
// A message's "units" are what a long press comments on: each top-level block,
// except a list, which is one unit per item (the web's quote units, the same
// split). A comment made from a selection quotes part of a unit; it draws under
// the unit that holds its words, found by text so it survives a re-render.
//
// Pure: no React Native, so it is tested directly.

import type { Nodes, Root } from 'mdast';
import { resolveProseAnchor } from '@codecast/shared/comments';
import type { PendingComment } from '@codecast/web/lib/quoteFormat';
import { plainText } from './markdown';

export type UnitKind = 'paragraph' | 'item' | 'heading' | 'code' | 'table' | 'quote' | 'block';

/** One unit a press can comment on: its place in the message and its words. */
export type CommentUnit = { index: number; text: string; kind: UnitKind };

const UNIT_NAMES: Record<UnitKind, string> = {
  paragraph: 'paragraph',
  item: 'point',
  heading: 'heading',
  code: 'code block',
  table: 'table',
  quote: 'quote',
  block: 'block',
};

/** The menu row that starts a comment on this unit. */
export function commentLabel(kind: UnitKind): string {
  return `Comment on this ${UNIT_NAMES[kind]}`;
}

const KIND: Partial<Record<Nodes['type'], UnitKind>> = {
  paragraph: 'paragraph',
  heading: 'heading',
  code: 'code',
  table: 'table',
  blockquote: 'quote',
};

/** A block's words the way they read: block children on their own lines. */
export function unitText(node: Nodes): string {
  if (node.type === 'table') return node.children.map((row) => row.children.map(plainText).join(' | ')).join('\n');
  if (node.type === 'listItem' || node.type === 'blockquote' || node.type === 'list') {
    return (node.children as Nodes[]).map(unitText).join('\n');
  }
  return plainText(node);
}

/** The units of a parsed message body, numbered from `base`, in the order they draw. */
export function messageUnits(tree: Root, base = 0): CommentUnit[] {
  const units: CommentUnit[] = [];
  for (const node of tree.children as Nodes[]) {
    if (node.type === 'list') {
      for (const item of node.children) units.push({ index: base + units.length, text: unitText(item), kind: 'item' });
    } else {
      units.push({ index: base + units.length, text: unitText(node), kind: KIND[node.type] ?? 'block' });
    }
  }
  return units;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Each text comment's unit, by its quote's words; the stored index breaks ties. */
export function placeComments(comments: readonly PendingComment[], unitTexts: readonly string[]): Map<number, PendingComment[]> {
  const out = new Map<number, PendingComment[]>();
  if (!unitTexts.length) return out;
  for (const c of comments) {
    if (c.image || c.page || c.proposal) continue;
    // Words no unit holds (a message cut short, its text since changed) are
    // not drawn in place; the tray above the composer still lists them.
    const placed = resolveProseAnchor({ text: c.quote, index: c.blockIndex }, unitTexts);
    if (placed.state === 'outdated' || placed.index == null) continue;
    out.set(placed.index, [...(out.get(placed.index) ?? []), c]);
  }
  for (const list of out.values()) list.sort((a, b) => a.createdAt - b.createdAt);
  return out;
}

/** True when the comment quotes its whole unit: the bubble then needs no excerpt. */
export function quotesWholeUnit(quote: string, unitText: string): boolean {
  return squash(quote) === squash(unitText);
}

/** A quote cut to one short line for a bubble or a tray row. */
export function excerpt(quote: string, max = 80): string {
  const one = squash(quote);
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/** `text` with each run of whitespace made one space, and where each kept character came from. */
function collapse(text: string): { run: string; at: number[] } {
  let run = '';
  const at: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ws = /\s/.test(text[i]);
    if (ws && run.endsWith(' ')) continue;
    run += ws ? ' ' : text[i];
    at.push(i);
  }
  return { run, at };
}

const MIN_INSIDE = 8;
const MIN_EDGE = 6;

/**
 * Where the quoted words fall in one run of rendered text, as [start, end)
 * spans. A quote that crosses formatting (bold, a link) is split across runs,
 * so a run counts when the quote holds it whole, when it holds the quote, or
 * when it begins with the quote's end or ends with the quote's start. Short
 * overlaps are ignored: "the" is inside most quotes.
 */
export function quotedSpans(text: string, quotes: readonly string[]): [number, number][] {
  // Matched with whitespace collapsed (a soft line break in the message is a
  // space in the quote), then mapped back to the run's own offsets.
  const { run, at: origin } = collapse(text);
  const runSq = run.trim();
  const back = (s: number, e: number): [number, number] => [origin[s], origin[e - 1] + 1];
  const spans: [number, number][] = [];
  for (const raw of quotes) {
    const q = squash(raw);
    if (!q || !runSq) continue;
    const at = run.indexOf(q);
    if (at >= 0) {
      spans.push(back(at, at + q.length));
      continue;
    }
    if (runSq.length >= MIN_INSIDE && q.includes(runSq)) {
      const lead = run.length - run.trimStart().length;
      spans.push(back(lead, lead + runSq.length));
      continue;
    }
    // The run ends with the quote's start.
    let edge = 0;
    for (let n = Math.min(q.length, run.length); n >= MIN_EDGE; n--) {
      if (run.endsWith(q.slice(0, n))) { edge = n; break; }
    }
    if (edge) {
      spans.push(back(run.length - edge, run.length));
      continue;
    }
    // The run begins with the quote's end.
    for (let n = Math.min(q.length, run.length); n >= MIN_EDGE; n--) {
      if (run.startsWith(q.slice(q.length - n))) { spans.push(back(0, n)); break; }
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([s[0], s[1]]);
  }
  return merged;
}
