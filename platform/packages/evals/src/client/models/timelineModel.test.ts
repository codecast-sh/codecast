import { describe, expect, it } from 'bun:test';
import { calibrateOffsetMs, dayIn, laneCounts, onRunClock, orderTimeline, runClockLabel } from './timelineModel';

const FREEZE = Date.parse('2026-08-13T09:00:00.000Z');
const H = 3_600_000;

describe('the run clock', () => {
  it('takes the median residual of the pinned rows, and the fallback when none is pinned', () => {
    // Stored stamps drift later than the truth as the run goes: 60, 61, 90 seconds over a ten-day shift.
    const shift = 10 * 24 * H;
    const pins = [60_000, 61_000, 90_000].map((drift, i) => ({ stored: new Date(FREEZE + i * H + shift + drift).toISOString(), actual: FREEZE + i * H }));
    expect(calibrateOffsetMs(shift, pins)).toBe(shift + 61_000);
    expect(calibrateOffsetMs(shift, [{ stored: FREEZE, actual: null }, { stored: FREEZE, actual: 0 }, { stored: 'not a date', actual: FREEZE }])).toBe(shift);
    expect(calibrateOffsetMs(shift, [])).toBe(shift);
  });

  it('places a row at its true instant when known, else its stored stamp less the offset', () => {
    expect(onRunClock(FREEZE + 5 * H, H, FREEZE)).toBe(FREEZE);
    expect(onRunClock(FREEZE + 5 * H, H)).toBe(FREEZE + 4 * H);
    expect(onRunClock(FREEZE + 5 * H, H, 0)).toBe(FREEZE + 4 * H);
    expect(onRunClock('garbage', H)).toBeNull();
  });

  it('names an instant by its day from the start, and a row before the start as day -1', () => {
    expect(runClockLabel(FREEZE, FREEZE + 3 * 24 * H + 5 * H + 7 * 60_000)).toBe('D+3 05:07');
    expect(runClockLabel(FREEZE, FREEZE - 7 * H)).toBe('D-1 17:00');
    expect(dayIn(FREEZE, FREEZE - 1)).toBe(-1);
    expect(dayIn(new Date(FREEZE).toISOString(), FREEZE + 47 * H)).toBe(1);
  });
});

describe('the story order', () => {
  it('reads a marker before the line it provoked, and anything further apart by time', () => {
    const items = [
      { id: 'line', at: FREEZE + 1_500, lane: 'slack' },
      { id: 'beat', at: FREEZE + 1_900, lane: 'beat', marker: 'scripted beat' },
      { id: 'later', at: FREEZE + 10_000, lane: 'email' },
      { id: 'first', at: FREEZE - 10_000, lane: 'slack' },
    ];
    expect(orderTimeline(items).map((x) => x.id)).toEqual(['first', 'beat', 'line', 'later']);
    expect(laneCounts(items)).toEqual({ slack: 2, beat: 1, email: 1 });
  });
});
