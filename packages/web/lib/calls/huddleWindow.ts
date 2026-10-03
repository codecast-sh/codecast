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
  if (voiceHostElsewhere() && (await import('./walkie')).walkieCallState().phase !== 'idle') return sendVoiceCommand('expandCall');
  return huddleInOtherWindow() && await showCallPanel();
}
