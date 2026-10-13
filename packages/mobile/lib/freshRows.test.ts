import { describe, expect, test } from 'bun:test';
import { FreshRows } from './freshRows';

describe('FreshRows', () => {
  test('the first load and anything already shown never animate', () => {
    const rows = new FreshRows();
    rows.update([], 0);
    rows.update(['a', 'b'], 10);
    expect(rows.isFresh('a', 10)).toBe(false);
    expect(rows.isFresh('b', 10)).toBe(false);
  });

  test('a row landing at the newest end is fresh for a moment', () => {
    const rows = new FreshRows();
    rows.update(['a', 'b'], 0);
    rows.update(['a', 'b', 'c'], 100);
    expect(rows.isFresh('c', 150)).toBe(true);
    expect(rows.isFresh('c', 100 + 5000)).toBe(false);
    // Rendering the same list again changes nothing.
    rows.update(['a', 'b', 'c'], 200);
    expect(rows.isFresh('c', 250)).toBe(true);
  });

  test('an older page and a catch-up burst stay still', () => {
    const rows = new FreshRows();
    rows.update(['c', 'd'], 0);
    rows.update(['a', 'b', 'c', 'd'], 10);
    expect(rows.isFresh('a', 10)).toBe(false);
    rows.update(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 20);
    expect(rows.isFresh('h', 20)).toBe(false);
  });
});
