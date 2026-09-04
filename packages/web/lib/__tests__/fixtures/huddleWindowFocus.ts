import assert from 'node:assert/strict';
import { installWindowRoleTracker } from '../../desktop';
import { focusExistingHuddle } from '../../calls/huddleWindow';
import { bindConvex, joinCall, startHuddle, knockRoom } from '../../calls/callManager';
import { useInboxStore } from '../../../store/inboxStore';
let pushRole: (role: any) => void;
let focuses = 0;
const testWindow = { __CODECAST_ELECTRON__: {
  onWindowRole: (cb: any) => { pushRole = cb; },
  showCallPanel: async () => { focuses++; return true; },
} };
(globalThis as any).window = testWindow;
installWindowRoleTracker();
const role = (callPanel: boolean, anyInCall = callPanel) => pushRole({ leader: true, appFocused: true, callPanel, anyInCall });
role(true);
bindConvex({ mutation: () => { throw Error('unexpected mutation'); }, action: () => { throw Error('unexpected action'); } } as any);
const prior = useInboxStore.getState().call;
await joinCall('room:b', { intent: 'deliberate' });
await startHuddle({ roomKey: 'room:b', toUserIds: ['b'] });
await knockRoom('room:c');
assert.equal(focuses, 3);
assert.equal(useInboxStore.getState().call, prior);
useInboxStore.getState().setCallState({ phase: 'idle' });
role(false, true);
assert.equal(await focusExistingHuddle(), true);
useInboxStore.getState().setCallState({ phase: 'connected' });
assert.equal(await focusExistingHuddle(), false);
(globalThis as any).window = { __CODECAST_ELECTRON__: { isCallPanelWindow: true } };
role(true);
assert.equal(await focusExistingHuddle(), false);
role(false);
(globalThis as any).window = {};
assert.equal(await focusExistingHuddle(), false);
console.log('huddle focus, own walkie, panel, and browser scenarios passed');
process.exit(0);
