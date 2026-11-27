import { describe, expect, test } from 'bun:test';
import { pinNumbers, type PendingComment } from '@codecast/web/lib/quoteFormat';
import { fittedRect, galleryPins, notesHeadline, onImageNoteOpen, openImageNote, pinToMove, pinsOn, resolveTap, samePicture } from './imagePins';

const page = { width: 400, height: 800 };
// A 2:1 picture fits 400×200, centred: top edge at y=300.
const natural = { width: 1600, height: 800 };
const flat = { scale: 1, tx: 0, ty: 0 };

function pin(id: string, src: string, point: { x: number; y: number }, extra: Partial<PendingComment['image']> = {}, body = ''): PendingComment {
  return { id, messageId: '', blockIndex: 0, quote: '', body, createdAt: 0, image: { src, point, ...extra } };
}

describe('fittedRect', () => {
  test('centres a contain-fitted picture', () => {
    expect(fittedRect(natural, page)).toEqual({ width: 400, height: 200, left: 0, top: 300 });
    expect(fittedRect({ width: 100, height: 400 }, page)).toEqual({ width: 200, height: 800, left: 100, top: 0 });
  });
});

describe('resolveTap', () => {
  test('an unzoomed tap on the picture pins there, as fractions of the picture', () => {
    expect(resolveTap({ tap: { x: 100, y: 350 }, page, natural, view: flat, pins: [], canAdd: true }))
      .toEqual({ kind: 'add', point: { x: 0.25, y: 0.25 } });
  });

  test('a tap in the letterbox toggles the chrome', () => {
    expect(resolveTap({ tap: { x: 100, y: 100 }, page, natural, view: flat, pins: [], canAdd: true })).toEqual({ kind: 'chrome' });
    expect(resolveTap({ tap: { x: 100, y: 520 }, page, natural, view: flat, pins: [], canAdd: true })).toEqual({ kind: 'chrome' });
  });

  test('without notes, or before the picture has a size, every tap is the chrome', () => {
    expect(resolveTap({ tap: { x: 100, y: 350 }, page, natural, view: flat, pins: [], canAdd: false })).toEqual({ kind: 'chrome' });
    expect(resolveTap({ tap: { x: 100, y: 350 }, page, natural: null, view: flat, pins: [], canAdd: true })).toEqual({ kind: 'chrome' });
  });

  test('a zoomed tap on the picture does not pin', () => {
    expect(resolveTap({ tap: { x: 200, y: 400 }, page, natural, view: { scale: 2, tx: 0, ty: 0 }, pins: [], canAdd: true })).toEqual({ kind: 'chrome' });
  });

  test('a tap within 22px of a pin opens it, at any zoom', () => {
    const pins = galleryPins([pin('a', 's', { x: 0.5, y: 0.5 })], false);
    // Unzoomed the pin sits at the page centre (200, 400).
    expect(resolveTap({ tap: { x: 215, y: 410 }, page, natural, view: flat, pins, canAdd: true })).toEqual({ kind: 'pin', id: 'a' });
    expect(resolveTap({ tap: { x: 225, y: 400 }, page, natural, view: flat, pins, canAdd: true }).kind).toBe('add');
    // Zoomed 2× and panned 50px right, x=0.6 (page x 240) draws at 200 + 40*2 + 50 = 330.
    const zoomed = galleryPins([pin('b', 's', { x: 0.6, y: 0.5 })], false);
    expect(resolveTap({ tap: { x: 330, y: 400 }, page, natural, view: { scale: 2, tx: 50, ty: 0 }, pins: zoomed, canAdd: true })).toEqual({ kind: 'pin', id: 'b' });
  });

  test('the nearest of two overlapping pins wins', () => {
    const pins = galleryPins([pin('a', 's', { x: 0.5, y: 0.5 }), pin('b', 's', { x: 0.52, y: 0.5 })], false);
    expect(resolveTap({ tap: { x: 209, y: 400 }, page, natural, view: flat, pins, canAdd: true })).toEqual({ kind: 'pin', id: 'b' });
  });
});

describe('galleryPins', () => {
  const batch: PendingComment[] = [
    pin('t1', 'https://x/1.png', { x: 0.1, y: 0.1 }, { storageId: 'st1' }),
    { id: 'q', messageId: 'm', blockIndex: 0, quote: 'a paragraph', body: '', createdAt: 0 },
    pin('c1', 'file:///a.jpg', { x: 0.2, y: 0.2 }, { attached: true }),
    pin('t2', 'https://x/1.png', { x: 0.3, y: 0.3 }, { storageId: 'st1' }, 'second'),
    pin('t3', 'https://x/2.png', { x: 0.4, y: 0.4 }),
  ];

  test('numbers match pinNumbers, per picture', () => {
    const numbers = pinNumbers(batch);
    const pins = galleryPins(batch, false);
    expect(pins.map((p) => [p.id, p.number])).toEqual([['t1', 1], ['t2', 2], ['t3', 1]]);
    for (const p of pins) expect(p.number).toBe(numbers.get(p.id)!);
  });

  test('splits the transcript pictures from the composer’s own', () => {
    expect(galleryPins(batch, true).map((p) => p.id)).toEqual(['c1']);
  });

  test('a picture holds its pins by stored bytes or by address', () => {
    const pins = galleryPins(batch, false);
    expect(pinsOn(pins, { src: 'https://other/url', storageId: 'st1' }).map((p) => p.id)).toEqual(['t1', 't2']);
    expect(pinsOn(pins, { src: 'https://x/2.png' }).map((p) => p.id)).toEqual(['t3']);
    // A composer picture pinned before its upload landed, matched once it has a storage id.
    expect(samePicture({ src: 'file:///a.jpg' }, { src: 'file:///a.jpg', storageId: 'new' })).toBe(true);
    expect(samePicture({ src: '' }, { src: '' })).toBe(false);
  });
});

describe('pinToMove', () => {
  const batch = [pin('a', 's', { x: 0.1, y: 0.1 }), pin('b', 's', { x: 0.2, y: 0.2 }, {}, 'written')];
  test('only the open, unwritten pin on this picture moves', () => {
    expect(pinToMove(batch, 'a', { src: 's' })).toBe('a');
    expect(pinToMove(batch, 'b', { src: 's' })).toBeNull();
    expect(pinToMove(batch, 'a', { src: 'other' })).toBeNull();
    expect(pinToMove(batch, null, { src: 's' })).toBeNull();
  });
});

test('notesHeadline', () => {
  expect(notesHeadline(0)).toBeNull();
  expect(notesHeadline(1)).toBe('1 note on your next message');
  expect(notesHeadline(3)).toBe('3 notes on your next message');
});

test('openImageNote asks each gallery of the conversation until one opens it', () => {
  const seen: string[] = [];
  const offA = onImageNoteOpen('c', (id) => { seen.push(`a:${id}`); return false; });
  const offB = onImageNoteOpen('c', (id) => { seen.push(`b:${id}`); return id === 'p1'; });
  expect(openImageNote('c', 'p1')).toBe(true);
  expect(openImageNote('other', 'p1')).toBe(false);
  offB();
  expect(openImageNote('c', 'p1')).toBe(false);
  offA();
  expect(seen).toEqual(['a:p1', 'b:p1', 'a:p1']);
});
