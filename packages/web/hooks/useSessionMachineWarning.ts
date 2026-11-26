import { useConversationOwnerDevice } from "./useConversationOwnerDevice";
import { useDaemonHealth, holdsUndeliveredMessage } from "./useDaemonHealth";
import { useHostWake } from "./useHostWake";
import { useAppOffline } from "./useAppOffline";
import { describeDaemonHealth, type DaemonHealthCopy } from "../lib/daemonHealthCopy";

/**
 * What the send box says before a send when the machine carrying this
 * conversation's messages could not put one into its session right now (a
 * daemon quiet, offline or restarting). Same verdict and words as the header
 * chip and the delivery note after a send, so a person learns it before they
 * press Enter, not after waiting (ct-101510). Null when nothing would hold the
 * message: a healthy machine, a sync backlog (uploads, not deliveries), a
 * cloud host asleep or waking (its own steps), or this app being the one cut
 * off (the connection banner owns that).
 */
export function useSessionMachineWarning(conversationId: string | null | undefined): DaemonHealthCopy | null {
  const ownerDeviceId = useConversationOwnerDevice(conversationId);
  const health = useDaemonHealth(ownerDeviceId);
  const wake = useHostWake(ownerDeviceId);
  const { offline } = useAppOffline();
  if (offline || wake || !holdsUndeliveredMessage(health)) return null;
  return describeDaemonHealth(health);
}
