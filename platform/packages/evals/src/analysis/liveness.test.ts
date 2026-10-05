import { describe, expect, test } from 'bun:test';

import { liveness } from './liveness';

describe('liveness', () => {
  const now = Date.parse('2026-10-05T12:00:00.000Z');

  test('an event within the stall window is live; one past it is stalled; the boundary is still live', () => {
    expect(liveness('2026-10-05T11:59:30.000Z', now, 60_000)).toBe('live');
    expect(liveness('2026-10-05T11:58:00.000Z', now, 60_000)).toBe('stalled');
    expect(liveness('2026-10-05T11:59:00.000Z', now, 60_000)).toBe('live');
  });

  test('no event time, or one that does not parse, has no liveness to show', () => {
    expect(liveness(null, now, 60_000)).toBeNull();
    expect(liveness(undefined, now, 60_000)).toBeNull();
    expect(liveness('', now, 60_000)).toBeNull();
    expect(liveness('yesterday', now, 60_000)).toBeNull();
  });
});
