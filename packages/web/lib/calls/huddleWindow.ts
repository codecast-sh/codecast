import { useInboxStore } from '../../store/inboxStore';
import { getDesktopWindowRole, hasCallPanel, isCallPanelWindow, sendVoiceCommand, showCallPanel, voiceHostElsewhere } from '../desktop';

export function huddleInOtherWindow(): boolean {
  if (isCallPanelWindow()) return false;
  return hasCallPanel() || (getDesktopWindowRole().anyInCall && useInboxStore.getState().call.phase === 'idle');
}

export async function focusExistingHuddle(): Promise<boolean> {
  // A voice host holding a call opens its stage on command, whatever the
  // shell has recorded about which window hosts a room. The walkie engine is
  // read lazily: it imports callManager, which imports this module, so a
  // static import here closes a cycle in which whichever of the two loads
  // first sees the other half built (callManager first: walkie's top-level
  // bindWalkieUpgrade hits callManager's `let` before it exists).
  if (voiceHostElsewhere() && (await import('./walkie')).walkieCallState().phase !== 'idle') return expandCall();
  return huddleInOtherWindow() && await showCallPanel();
}

/**
 * Bring the call's stage up, from any window but the one holding it.
 *
 * With a voice host the host decides everything, so the gesture goes there
 * unconditionally: it raises a stage already open behind the app, opens it,
 * or takes over a call this machine shows but no window here holds. Gating it
 * on this window's mirror of the call (as `focusExistingHuddle` must, to tell
 * a join from a focus) is what made the expand button do nothing whenever the
 * mirror lagged or the call lived elsewhere. False when nothing took it.
 */
export async function expandCall(): Promise<boolean> {
  if (voiceHostElsewhere()) return sendVoiceCommand('expandCall');
  return huddleInOtherWindow() && await showCallPanel();
}
