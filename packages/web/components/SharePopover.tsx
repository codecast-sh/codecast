import { useState } from "react";
import { Forward } from "lucide-react";
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
  /** Internal, auth-required page URL. When provided, a "Page link" row is shown above the public link. */
  pageUrl?: string;
  /** Link a forward-to-chat sends; defaults to pageUrl. */
  forwardUrl?: string;
  /** What the forwarded thing is, for the picker title (e.g. "session"). */
  forwardLabel?: string;
  /** The directory whose team mapping shared this session, when a mapping
   *  did: the popover then says why it is shared and where to change that. */
  sharedVia?: string | null;
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

  const tooltipLabel = status.label || "Share settings";

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
        className="w-72 bg-sol-bg border-sol-border p-0"
      >
        <div className="p-3 border-b border-sol-border">
          <h3 className="text-sm font-medium text-sol-text">Sharing</h3>
        </div>

        <div className="p-3 space-y-3">
          {hasTeam && (
            <TeamShareModePicker
              mode={currentMode}
              onChange={(mode) => (mode === "private" ? onSetPrivate?.() : onSetTeamVisibility?.(mode))}
              teamId={teamId}
              sharedVia={sharedVia}
              onNavigate={() => setIsOpen(false)}
            />
          )}

          {pageUrl && (
            <div className="space-y-1.5">
              <span className="text-xs font-medium text-sol-text-dim uppercase tracking-wide">Page link</span>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={pageUrl}
                  readOnly
                  className="flex-1 text-xs bg-sol-bg-alt border border-sol-border rounded px-2 py-1.5 text-sol-text-dim truncate"
                />
                <button
                  onClick={handleCopyPageLink}
                  className="shrink-0 px-2 py-1.5 text-xs bg-sol-cyan/20 hover:bg-sol-cyan/30 text-sol-cyan rounded transition-colors"
                >
                  {pageCopied ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="text-[11px] text-sol-text-dim">Teammates with access can open</p>
            </div>
          )}

          <div className="space-y-2">
            <span className="text-xs font-medium text-sol-text-dim uppercase tracking-wide">{pageUrl ? "Public link" : "Link"}</span>

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
                <p className="text-[11px] text-sol-text-dim">Create a link anyone can open without signing in</p>
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

          {chatOn && (forwardUrl || pageUrl) && (
            <button
              onClick={() => {
                setIsOpen(false);
                openForwardToChat({ url: (forwardUrl || pageUrl)!, label: forwardLabel });
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs bg-sol-bg-alt hover:bg-sol-border text-sol-text-secondary rounded transition-colors"
            >
              <Forward className="w-3.5 h-3.5" />
              Send to chat…
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
