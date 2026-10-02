import { useInboxStore } from '../../store/inboxStore';
import { getDesktopWindowRole, hasCallPanel, isCallPanelWindow, sendVoiceCommand, showCallPanel, voiceHostElsewhere } from '../desktop';
import { walkieCallState } from './walkie';

export function huddleInOtherWindow(): boolean {
  if (isCallPanelWindow()) return false;
  return hasCallPanel() || (getDesktopWindowRole().anyInCall && useInboxStore.getState().call.phase === 'idle');
}

export async function focusExistingHuddle(): Promise<boolean> {
  // A voice host holding a call opens its stage on command, whatever the
  // shell has recorded about which window hosts a room.
  if (voiceHostElsewhere() && walkieCallState().phase !== 'idle') return sendVoiceCommand('expandCall');
  return huddleInOtherWindow() && await showCallPanel();
}
