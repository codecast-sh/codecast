"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import Link from "next/link";
import { X, Terminal, ArrowRight } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { useMountEffect } from "../hooks/useMountEffect";

const DISMISS_DURATION_MS = 24 * 60 * 60 * 1000;

export function SetupPromptBanner() {
  const dismissedTs = useInboxStore(s => s.clientState.dismissed?.setup_prompt ?? 0);
  const updateDismissed = useInboxStore(s => s.updateClientDismissed);
  const [mounted, setMounted] = useState(false);

  const user = useQuery(api.users.getCurrentUser);
  const conversationsResult = useQuery(
    api.conversations.listConversations,
    user?._id ? { filter: "my", limit: 1 } : "skip"
  );

  useMountEffect(() => { setMounted(true); });

  const isDismissed = dismissedTs > 0 && Date.now() - dismissedTs < DISMISS_DURATION_MS;

  if (!mounted || isDismissed) return null;
  if (user === undefined || conversationsResult === undefined) return null;

  const hasCliInstalled = !!user?.cli_version;
  const hasSessions = conversationsResult?.conversations && conversationsResult.conversations.length > 0;

  if (hasCliInstalled && hasSessions) return null;
  // If no personal sessions, the empty state handles onboarding -- don't double-prompt
  if (!hasSessions) return null;

  const message = !hasCliInstalled
    ? "Install the CLI to start syncing your Claude Code sessions"
    : "Start the daemon to sync your first session";

  return (
    <div className="bg-gradient-to-r from-sol-yellow/10 via-sol-orange/10 to-sol-yellow/10 border-b border-sol-yellow/30">
      <div className="px-4 py-2 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Terminal className="w-4 h-4 text-sol-yellow flex-shrink-0" />
          <span className="text-sm text-sol-text truncate">{message}</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Link
            href="/settings/cli"
            className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium bg-sol-yellow/20 hover:bg-sol-yellow/30 text-sol-yellow rounded transition-colors"
          >
            Setup
            <ArrowRight className="w-3 h-3" />
          </Link>
          <button
            onClick={() => updateDismissed("setup_prompt", Date.now())}
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
