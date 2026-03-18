import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { X, Terminal } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { copyToClipboard } from "../lib/utils";
import { useMountEffect } from "../hooks/useMountEffect";

const DISMISS_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function CliOfflineBanner() {
  const dismissedTs = useInboxStore(s => s.clientState.dismissed?.cli_offline ?? 0);
  const updateDismissed = useInboxStore(s => s.updateClientDismissed);
  const [mounted, setMounted] = useState(false);
  const [copied, setCopied] = useState(false);

  const user = useQuery(api.users.getCurrentUser);

  useMountEffect(() => { setMounted(true); });

  const isDismissed = dismissedTs > 0 && Date.now() - dismissedTs < DISMISS_DURATION_MS;

  if (!mounted || isDismissed) return null;
  if (user === undefined) return null;

  const lastSeen = user?.daemon_last_seen || user?.last_heartbeat;
  if (!lastSeen) return null;

  const offlineDuration = Date.now() - lastSeen;
  if (offlineDuration < ONE_DAY_MS) return null;

  const days = Math.floor(offlineDuration / ONE_DAY_MS);
  const label = days === 1 ? "1 day" : `${days} days`;

  const handleCopy = async () => {
    await copyToClipboard("codecast restart");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="bg-gradient-to-r from-sol-orange/10 via-sol-red/10 to-sol-orange/10 border-b border-sol-orange/30">
      <div className="px-4 py-2 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Terminal className="w-4 h-4 text-sol-orange flex-shrink-0" />
          <span className="text-sm text-sol-text truncate">
            CLI hasn&apos;t synced in {label}.
            {" "}Run{" "}
            <button
              onClick={handleCopy}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 font-mono text-xs bg-sol-base02 text-sol-base1 rounded cursor-pointer hover:bg-sol-base01 hover:text-sol-base2 transition-colors"
              title="Click to copy"
            >
              {copied ? "copied!" : "codecast restart"}
            </button>
            {" "}to resume.
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
