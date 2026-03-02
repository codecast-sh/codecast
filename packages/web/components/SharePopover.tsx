"use client";

import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { copyToClipboard } from "../lib/utils";
import { toast } from "sonner";

interface SharePopoverProps {
  isPrivate: boolean;
  teamVisibility?: string | null;
  hasShareToken: boolean;
  hasTeam: boolean;
  onSetPrivate: () => Promise<void>;
  onSetTeamVisibility: (mode: "summary" | "full") => Promise<void>;
  onGenerateShareLink: () => Promise<string>;
  shareUrl: string | null;
}

type VisibilityMode = "private" | "summary" | "full";

function getShareStatus(isPrivate: boolean, teamVisibility: string | null | undefined, hasShareToken: boolean, hasTeam: boolean): {
  label: string;
  color: string;
} {
  const isTeamShared = hasTeam && !isPrivate;
  const mode = isPrivate ? "private" : (teamVisibility || "summary");

  if (!isTeamShared && !hasShareToken) {
    return { label: "Private", color: "text-sol-text-dim" };
  }
  if (isTeamShared && !hasShareToken) {
    return { label: "Team", color: mode === "full" ? "text-emerald-500" : "text-teal-500" };
  }
  if (!isTeamShared && hasShareToken) {
    return { label: "Link", color: "text-sol-cyan" };
  }
  return { label: "Team + Link", color: "text-sol-cyan" };
}

export function SharePopover({
  isPrivate,
  teamVisibility,
  hasShareToken,
  hasTeam,
  onSetPrivate,
  onSetTeamVisibility,
  onGenerateShareLink,
  shareUrl,
}: SharePopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isGeneratingLink, setIsGeneratingLink] = useState(false);
  const [copied, setCopied] = useState(false);

  const currentMode: VisibilityMode = isPrivate ? "private" : (teamVisibility as VisibilityMode || "summary");
  const status = getShareStatus(isPrivate, teamVisibility, hasShareToken, hasTeam);

  const handleSetMode = async (mode: VisibilityMode) => {
    if (mode === currentMode) return;
    setIsUpdating(true);
    try {
      if (mode === "private") {
        await onSetPrivate();
      } else {
        await onSetTeamVisibility(mode);
      }
    } finally {
      setIsUpdating(false);
    }
  };

  const handleCopyLink = async () => {
    let url = shareUrl;
    if (!url) {
      setIsGeneratingLink(true);
      try {
        url = await onGenerateShareLink();
      } finally {
        setIsGeneratingLink(false);
      }
    }
    if (url) {
      await copyToClipboard(url);
      setCopied(true);
      toast.success("Link copied");
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleCreateLink = async () => {
    setIsGeneratingLink(true);
    try {
      const url = await onGenerateShareLink();
      await copyToClipboard(url);
      toast.success("Link copied");
    } finally {
      setIsGeneratingLink(false);
    }
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          className="flex items-center gap-1 sm:gap-1.5 px-1.5 sm:px-2 py-1 rounded hover:bg-sol-bg-alt transition-colors text-xs"
          title="Share settings"
        >
          <svg className="w-3.5 h-3.5 text-sol-text-dim" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
          </svg>
          <span className={`hidden sm:inline ${status.color}`}>{status.label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-72 bg-sol-bg border-sol-border p-0"
      >
        <div className="p-3 border-b border-sol-border">
          <h3 className="text-sm font-medium text-sol-text">Sharing</h3>
        </div>

        <div className="p-3 space-y-3">
          {hasTeam && (
            <div className="space-y-2">
              <span className="text-xs font-medium text-sol-text-dim uppercase tracking-wide">Team</span>
              <div className="flex rounded-lg border border-sol-border overflow-hidden">
                <button
                  onClick={() => handleSetMode("private")}
                  disabled={isUpdating}
                  className={`flex-1 px-3 py-2 text-xs font-medium transition-colors flex items-center justify-center gap-1.5 ${
                    currentMode === "private"
                      ? "bg-sol-base02/50 text-sol-text"
                      : "bg-sol-bg text-sol-text-muted hover:bg-sol-bg-alt"
                  }`}
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
                  </svg>
                  Hidden
                </button>
                <button
                  onClick={() => handleSetMode("summary")}
                  disabled={isUpdating}
                  className={`flex-1 px-3 py-2 text-xs font-medium transition-colors border-l border-r border-sol-border flex items-center justify-center gap-1.5 ${
                    currentMode === "summary"
                      ? "bg-teal-500/15 text-teal-600 dark:text-teal-400"
                      : "bg-sol-bg text-sol-text-muted hover:bg-sol-bg-alt"
                  }`}
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
                  </svg>
                  Summary
                </button>
                <button
                  onClick={() => handleSetMode("full")}
                  disabled={isUpdating}
                  className={`flex-1 px-3 py-2 text-xs font-medium transition-colors flex items-center justify-center gap-1.5 ${
                    currentMode === "full"
                      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      : "bg-sol-bg text-sol-text-muted hover:bg-sol-bg-alt"
                  }`}
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  Full
                </button>
              </div>
              <p className="text-[11px] text-sol-text-dim">
                {currentMode === "private" && "Hidden from team members"}
                {currentMode === "summary" && "Team sees title and activity summary"}
                {currentMode === "full" && "Team can view the full conversation"}
              </p>
            </div>
          )}

          <div className="space-y-2">
            <span className="text-xs font-medium text-sol-text-dim uppercase tracking-wide">Link</span>

            {hasShareToken && shareUrl ? (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
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
                <p className="text-[11px] text-sol-text-dim">Anyone with this link can view</p>
              </div>
            ) : (
              <div className="space-y-1.5">
                <p className="text-[11px] text-sol-text-dim">Create a link anyone can use to view this conversation</p>
                <button
                  onClick={handleCreateLink}
                  disabled={isGeneratingLink}
                  className="px-3 py-1.5 text-xs bg-sol-bg-alt hover:bg-sol-border text-sol-text-secondary rounded transition-colors disabled:opacity-50"
                >
                  {isGeneratingLink ? "Creating..." : "Create & copy link"}
                </button>
              </div>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
