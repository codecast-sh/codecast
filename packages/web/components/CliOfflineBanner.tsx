import { useState } from "react";
import { Terminal } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { copyToClipboard } from "../lib/utils";
import { useMountEffect } from "../hooks/useMountEffect";
import { useCurrentUser } from "../hooks/useCurrentUser";
import {
  offlineTierFor,
  formatDuration,
  useDaemonHealth,
  type OfflineTier,
} from "../hooks/useDaemonHealth";
import { useAppOffline } from "../hooks/useAppOffline";
import { useStatusNotice, type StatusNotice } from "../hooks/useStatusNotice";

const DISMISS_DURATION_MS = 30 * 60 * 1000;

const TIER_TONE: Record<OfflineTier, StatusNotice["tone"]> = { warn: "yellow", alert: "orange", severe: "red" };

export function CliOfflineBanner() {
  useStatusNotice("cli-offline", useCliOfflineNotice());
  return null;
}

// Every hook runs before the first early return, so the notice can bail out
// in whatever order reads best.
function useCliOfflineNotice(): StatusNotice | null {
  const dismissedTs = useInboxStore(s => s.clientState.dismissed?.cli_offline ?? 0);
  const updateDismissed = useInboxStore(s => s.updateClientDismissed);
  const [mounted, setMounted] = useState(false);
  const [copied, setCopied] = useState(false);

  const { user } = useCurrentUser();
  // Share the daemon-health hook with the chip so both get the same wall-clock
  // freshness and the post-wake grace (raw Date.now() here would re-introduce
  // the false "offline" banner that climbs while a stalled subscription freezes
  // daemon_last_seen).
  const health = useDaemonHealth();
  // When this client itself has no connection, daemon_last_seen is stale
  // because WE can't sync — that's the ConnectionBanner's story, not the CLI's.
  const { offline: appOffline } = useAppOffline();

  useMountEffect(() => { setMounted(true); });

  if (!mounted) return null;
  if (appOffline) return null;
  if (user === undefined) return null;
  if (health.kind !== "offline") return null;

  const tier = health.tier;
  const offlineDuration = health.offlineMs;
  // Dismiss math needs how stale the daemon was at the moment of dismissal.
  // Derived from the health verdict (per device) rather than the user doc,
  // which is last-writer across machines.
  const lastSeen = Date.now() - offlineDuration;

  // Honor dismiss only while we're in the same (or lower) tier than when it was dismissed.
  // If the situation has escalated to a worse tier since dismiss, surface the banner again.
  const dismissedOfflineDuration = dismissedTs > 0 ? dismissedTs - lastSeen : -1;
  const dismissedTier = dismissedOfflineDuration > 0 ? offlineTierFor(dismissedOfflineDuration) : null;
  const dismissActive = dismissedTs > 0 && Date.now() - dismissedTs < DISMISS_DURATION_MS;
  const tierEscalated =
    dismissedTier === null
      ? tier !== "warn" // dismiss happened before any tier, so any tier is an escalation
      : (tier === "severe" && dismissedTier !== "severe") ||
        (tier === "alert" && dismissedTier === "warn");
  if (dismissActive && !tierEscalated) return null;

  const command = tier === "warn" ? "cast status" : "cast restart";
  const stale = formatDuration(offlineDuration);
  const who = health.device ? `CLI on ${health.device}` : "CLI";
  const message = tier === "warn" ? `${who} hasn't synced in ${stale}.` : `${who} offline for ${stale}.`;
  const action = tier === "warn" ? "Check status with " : "Restart with ";

  const handleCopy = async () => {
    await copyToClipboard(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return {
    tone: TIER_TONE[tier],
    icon: Terminal,
    title: message,
    detail: (
      <>
        {action}
        <button
          onClick={handleCopy}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 font-mono text-xs bg-sol-base02 text-sol-base1 rounded cursor-pointer hover:bg-sol-base01 hover:text-sol-base2 transition-colors"
          title="Click to copy"
        >
          {copied ? "copied!" : command}
        </button>
      </>
    ),
    onDismiss: () => updateDismissed("cli_offline", Date.now()),
  };
}
