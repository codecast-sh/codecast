import { useState } from "react";
import Link from "next/link";
import { Sparkles, X } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { useMountEffect } from "../hooks/useMountEffect";
import { launchSharingAgent } from "../lib/sharingAgent";
import { shouldShowSharingSetup } from "../lib/sharingSetup";

/**
 * The onboarding step after the first sync: sessions are flowing, so now is
 * when a person decides which folders sync and what each team sees. One strip,
 * shown once the CLI has connected and a session has arrived, until it is
 * taken or dismissed.
 */
export function SharingSetupBanner() {
  const visible = useInboxStore(shouldShowSharingSetup);
  const [mounted, setMounted] = useState(false);
  useMountEffect(() => { setMounted(true); });

  if (!mounted || !visible) return null;

  const take = () => useInboxStore.getState().updateClientDismissed("sharing_setup", Date.now());

  return (
    <div data-cc-banner className="bg-gradient-to-r from-sol-cyan/10 via-sol-cyan/5 to-sol-cyan/10 border-b border-sol-cyan/30">
      <div className="px-4 py-2 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Sparkles className="w-4 h-4 text-sol-cyan flex-shrink-0" />
          <span className="text-sm text-sol-text truncate">
            Your sessions are syncing.{" "}
            <span className="text-sol-text-muted">Next, choose which folders sync and what your team sees. An agent can walk you through it.</span>
          </span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => { take(); launchSharingAgent(); }}
            className="sol-btn-solid px-2.5 py-1 text-xs font-medium rounded-md bg-sol-cyan text-sol-base03"
          >
            Set up with an agent
          </button>
          <Link
            href="/settings/sync"
            onClick={take}
            className="px-2.5 py-1 text-xs font-medium rounded-md text-sol-text-muted hover:text-sol-text transition-colors"
          >
            I'll do it myself
          </Link>
          <button
            onClick={take}
            className="p-1 text-sol-text-dim hover:text-sol-text transition-colors"
            aria-label="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
