import { describe, expect, test } from 'bun:test';
import { needsInputGlance } from './needsInputGlance';

const row = (id: string, extra: Record<string, unknown> = {}) => ({ _id: id, title: `t${id}`, ...extra });

describe('needsInputGlance', () => {
  test('counts other sessions only, and skips deferred rows', () => {
    const needs = needsInputGlance({ needsInput: [row('a'), row('me'), row('b', { is_deferred: true })] }, 'me');
    expect(needs.map((n) => n.id)).toEqual(['a']);
  });
  test('an open decision waits on you too, counted once', () => {
    const needs = needsInputGlance({ questions: [row('q'), row('a')], needsInput: [row('a')] }, 'x');
    expect(needs.map((n) => n.id)).toEqual(['q', 'a']);
  });
  test('an untitled session still has a name for the screen reader', () => {
    expect(needsInputGlance({ needsInput: [row('a', { title: '  ' })] }, 'x')[0].title).toBe('Untitled session');
  });
});
