// laneOpen's rules against the real inbox store: the server's client_state
// row keeps its _id through the singleton merge, which is what tells a
// fresh install's empty cache apart from an answer.
import { test, expect } from 'bun:test';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { laneSettled, routeFromOutside, type LaneOpenStore } from './laneOpen';

const store = useInboxStore as unknown as LaneOpenStore;

test('a first sign-in waits for the server row, then opens the lane', async () => {
  useInboxStore.setState({ clientState: { ui: {} }, clientStateInitialized: true, pending: {} } as never);
  expect(laneSettled(useInboxStore.getState() as never)).toBe(false);
  const route = routeFromOutside('/session/abc', store, 5000);
  useInboxStore.getState().syncTable('clientState', { _id: 'cs1', ui: { lane: 'simple', 'lane:ts': Date.now() } });
  expect(laneSettled(useInboxStore.getState() as never)).toBe(true);
  expect(await route).toBe('/simple/c/abc');
});
