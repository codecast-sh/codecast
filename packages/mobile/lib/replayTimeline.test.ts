import { describe, expect, test } from 'bun:test';
import { parseReplayTimeline, parseTimelineClock, rowAt } from './replayTimeline';

const MD = [
  'replay rp-1 · 6 events · 5:00.6 · 1 click · 2 errors · 1 failed request',
  '- 0:00.0 nav /inbox "Codecast"',
  '- 0:00.5 view: [button] New | [button] Sync',
  '- 0:03.6 **ERROR Server Error ArgumentValidationError**',
  '    Path: .conversation_id',
  '    Called by client',
  '- 0:16.8 click "What should we build"',
  '- 0:21.7 type into "Action or jump to...": 0 chars',
  '- 0:25.2 **console.error** Can only backfill your own conversations',
  '- 0:26.0 **GET /api/x -> 500 (31 ms)**',
  '- 0:30.0 console.warn x3 [feeder] query failed',
  '- … 4 later lines not shown',
  '- 1:02:03.4 key Enter',
].join('\n');

describe('parseReplayTimeline', () => {
  const rows = parseReplayTimeline(MD);

  test('reads each moment with its kind and clock', () => {
    expect(rows.map((r) => r.kind)).toEqual(['nav', 'view', 'error', 'click', 'input', 'error', 'request', 'warn', 'gap', 'key']);
    expect(rows[0]).toEqual({ t: 0, kind: 'nav', text: '/inbox "Codecast"', detail: [] });
    expect(rows[9].t).toBe(3_723_400);
  });

  test('keeps a failure its stack lines and drops the bold marks', () => {
    expect(rows[2].text).toBe('Server Error ArgumentValidationError');
    expect(rows[2].detail).toEqual(['Path: .conversation_id', 'Called by client']);
    expect(rows[5].text).toBe('Can only backfill your own conversations');
    expect(rows[6].text).toBe('GET /api/x -> 500 (31 ms)');
    expect(rows[7].text).toBe('[feeder] query failed');
  });

  test('reads a slow request that answered apart from a failed one', () => {
    const [slow] = parseReplayTimeline('- 0:00.1 slow GET /fonts/a.woff2 → 200 (2586 ms)');
    expect(slow).toEqual({ t: 100, kind: 'slow', text: 'slow GET /fonts/a.woff2 → 200 (2586 ms)', detail: [] });
  });

  test('says an empty field as a focus, as a fresh render does', () => {
    expect(rows[4].text).toBe('focus "Action or jump to..."');
  });

  test('a gap marker has no clock', () => {
    expect(rows[8]).toMatchObject({ t: null, kind: 'gap' });
  });

  test('nothing stored reads as no rows', () => {
    expect(parseReplayTimeline(null)).toEqual([]);
  });
});

describe('rowAt', () => {
  const rows = parseReplayTimeline(MD);
  test('names the last row at or before the moment', () => {
    expect(rowAt(rows, 17_000)).toBe(3);
    expect(rowAt(rows, 0)).toBe(0);
    expect(rowAt(rows, 99_999_999)).toBe(9);
  });
});

test('parseTimelineClock', () => {
  expect(parseTimelineClock('0:03.6')).toBe(3600);
  expect(parseTimelineClock('12:00')).toBe(720_000);
  expect(parseTimelineClock('nope')).toBeNull();
});
