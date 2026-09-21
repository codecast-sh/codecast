import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { DaemonDeviceRow } from '../../../hooks/useDaemonHealth';
import type { MachineCandidate } from '../../../lib/machinePicker';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'CustomEvent', 'getComputedStyle', 'localStorage', 'sessionStorage']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as any)[key] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ConvexProvider } = await import('convex/react');
const { SyncStatusChip } = await import('../../SyncStatusChip');
const { useInboxStore } = await import('../../../store/inboxStore');
const client = {
  connectionState: () => ({ isWebSocketConnected: true }),
  subscribeToConnectionState: () => () => {},
} as any;
const row: MachineCandidate & DaemonDeviceRow = { device_id: 'fixture', label: 'Test machine', is_remote: false, online: true, last_seen: Date.now(),
  daemon_started_at: Date.now() - 3600000, pending_sync_count: 0, oldest_pending_ms: 0 };
useInboxStore.setState({ currentUser: { _id: 'health-viewer' } as any, machineRoster: [row], liveLoading: {}, syncLogLag: {} });
sessionStorage.setItem('cast_term_endpoint', JSON.stringify({ port: 45123, token: 'fixture', deviceId: 'fixture', tmux: true }));
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => Response.json({ tmux: true, sessions: [] })) as typeof fetch;
const root = createRoot(document.getElementById('root')!);
const label = () => document.querySelector('button')?.getAttribute('aria-label');
const realNow = Date.now;
try {
  await act(async () => { root.render(<ConvexProvider client={client}><SyncStatusChip /></ConvexProvider>); });
  await act(async () => {
    Date.now = () => realNow() + 61000;
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
  });
  assert.equal(label(), 'Sync status: Up to date');
  await act(async () => {
    const stalled: MachineCandidate & DaemonDeviceRow = { ...row, pending_sync_count: 27,
      pending_sync_messages: 0, pending_sync_conversations: 27, oldest_pending_ms: 360000 };
    useInboxStore.getState().setMachineRoster([stalled]);
  });
  assert.equal(label(), 'Sync status: sync stalled · 27 conversations');
  assert.ok(document.querySelector('[style*="--sol-yellow"]'));
  await act(async () => {
    const draining: MachineCandidate & DaemonDeviceRow = { ...row, pending_sync_count: 12,
      pending_sync_messages: 904, pending_sync_conversations: 12, oldest_pending_ms: 540000, sync_no_progress_ms: 20000 };
    useInboxStore.getState().setMachineRoster([draining]);
  });
  assert.equal(label(), 'Sync status: syncing · 904 messages');
  assert.ok(document.querySelector('[style*="--sol-blue"]'));
  await act(async () => { useInboxStore.getState().setMachineRoster([row]); });
  assert.equal(label(), 'Sync status: Up to date');
  assert.ok(document.querySelector('[style*="--sol-green"]'));
  console.log('sync indicator failure and recovery verified');
} finally {
  Date.now = realNow;
  globalThis.fetch = realFetch;
  await act(async () => { root.unmount(); });
  dom.window.close();
}
