import { useState } from "react";
import { X, Terminal } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { copyToClipboard } from "../lib/utils";
import { useMountEffect } from "../hooks/useMountEffect";
import { useCurrentUser } from "../hooks/useCurrentUser";

const ONE_MIN_MS = 60 * 1000;
const ONE_HOUR_MS = 60 * ONE_MIN_MS;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

const WARN_AFTER_MS = 10 * ONE_MIN_MS;
const ALERT_AFTER_MS = ONE_HOUR_MS;
const SEVERE_AFTER_MS = ONE_DAY_MS;

const DISMISS_DURATION_MS = 30 * ONE_MIN_MS;

type Tier = "warn" | "alert" | "severe";

function tierFor(offlineMs: number): Tier | null {
  if (offlineMs >= SEVERE_AFTER_MS) return "severe";
  if (offlineMs >= ALERT_AFTER_MS) return "alert";
  if (offlineMs >= WARN_AFTER_MS) return "warn";
  return null;
}

function formatStale(ms: number): string {
  if (ms >= ONE_DAY_MS) {
    const days = Math.floor(ms / ONE_DAY_MS);
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (ms >= ONE_HOUR_MS) {
    const hours = Math.floor(ms / ONE_HOUR_MS);
    return `${hours}h`;
  }
  const mins = Math.max(1, Math.floor(ms / ONE_MIN_MS));
  return `${mins} min`;
}

const TIER_STYLES: Record<Tier, { wrap: string; icon: string }> = {
  warn: {
    wrap: "bg-gradient-to-r from-sol-yellow/10 via-sol-yellow/5 to-sol-yellow/10 border-b border-sol-yellow/30",
    icon: "text-sol-yellow",
  },
  alert: {
    wrap: "bg-gradient-to-r from-sol-orange/10 via-sol-orange/10 to-sol-orange/10 border-b border-sol-orange/30",
    icon: "text-sol-orange",
  },
  severe: {
    wrap: "bg-gradient-to-r from-sol-orange/10 via-sol-red/10 to-sol-orange/10 border-b border-sol-red/40",
    icon: "text-sol-red",
  },
};

export function CliOfflineBanner() {
  const dismissedTs = useInboxStore(s => s.clientState.dismissed?.cli_offline ?? 0);
  const updateDismissed = useInboxStore(s => s.updateClientDismissed);
  const [mounted, setMounted] = useState(false);
  const [copied, setCopied] = useState(false);

  const { user } = useCurrentUser();

  useMountEffect(() => { setMounted(true); });

  if (!mounted) return null;
  if (user === undefined) return null;

  const lastSeen = user?.daemon_last_seen || user?.last_heartbeat;
  if (!lastSeen) return null;

  const offlineDuration = Date.now() - lastSeen;
  const tier = tierFor(offlineDuration);
  if (!tier) return null;

  // Honor dismiss only while we're in the same (or lower) tier than when it was dismissed.
  // If the situation has escalated to a worse tier since dismiss, surface the banner again.
  const dismissedOfflineDuration = dismissedTs > 0 ? dismissedTs - lastSeen : -1;
  const dismissedTier = dismissedOfflineDuration > 0 ? tierFor(dismissedOfflineDuration) : null;
  const dismissActive = dismissedTs > 0 && Date.now() - dismissedTs < DISMISS_DURATION_MS;
  const tierEscalated =
    dismissedTier === null
      ? tier !== "warn" // dismiss happened before any tier, so any tier is an escalation
      : (tier === "severe" && dismissedTier !== "severe") ||
        (tier === "alert" && dismissedTier === "warn");
  if (dismissActive && !tierEscalated) return null;

  const command = tier === "warn" ? "cast status" : "cast restart";
  const stale = formatStale(offlineDuration);
  const message =
    tier === "warn"
      ? `CLI hasn't synced in ${stale}.`
      : tier === "alert"
      ? `CLI offline for ${stale}.`
      : `CLI offline for ${stale}.`;
  const action = tier === "warn" ? "Check status with " : "Restart with ";

  const handleCopy = async () => {
    await copyToClipboard(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const styles = TIER_STYLES[tier];

  return (
    <div className={styles.wrap}>
      <div className="px-4 py-2 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Terminal className={`w-4 h-4 ${styles.icon} flex-shrink-0`} />
          <span className="text-sm text-sol-text truncate">
            {message}
            {" "}{action}
            <button
              onClick={handleCopy}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 font-mono text-xs bg-sol-base02 text-sol-base1 rounded cursor-pointer hover:bg-sol-base01 hover:text-sol-base2 transition-colors"
              title="Click to copy"
            >
              {copied ? "copied!" : command}
            </button>
          </span>
        </div>
        <button
          onClick={() => updateDismissed("cli_offline", Date.now())}
          className="p-1 text-sol-text-dim hover:text-sol-text transition-colors flex-shrink-0"
          aria-label="Dismiss"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
