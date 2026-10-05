import assert from 'node:assert/strict';
import { installWindowRoleTracker } from '../../desktop';
import { expandCall, focusExistingHuddle } from '../../calls/huddleWindow';
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
// Expand with a voice host elsewhere goes to the host whatever this window
// mirrors of the call: no mirror at all here, which is what left the expand
// button dead when the mirror lagged or the call lived in another window.
const sent: string[] = [];
(globalThis as any).window = { __CODECAST_ELECTRON__: {
  voiceCommand: async (cmd: string) => { sent.push(cmd); return true; },
  showCallPanel: async () => { throw Error('expand must not ask the shell when a host decides'); },
} };
pushRole({ leader: true, appFocused: true, callPanel: false, anyInCall: false, voiceWindow: true });
useInboxStore.getState().setCallState({ phase: 'idle' });
assert.equal(await expandCall(), true);
assert.deepEqual(sent, ['expandCall']);
console.log('huddle focus, own walkie, panel, browser and expand scenarios passed');
process.exit(0);
