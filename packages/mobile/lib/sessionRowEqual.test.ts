import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionRowPropsEqual, sessionRowRenderEqual } from './sessionRowEqual';

const NOW = 1_800_000_000_000;
const row = (over: Record<string, unknown> = {}) => ({
  _id: 'jx7row', title: 'Live', agent_status: 'working', updated_at: NOW - 5_000,
  last_heartbeat: NOW - 2_000, daemon_alive_until: NOW + 600_000, message_count: 10,
  ...over,
});

describe('sessionRowRenderEqual', () => {
  it('ignores a heartbeat that changes nothing the row draws', () => {
    expect(sessionRowRenderEqual(row(), row({ last_heartbeat: NOW - 500, daemon_alive_until: NOW + 700_000, context_tokens: 9 }), NOW)).toBe(true);
  });

  it('sees a heartbeat that changes the trusted status', () => {
    // A heartbeat long gone makes "working" untrustworthy; a fresh one restores it.
    const stale = row({ last_heartbeat: NOW - 3_600_000, updated_at: NOW - 3_600_000 });
    const fresh = row({ last_heartbeat: NOW - 1_000, updated_at: NOW - 3_600_000 });
    expect(sessionRowRenderEqual(stale, fresh, NOW)).toBe(false);
  });

  it('sees every drawn field', () => {
    expect(sessionRowRenderEqual(row(), row({ title: 'Renamed' }), NOW)).toBe(false);
    expect(sessionRowRenderEqual(row(), row({ updated_at: NOW }), NOW)).toBe(false);
    expect(sessionRowRenderEqual(row(), row({ message_count: 11 }), NOW)).toBe(false);
  });
});

describe('sessionRowPropsEqual', () => {
  const onPress = () => {};
  it('compares the other props by identity', () => {
    expect(sessionRowPropsEqual({ session: row(), onPress, clock: 1 }, { session: row({ last_heartbeat: NOW }), onPress, clock: 1 })).toBe(true);
    expect(sessionRowPropsEqual({ session: row(), onPress, clock: 1 }, { session: row(), onPress, clock: 2 })).toBe(false);
    expect(sessionRowPropsEqual({ session: row(), onPress } as any, { session: row(), onPress: () => {} } as any)).toBe(false);
  });
});

// Inbox rows hold still, as web's do (listRowsHoldStill): an infinite
// animation per row is a native prop write per row every frame, and a list
// renders one row per live session. The one pulse is the composer's.
describe('session rows hold still', () => {
  it('no row component pulses', () => {
    const src = readFileSync(join(import.meta.dir, '../components/SessionItem.tsx'), 'utf8');
    const pulse = src.indexOf('export function PulsingDot');
    const pulseEnd = src.indexOf('\n}\n', pulse);
    const rest = src.slice(0, pulse) + src.slice(pulseEnd);
    expect(rest).not.toContain('<PulsingDot');
    expect(rest).not.toMatch(/Animated\.loop\(/);
  });
});
