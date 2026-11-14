import { describe, expect, test } from 'bun:test';
import { MAX_SEGMENTS, needsInputGlance } from './needsInputGlance';

const row = (id: string, extra: Record<string, unknown> = {}) => ({ _id: id, title: `t${id}`, ...extra });

describe('needsInputGlance', () => {
  test('counts other sessions only, and skips deferred rows', () => {
    const g = needsInputGlance({ needsInput: [row('a'), row('me'), row('b', { is_deferred: true })], working: [row('c'), row('me')] }, 'me');
    expect(g.needs.map((n) => n.id)).toEqual(['a']);
    expect(g.working).toBe(1);
    expect(g.segments).toBe(1);
  });
  test('an open decision waits on you too, counted once', () => {
    const g = needsInputGlance({ questions: [row('q'), row('a')], needsInput: [row('a')], working: [] }, 'x');
    expect(g.needs.map((n) => n.id)).toEqual(['q', 'a']);
  });
  test('caps the segments, never the count', () => {
    const many = Array.from({ length: 9 }, (_, i) => row(String(i)));
    const g = needsInputGlance({ needsInput: many, working: [] }, 'x');
    expect(g.needs.length).toBe(9);
    expect(g.segments).toBe(MAX_SEGMENTS);
  });
  test('an untitled session still has a name for the screen reader', () => {
    expect(needsInputGlance({ needsInput: [row('a', { title: '  ' })], working: [] }, 'x').needs[0].title).toBe('Untitled session');
  });
});
