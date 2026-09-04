import { useState, type ReactNode } from "react";
import { useDaemonHealth, blocksDelivery } from "../hooks/useDaemonHealth";
import { describeDaemonHealth } from "../lib/daemonHealthCopy";
import { withDaemonHealth, type PendingBannerState } from "../lib/pendingBanner";
import { copyToClipboard } from "../lib/utils";
import { useInboxStore } from "../store/inboxStore";

// Wraps the per-message pending UI ("starting up…" / "hasn't reached the agent"
// + kill & restart). When the DAEMON is the reason the message is late, it
// renders a daemon note in their place — same words as the header chip — with
// the command to run instead of a restart that would travel through the very
// daemon that is struggling. Mounted only for a pending message that has
// something to say, so the daemon-health subscription is not paid per bubble.
export function PendingDeliveryNote({
  state,
  restartInFlight,
  conversationId,
  children,
}: {
  state: PendingBannerState;
  restartInFlight: boolean;
  conversationId?: string | null;
  children: ReactNode;
}) {
  // The machine whose daemon carries this conversation's messages
  // (sessions.owner_device_id); health is judged for that daemon alone.
  const ownerDeviceId = useInboxStore((s) =>
    conversationId ? (s.sessions[conversationId]?.owner_device_id as string | undefined) : undefined,
  );
  const health = useDaemonHealth(ownerDeviceId);
  const [copied, setCopied] = useState(false);
  const resolved = withDaemonHealth(state, { daemonDegraded: blocksDelivery(health), restartInFlight });
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
    <div className="flex items-start gap-2 mt-2 pl-8 text-xs" data-testid="pending-message-daemon" style={{ color }}>
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
    </div>
  );
}
