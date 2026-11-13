import { useState, type ReactNode } from "react";
import { useDaemonHealth, holdsUndeliveredMessage } from "../hooks/useDaemonHealth";
import { describeDaemonHealth } from "../lib/daemonHealthCopy";
import { withDaemonHealth, type PendingBannerState } from "../lib/pendingBanner";
import { copyToClipboard } from "../lib/utils";
import { useConversationOwnerDevice } from "../hooks/useConversationOwnerDevice";
import { useHostWake } from "../hooks/useHostWake";
import { HostWakeNote } from "./HostWakeStatus";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { api } from "@codecast/convex/convex/_generated/api";
import type { HostWake } from "../hooks/useHostWake";

/** A Cast session waiting on the person's cloud machine to come up for the
 *  first time (convex/castMachines.ts): no device owns it yet, so the steps
 *  come from the machine's own status. */
function useCastMachineLaunch(ownerDeviceId: string | null | undefined): HostWake | null {
  const { data: machine } = useQueryNoThrow(api.castMachines.mine, ownerDeviceId ? "skip" : {});
  if (ownerDeviceId || !machine || machine.status === "none") return null;
  const since = machine.since ?? Date.now();
  const base = { deviceId: "", host: "Your cloud machine", now: Date.now() };
  if (machine.status === "failed") return { ...base, stage: "failed", since, error: machine.error ?? "LaunchFailed", retry: false };
  if (machine.status === "launching" || machine.status === "waiting_capacity") return { ...base, stage: "requested", since };
  if (machine.status === "booting") return { ...base, stage: "starting", since };
  return machine.online ? null : { ...base, stage: "connecting", since };
}

// Wraps the per-message pending UI ("starting up…" / "hasn't reached the agent"
// + kill & restart). When the DAEMON is the reason the message is late, it
// renders a daemon note in their place — same words as the header chip — with
// the command to run instead of a restart that would travel through the very
// daemon that is struggling. When the machine is a cloud host that is asleep
// or waking, it shows the wake's steps instead (HostWakeStatus). Mounted only
// for a pending message, so the subscriptions are not paid per bubble.
export function PendingDeliveryNote({
  state,
  restartInFlight,
  conversationId,
  onCancel,
  cancelling,
  children,
}: {
  state: PendingBannerState;
  restartInFlight: boolean;
  conversationId?: string | null;
  onCancel?: () => void;
  cancelling?: boolean;
  children: ReactNode;
}) {
  // The machine whose daemon carries this conversation's messages
  // (sessions.owner_device_id); health is judged for that daemon alone.
  const ownerDeviceId = useConversationOwnerDevice(conversationId);
  const health = useDaemonHealth(ownerDeviceId);
  const hostWake = useHostWake(ownerDeviceId);
  const launch = useCastMachineLaunch(ownerDeviceId);
  const wake = hostWake ?? launch;
  const [copied, setCopied] = useState(false);
  // The host is asleep or waking: say where the wake is from the first moment,
  // not after the stuck-message grace, and never offer a restart that cannot
  // reach a machine that is booting. A restart already clicked keeps its UI.
  if (wake && !restartInFlight) return <HostWakeNote wake={wake} onCancel={onCancel} cancelling={cancelling} />;
  const resolved = withDaemonHealth(state, { daemonDegraded: holdsUndeliveredMessage(health), restartInFlight });
  if (resolved !== "daemon") return <>{children}</>;
  const copy = describeDaemonHealth(health);
  if (!copy) return <>{children}</>;
  const color = `var(${copy.colorVar})`;
  const onCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await copyToClipboard(copy.command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="flex items-start flex-wrap gap-2 mt-2 pl-8 text-xs" data-testid="pending-message-daemon" style={{ color }}>
      <span className="w-1.5 h-1.5 mt-1.5 rounded-full animate-pulse flex-shrink-0" style={{ background: color }} />
      <span className="text-sol-text-muted leading-relaxed">
        <span style={{ color }} className="font-medium">Delivery delayed — </span>
        {copy.detail}{" "}
        <button
          onClick={onCopy}
          className="ml-1 px-1.5 py-px rounded border font-mono align-baseline transition-colors hover:bg-[color-mix(in_srgb,currentColor_10%,transparent)]"
          style={{ borderColor: `color-mix(in srgb, ${color} 40%, transparent)`, color }}
          title="Copy command"
        >
          {copied ? "copied!" : copy.command}
        </button>
      </span>
      {onCancel && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onCancel(); }}
          disabled={cancelling}
          data-testid="pending-message-cancel"
          className="text-meta text-sol-text-dim/70 hover:text-sol-orange underline underline-offset-2 transition-colors disabled:opacity-60"
          title="Stop trying to send and discard this message"
        >
          {cancelling ? "Cancelling…" : "Cancel"}
        </button>
      )}
    </div>
  );
}
