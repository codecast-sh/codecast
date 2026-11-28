import { describe, expect, it } from 'bun:test';
import type { PendingComment } from '@codecast/web/lib/quoteFormat';
import { commentLabel, excerpt, messageUnits, placeComments, quotedSpans, quotesWholeUnit } from './messageComments';
import { parseMarkdown } from './markdown';

const c = (id: string, quote: string, blockIndex = 0, over: Partial<PendingComment> = {}): PendingComment => ({
  id, messageId: 'm', blockIndex, quote, body: '', createdAt: Number(id.replace(/\D/g, '')) || 0, ...over,
});

const UNITS = [
  'I answered the session redesigning the priorities page.',
  'Stages: use five, not the walkthrough\'s seven: Asked, Proving, Approving, Shipping, Landed.',
  'Where the record lives: in Union, with codecast only mirroring it.',
];

describe('messageUnits', () => {
  it('makes each block a unit and each list item its own', () => {
    const units = messageUnits(parseMarkdown('Intro **bold** words.\n\n1. **Stages:** five\n2. Record\n\n## Name\n\n```ts\nconst x = 1\n```'), 3);
    expect(units).toEqual([
      { index: 3, text: 'Intro bold words.', kind: 'paragraph' },
      { index: 4, text: 'Stages: five', kind: 'item' },
      { index: 5, text: 'Record', kind: 'item' },
      { index: 6, text: 'Name', kind: 'heading' },
      { index: 7, text: 'const x = 1', kind: 'code' },
    ]);
  });
});

describe('placeComments', () => {
  it('draws a whole-unit comment under its unit', () => {
    const placed = placeComments([c('a1', UNITS[1], 1)], UNITS);
    expect([...placed.keys()]).toEqual([1]);
  });

  it('finds the unit that holds a selection by its words, whatever index it was saved with', () => {
    const placed = placeComments([c('a1', 'in Union, with codecast only mirroring', 0)], UNITS);
    expect(placed.get(2)?.map((x) => x.id)).toEqual(['a1']);
  });

  it('keeps several comments on one unit in the order they were made', () => {
    const placed = placeComments([c('a2', 'use five', 1), c('a1', UNITS[1], 1)], UNITS);
    expect(placed.get(1)?.map((x) => x.id)).toEqual(['a1', 'a2']);
  });

  it('leaves pictures, page notes and proposal answers to their own surfaces', () => {
    const placed = placeComments([
      c('a1', 'x', 0, { image: { src: 's', point: { x: 0.1, y: 0.1 } } }),
      c('a2', 'x', 0, { page: { slug: 'p' } }),
    ], UNITS);
    expect(placed.size).toBe(0);
  });

  it('leaves out a comment whose words the message no longer holds', () => {
    expect(placeComments([c('a1', 'a sentence that was never in this message at all', 2)], UNITS).size).toBe(0);
  });

  it('draws nothing for a message with no units', () => {
    expect(placeComments([c('a1', 'x')], []).size).toBe(0);
  });
});

describe('quotedSpans', () => {
  it('marks a quote inside one run', () => {
    const text = 'use five, not the walkthrough\'s seven: Asked';
    expect(quotedSpans(text, ['not the walkthrough\'s seven'])).toEqual([[10, 37]]);
  });

  it('marks the parts of a quote split across runs', () => {
    const quote = 'Stages: use five, not the walkthrough';
    expect(quotedSpans('Stages:', [quote])).toEqual([[0, 7]]); // the bold opening of the quote
    expect(quotedSpans(' use five, not the walkthrough\'s seven', [quote])).toEqual([[0, 30]]);
    expect(quotedSpans('the record says Stages: use', [quote])).toEqual([[16, 27]]);
  });

  it('marks a quote across a soft line break in the message', () => {
    const text = 'retry with backoff, and a\ndelivery stops';
    expect(quotedSpans(text, ['and a delivery stops'])).toEqual([[20, 40]]);
  });

  it('ignores a short word that happens to be in the quote', () => {
    expect(quotedSpans('the', ['the record lives'])).toEqual([]);
  });

  it('merges overlapping spans', () => {
    expect(quotedSpans('abcdefghijkl', ['abcdefgh', 'efghijkl'])).toEqual([[0, 12]]);
  });
});

describe('words', () => {
  it('names the unit in the menu', () => {
    expect(commentLabel('item')).toBe('Comment on this point');
    expect(commentLabel('paragraph')).toBe('Comment on this paragraph');
  });

  it('knows a whole-unit quote through whitespace', () => {
    expect(quotesWholeUnit('a  b\nc', 'a b c')).toBe(true);
    expect(quotesWholeUnit('a b', 'a b c')).toBe(false);
  });

  it('cuts a long quote to one line', () => {
    expect(excerpt('one\ntwo three', 9)).toBe('one two…');
    expect(excerpt('short')).toBe('short');
  });
});
