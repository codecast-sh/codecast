import { describe, expect, test } from 'bun:test';

import { mapLimit } from './index';

describe('mapLimit', () => {
  test('keeps input order and never runs more than the limit at once', async () => {
    let live = 0;
    let peak = 0;
    const out = await mapLimit([30, 5, 20, 1, 10], 2, async (ms, i) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, ms));
      live--;
      return i * 10;
    });
    expect(out).toEqual([0, 10, 20, 30, 40]);
    expect(peak).toBe(2);
  });

  test('an empty list resolves at once', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });
});
