import { test, expect, describe } from 'bun:test';
import { laneKnown, laneRouteFor, laneSettled, openerTarget, routeFromOutside, viaOpener, type LaneOpenState, type LaneOpenStore } from './laneOpen';

function state(over: Partial<LaneOpenState> = {}): LaneOpenState {
  return { clientStateInitialized: true, clientState: { ui: { lane: 'simple' } }, sessions: {}, conversations: {}, ...over };
}

/** A store whose cache is read back later, the way bootPersistence does it. */
function fakeStore(initial: LaneOpenState) {
  let s = initial;
  const listeners = new Set<(s: LaneOpenState) => void>();
  const store: LaneOpenStore = {
    getState: () => s,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const set = (next: Partial<LaneOpenState>) => {
    s = { ...s, ...next };
    for (const fn of listeners) fn(s);
  };
  return { store, set, listeners };
}

describe('laneRouteFor', () => {
  test('the full app keeps every route', () => {
    const s = state({ clientState: { ui: {} } });
    expect(laneRouteFor('/session/abc', s)).toBe('/session/abc');
    expect(laneRouteFor('/decisions/d1', s)).toBe('/decisions/d1');
  });

  test('a lane person opens a conversation in the lane unless it is a coding session', () => {
    expect(laneRouteFor('/session/abc', state())).toBe('/simple/c/abc');
    expect(laneRouteFor('/session/abc?m=7', state({ sessions: { abc: { agent_type: 'codecast' } } }))).toBe('/simple/c/abc');
    expect(laneRouteFor('/session/abc', state({ sessions: { abc: { agent_type: 'claude_code' } } }))).toBe('/session/abc');
  });

  test('a decision opens in its lane conversation, or on approvals while unknown', () => {
    expect(laneRouteFor('/decisions/d1', state())).toBe('/simple/approvals');
    expect(laneRouteFor('/decisions/d1', state({ sessionDecisions: { d1: { conversation_id: 'abc' } } }))).toBe('/simple/c/abc');
    expect(
      laneRouteFor('/decisions/d1', state({ sessionDecisions: { d1: { conversation_id: 'abc' } }, sessions: { abc: { agent_type: 'claude_code' } } })),
    ).toBe('/decisions/d1');
  });

  test('other routes pass through', () => {
    expect(laneRouteFor('/task/ct-1', state())).toBe('/task/ct-1');
  });
});

describe('routeFromOutside', () => {
  test('a push tapped before the cache is read back waits for the lane', async () => {
    const { store, set, listeners } = fakeStore(state({ clientStateInitialized: false, clientState: {} }));
    const route = routeFromOutside('/session/abc', store);
    set({ clientStateInitialized: true, clientState: { ui: { lane: 'simple' } } });
    expect(await route).toBe('/simple/c/abc');
    expect(listeners.size).toBe(0);
  });

  test('a cache that never answers settles for the full app after the cap', async () => {
    const { store } = fakeStore(state({ clientStateInitialized: false, clientState: {} }));
    expect(await routeFromOutside('/session/abc', store, 10)).toBe('/session/abc');
  });

  test('an empty cache read back is not an answer: a fresh install waits for the server', async () => {
    // A first sign-in on a new phone: the cache is read back (initialized)
    // and holds nothing, then the server's client_state arrives with the lane.
    const { store, set, listeners } = fakeStore(state({ clientStateInitialized: true, clientState: { ui: {} } }));
    const route = routeFromOutside('/session/abc', store);
    await Promise.resolve();
    expect(listeners.size).toBe(1);
    set({ clientState: { _id: 'cs1', ui: { lane: 'simple' } } });
    expect(await route).toBe('/simple/c/abc');
    expect(listeners.size).toBe(0);
  });

  test("the server's row without a lane answers full at once", async () => {
    const { store } = fakeStore(state({ clientState: { _id: 'cs1', ui: {} } }));
    expect(await routeFromOutside('/session/abc', store, 1_000_000)).toBe('/session/abc');
  });

  test('a known lane answers at once', async () => {
    const { store } = fakeStore(state());
    await laneKnown(store, 1_000_000);
    expect(await routeFromOutside('/session/abc', store)).toBe('/simple/c/abc');
  });
});

describe('laneSettled', () => {
  test('needs the cache read back and an answer that can carry the lane', () => {
    expect(laneSettled({ clientStateInitialized: false, clientState: { _id: 'cs1', ui: { lane: 'simple' } } })).toBe(false);
    expect(laneSettled({ clientStateInitialized: true, clientState: { ui: {} } })).toBe(false);
    expect(laneSettled({ clientStateInitialized: true, clientState: null })).toBe(false);
    expect(laneSettled({ clientStateInitialized: true, clientState: { _id: 'cs1', ui: {} } })).toBe(true);
    expect(laneSettled({ clientStateInitialized: true, clientState: { ui: { lane: 'full' } } })).toBe(true);
  });
});

describe('the opener', () => {
  test('only conversations and decisions stop at app/open', () => {
    expect(viaOpener('/session/abc?m=2')).toBe('/open/session/abc?m=2');
    expect(viaOpener('/decisions/d1')).toBe('/open/decisions/d1');
    expect(viaOpener('/task/ct-1')).toBe('/task/ct-1');
  });

  test('it rebuilds the route it was given', () => {
    expect(openerTarget(['session', 'abc'], { m: '2' })).toBe('/session/abc?m=2');
    expect(openerTarget('decisions', {})).toBe('/decisions');
  });
});
