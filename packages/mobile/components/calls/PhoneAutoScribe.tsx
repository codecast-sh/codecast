// "Invite Scribe to every huddle" on the phone: the same rule web mounts
// (hooks/useAutoScribe), fed the phone's own seat, so the setting holds on a
// walk too. It never opens the board: that stays one tap on the call screen.
import { useSyncExternalStore } from 'react';
import { useAutoScribe } from '@codecast/web/hooks/useAutoScribe';
import { getCallSnapshot, subscribeCall } from '@/lib/calls/callManager';
import { appAlert } from '@/lib/popups';

export function PhoneAutoScribe() {
  const call = useSyncExternalStore(subscribeCall, getCallSnapshot, getCallSnapshot);
  useAutoScribe(call.phase === 'connected' ? call.roomKey : null, appAlert);
  return null;
}
