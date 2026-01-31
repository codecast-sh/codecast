"use client";

import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Switch } from "./ui/switch";
import { copyToClipboard } from "../lib/utils";
import { toast } from "sonner";

interface SharePopoverProps {
  isPrivate: boolean;
  hasShareToken: boolean;
  onToggleTeamShare: () => Promise<void>;
  onGenerateShareLink: () => Promise<void>;
  shareUrl: string | null;
}

function getShareStatus(isPrivate: boolean, hasShareToken: boolean): {
  label: string;
  color: string;
} {
  if (isPrivate && !hasShareToken) {
    return { label: "Private", color: "text-sol-text-dim" };
  }
  if (!isPrivate && !hasShareToken) {
    return { label: "Team", color: "text-sol-green" };
  }
  if (isPrivate && hasShareToken) {
    return { label: "Link", color: "text-sol-cyan" };
  }
  return { label: "Team + Link", color: "text-sol-cyan" };
}

export function SharePopover({
  isPrivate,
  hasShareToken,
  onToggleTeamShare,
  onGenerateShareLink,
  shareUrl,
}: SharePopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isTogglingTeam, setIsTogglingTeam] = useState(false);
  const [isGeneratingLink, setIsGeneratingLink] = useState(false);
  const [copied, setCopied] = useState(false);
  const [alsoShareWithTeam, setAlsoShareWithTeam] = useState(true);

  const status = getShareStatus(isPrivate, hasShareToken);

  const handleToggleTeam = async () => {
    setIsTogglingTeam(true);
    try {
      await onToggleTeamShare();
    } finally {
      setIsTogglingTeam(false);
    }
  };

  const handleCopyLink = async () => {
    if (!shareUrl) {
      setIsGeneratingLink(true);
      try {
        await onGenerateShareLink();
      } finally {
        setIsGeneratingLink(false);
      }
    }
    if (shareUrl) {
      await copyToClipboard(shareUrl);
      setCopied(true);
      toast.success("Link copied");
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleCreateLink = async () => {
    setIsGeneratingLink(true);
    try {
      await onGenerateShareLink();
      // Also enable team sharing if checkbox is checked and not already shared
      if (alsoShareWithTeam && isPrivate) {
        await onToggleTeamShare();
      }
      toast.success("Share link created");
    } finally {
      setIsGeneratingLink(false);
    }
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          className="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-sol-bg-alt transition-colors text-xs"
          title="Share settings"
        >
          <svg className="w-3.5 h-3.5 text-sol-text-dim" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
          </svg>
          <span className={status.color}>{status.label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-72 bg-sol-bg border-sol-border p-0"
      >
        <div className="p-3 border-b border-sol-border">
          <h3 className="text-sm font-medium text-sol-text">Share Settings</h3>
        </div>

        <div className="p-3 space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-sol-green" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <span className="text-sm text-sol-text">Team access</span>
              </div>
              <Switch
                checked={!isPrivate}
                onCheckedChange={handleToggleTeam}
                disabled={isTogglingTeam}
              />
            </div>
            <p className="text-xs text-sol-text-dim pl-6">
              Team members can view this in their feed
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-sol-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
              </svg>
              <span className="text-sm text-sol-text">Public link</span>
            </div>
            <p className="text-xs text-sol-text-dim pl-6 mb-2">
              Anyone with the link can view
            </p>

            {hasShareToken && shareUrl ? (
              <div className="flex items-center gap-2 pl-6">
                <input
                  type="text"
                  value={shareUrl}
                  readOnly
                  className="flex-1 text-xs bg-sol-bg-alt border border-sol-border rounded px-2 py-1.5 text-sol-text-dim truncate"
                />
                <button
                  onClick={handleCopyLink}
                  className="shrink-0 px-2 py-1.5 text-xs bg-sol-cyan/20 hover:bg-sol-cyan/30 text-sol-cyan rounded transition-colors"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            ) : (
              <div className="pl-6 space-y-2">
                {isPrivate && (
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={alsoShareWithTeam}
                      onChange={(e) => setAlsoShareWithTeam(e.target.checked)}
                      className="w-3.5 h-3.5 rounded border-sol-border text-sol-green focus:ring-sol-green"
                    />
                    <span className="text-xs text-sol-text-secondary">Also share with team</span>
                  </label>
                )}
                <button
                  onClick={handleCreateLink}
                  disabled={isGeneratingLink}
                  className="px-3 py-1.5 text-xs bg-sol-bg-alt hover:bg-sol-border text-sol-text-secondary rounded transition-colors disabled:opacity-50"
                >
                  {isGeneratingLink ? "Creating..." : "Create link"}
                </button>
              </div>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
