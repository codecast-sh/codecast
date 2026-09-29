import { useState } from "react";
import { Check, Forward, Globe, Link as LinkIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "./ui/tooltip";
import { copyToClipboard } from "../lib/utils";
import { openForwardToChat } from "../lib/forwardToChat";
import { useTeamFeature } from "../lib/teamFeatures";
import { toast } from "sonner";
import { TeamShareModePicker } from "./TeamShareModePicker";

interface SharePopoverProps {
  isPrivate?: boolean;
  teamVisibility?: string | null;
  hasShareToken: boolean;
  hasTeam: boolean;
  /** The team this session is shared with: lets the popover offer "share all
   *  new sessions in full" right after this one was shared in full. */
  teamId?: string | null;
  onSetPrivate?: () => void | Promise<void>;
  onSetTeamVisibility?: (mode: "summary" | "full") => void | Promise<void>;
  onGenerateShareLink: () => Promise<string>;
  shareUrl: string | null;
  /** Internal, auth-required page URL. When provided, the footer offers "Copy link" for it. */
  pageUrl?: string;
  /** Link a forward-to-chat sends; defaults to pageUrl. */
  forwardUrl?: string;
  /** What the forwarded thing is, for the picker title (e.g. "session"). */
  forwardLabel?: string;
  /** The directory whose team mapping shared this session, when a mapping
   *  did: the popover then says why it is shared and where to change that. */
  sharedVia?: string | null;
  /** False for a viewer who cannot change how this is shared: the popover
   *  then offers only the page link and send to chat. */
  canManage?: boolean;
}

type VisibilityMode = "private" | "summary" | "full";

function getShareStatus(isPrivate: boolean, teamVisibility: string | null | undefined, hasShareToken: boolean, hasTeam: boolean): {
  label: string;
  color: string;
} {
  const isTeamShared = hasTeam && !isPrivate;
  const mode = isPrivate ? "private" : (teamVisibility || "summary");

  if (!isTeamShared && !hasShareToken) {
    return { label: "", color: "text-sol-text-dim" };
  }
  if (isTeamShared && !hasShareToken) {
    return { label: "Team", color: mode === "full" ? "text-emerald-500" : "text-teal-500" };
  }
  if (!isTeamShared && hasShareToken) {
    return { label: "Link", color: "text-sol-cyan" };
  }
  return { label: "Team + Link", color: "text-sol-cyan" };
}

function LinkField({ url, copied, onCopy }: { url: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="flex items-center rounded-md border border-sol-border bg-sol-bg-alt pl-2 focus-within:border-sol-cyan/60">
      <input
        type="text"
        value={url}
        readOnly
        onFocus={(e) => e.currentTarget.select()}
        className="min-w-0 flex-1 bg-transparent py-1.5 text-xs text-sol-text-muted outline-none truncate"
      />
      <button
        onClick={onCopy}
        className="shrink-0 inline-flex items-center gap-1 px-2 py-1.5 text-xs font-medium text-sol-cyan hover:text-sol-text transition-colors"
      >
        {copied ? <Check className="w-3.5 h-3.5" /> : null}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function SharePopover({
  isPrivate = false,
  teamVisibility,
  hasShareToken,
  hasTeam,
  teamId,
  onSetPrivate,
  onSetTeamVisibility,
  onGenerateShareLink,
  shareUrl,
  pageUrl,
  forwardUrl,
  forwardLabel,
  sharedVia,
  canManage = true,
}: SharePopoverProps) {
  const chatOn = useTeamFeature("chat");
  const [isOpen, setIsOpen] = useState(false);
  const [isGeneratingLink, setIsGeneratingLink] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pageCopied, setPageCopied] = useState(false);

  const currentMode: VisibilityMode = isPrivate ? "private" : (teamVisibility as VisibilityMode || "summary");
  const status = getShareStatus(isPrivate, teamVisibility, hasShareToken, hasTeam);

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

  const handleCopyPageLink = async () => {
    if (!pageUrl) return;
    await copyToClipboard(pageUrl);
    setPageCopied(true);
    toast.success("Link copied");
    setTimeout(() => setPageCopied(false), 2000);
  };

  const tooltipLabel = canManage ? (status.label || "Share settings") : "Share";

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <TooltipProvider>
        <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <PopoverTrigger asChild>
              <button
                className={`p-1 rounded hover:bg-sol-bg-alt transition-colors ${status.label ? status.color : "text-sol-text-dim hover:text-sol-text-secondary"}`}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="18" cy="5" r="3" />
                  <circle cx="6" cy="12" r="3" />
                  <circle cx="18" cy="19" r="3" />
                  <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                  <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                </svg>
              </button>
            </PopoverTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{tooltipLabel}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent
        align="end"
        className="w-80 bg-sol-bg border-sol-border p-0 overflow-hidden"
        // Radix focuses the first control on open, which paints a focus ring on
        // "Hidden" beside the real selection. Focus the panel itself instead.
        onOpenAutoFocus={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement | null)?.focus?.(); }}
        tabIndex={-1}
      >
        <div className="px-3.5 pt-3 pb-1">
          <h3 className="text-sm font-semibold text-sol-text">Share{forwardLabel ? ` ${forwardLabel}` : ""}</h3>
        </div>

        <div className="px-3.5 pb-3.5 pt-2 space-y-3.5 [&>*+*]:border-t [&>*+*]:border-sol-border/60 [&>*+*]:pt-3.5">
          {canManage && hasTeam && (
            <TeamShareModePicker
              mode={currentMode}
              onChange={(mode) => (mode === "private" ? onSetPrivate?.() : onSetTeamVisibility?.(mode))}
              teamId={teamId}
              sharedVia={sharedVia}
              onNavigate={() => setIsOpen(false)}
            />
          )}

          {canManage && (
            <div className="space-y-2">
              <div className="flex items-center gap-2.5">
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${hasShareToken ? "bg-sol-cyan/15 text-sol-cyan" : "bg-sol-bg-alt text-sol-text-dim"}`}>
                  <Globe className="w-3.5 h-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium text-sol-text">Public link</div>
                  <div className="text-[11px] leading-snug text-sol-text-dim">
                    {hasShareToken ? "Anyone with this link can view it" : "Let anyone view it, no sign in needed"}
                  </div>
                </div>
                {!(hasShareToken && shareUrl) && (
                  <button
                    onClick={handleCreateLink}
                    disabled={isGeneratingLink}
                    className="shrink-0 rounded-md border border-sol-border px-2.5 py-1 text-xs text-sol-text-secondary hover:bg-sol-bg-alt hover:text-sol-text transition-colors disabled:opacity-50"
                  >
                    {isGeneratingLink ? "Creating…" : "Create link"}
                  </button>
                )}
              </div>
              {hasShareToken && shareUrl && (
                <LinkField url={shareUrl} copied={copied} onCopy={handleCopyLink} />
              )}
            </div>
          )}
        </div>

        {(pageUrl || (chatOn && (forwardUrl || pageUrl))) && (
          <div className="flex gap-2 border-t border-sol-border bg-sol-bg-alt/40 px-3.5 py-2.5">
            {pageUrl && (
              <button
                onClick={handleCopyPageLink}
                title={`${pageUrl}\nOpens for anyone signed in who can see it`}
                className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md bg-sol-cyan px-3 py-1.5 text-xs font-semibold text-sol-base03 hover:brightness-110 transition-colors"
              >
                {pageCopied ? <Check className="w-3.5 h-3.5" /> : <LinkIcon className="w-3.5 h-3.5" />}
                {pageCopied ? "Copied" : "Copy link"}
              </button>
            )}
            {chatOn && (forwardUrl || pageUrl) && (
              <button
                onClick={() => {
                  setIsOpen(false);
                  openForwardToChat({ url: (forwardUrl || pageUrl)!, label: forwardLabel });
                }}
                className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md border border-sol-border px-3 py-1.5 text-xs font-medium text-sol-text-secondary hover:bg-sol-bg-alt hover:text-sol-text transition-colors"
              >
                <Forward className="w-3.5 h-3.5" />
                Send to chat
              </button>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
