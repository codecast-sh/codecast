"use client";

import { useState, useEffect } from "react";
import { useQuery } from "convex/react";
import { useSearchParams } from "next/navigation";
import { api } from "@codecast/convex/convex/_generated/api";
import Link from "next/link";
import { X, Terminal, ArrowRight } from "lucide-react";

const DISMISS_KEY = "codecast-setup-banner-dismissed";
const DISMISS_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

function isDismissed(): boolean {
  if (typeof window === "undefined") return true;
  const dismissed = localStorage.getItem(DISMISS_KEY);
  if (!dismissed) return false;
  const timestamp = parseInt(dismissed, 10);
  if (isNaN(timestamp)) return false;
  return Date.now() - timestamp < DISMISS_DURATION_MS;
}

function dismiss(): void {
  localStorage.setItem(DISMISS_KEY, String(Date.now()));
}

export function SetupPromptBanner() {
  const [dismissed, setDismissed] = useState(true);
  const [mounted, setMounted] = useState(false);
  const searchParams = useSearchParams();
  const forceShow = searchParams.get("showSetupBanner") === "true";

  const user = useQuery(api.users.getCurrentUser);
  const conversationsResult = useQuery(
    api.conversations.listConversations,
    user?._id ? { filter: "my", limit: 1 } : "skip"
  );

  useEffect(() => {
    setMounted(true);
    setDismissed(isDismissed());
  }, []);

  const handleDismiss = () => {
    dismiss();
    setDismissed(true);
  };

  if (!mounted) return null;
  if (!forceShow && dismissed) return null;
  if (user === undefined || conversationsResult === undefined) return null;

  const hasCliInstalled = !!user?.cli_version;
  const hasSessions = conversationsResult?.conversations && conversationsResult.conversations.length > 0;

  if (!forceShow && hasCliInstalled && hasSessions) return null;

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
            onClick={handleDismiss}
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
