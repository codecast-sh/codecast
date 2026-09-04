import { useInboxStore } from '../../store/inboxStore';
import { getDesktopWindowRole, hasCallPanel, isCallPanelWindow, showCallPanel } from '../desktop';

export function huddleInOtherWindow(): boolean {
  if (isCallPanelWindow()) return false;
  return hasCallPanel() || (getDesktopWindowRole().anyInCall && useInboxStore.getState().call.phase === 'idle');
}

export async function focusExistingHuddle(): Promise<boolean> {
  return huddleInOtherWindow() && await showCallPanel();
}
