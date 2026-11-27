import { describe, expect, test } from 'bun:test';
import type { PendingComment } from '@codecast/web/lib/quoteFormat';
import { clearWords, trayHeadline, trayRows, traySig } from './notesTray';

const base = { messageId: 'm1', blockIndex: 0, quote: '', body: '', createdAt: 0 };
const pin = (id: string, src: string, body = '', extra: Partial<PendingComment> = {}): PendingComment =>
  ({ ...base, id, body, image: { src, point: { x: 0.5, y: 0.5 } }, ...extra });
const answer = (id: string): PendingComment => ({
  ...base, id, messageId: '', quote: 'Hire a CMO',
  proposal: { id: 'p', short_id: 'op-1', title: 'Staffing', card: 'c', change_ids: ['x'], seqs: [1], verdict: 'approve' },
});

describe('trayRows', () => {
  test('empty batch has no rows and no signature', () => {
    expect(trayRows(undefined)).toEqual([]);
    expect(traySig([])).toBe('');
    expect(trayHeadline([])).toBeNull();
  });

  test('numbers each picture its own way, matching pinNumbers', () => {
    const rows = trayRows([pin('a', 'one.png', 'left'), pin('b', 'two.png'), pin('c', 'one.png', ' right  ')]);
    expect(rows.map((r) => [r.id, r.number, r.note])).toEqual([['a', 1, 'left'], ['b', 1, ''], ['c', 2, 'right']]);
    expect(rows[0]).toMatchObject({ src: 'one.png', quote: '' });
  });

  test('leaves proposal answers to their card', () => {
    const rows = trayRows([answer('x'), pin('a', 'one.png')]);
    expect(rows.map((r) => r.id)).toEqual(['a']);
    expect(traySig([answer('x')])).toBe('');
  });

  test('a text quote reads on one line, with no picture or number', () => {
    const [row] = trayRows([{ ...base, id: 'q', quote: 'line one\n\n  line two', body: 'why?' }]);
    expect(row).toEqual({ id: 'q', quote: 'line one line two', note: 'why?' });
  });

  test('rows follow the send order (sortPendingComments), numbers the batch order', () => {
    const rows = trayRows([
      pin('late', 'one.png', '', { messageId: 'm2', createdAt: 5 }),
      pin('early', 'one.png', '', { messageId: 'm1', createdAt: 9 }),
      pin('first', 'two.png', '', { messageId: 'm2', blockIndex: 0, createdAt: 1 }),
    ]);
    // m2 was seen first (createdAt 5), so its two rows lead, ordered by time.
    expect(rows.map((r) => [r.id, r.number])).toEqual([['first', 1], ['late', 1], ['early', 2]]);
  });

  test('the signature changes with what the tray draws, not with fields it ignores', () => {
    const a = [pin('a', 'one.png', 'x')];
    expect(traySig(a)).toBe(traySig([{ ...a[0], createdAt: 0, verdictAt: 7 }]));
    expect(traySig(a)).not.toBe(traySig([pin('a', 'one.png', 'y')]));
  });
});

describe('words', () => {
  test('head matches the gallery header', () => {
    expect(trayHeadline(trayRows([pin('a', 'one.png')]))).toBe('1 note on your next message');
    expect(trayHeadline(trayRows([pin('a', 'one.png'), pin('b', 'one.png')]))).toBe('2 notes on your next message');
  });
  test('Clear arms before it discards', () => {
    expect(clearWords(3, false)).toBe('Clear');
    expect(clearWords(3, true)).toBe('Discard 3?');
  });
});
