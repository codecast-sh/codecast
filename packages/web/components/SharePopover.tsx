import { useState } from "react";
import { Forward, Link as LinkIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "./ui/tooltip";
import { copyToClipboard } from "../lib/utils";
import { openForwardToChat } from "../lib/forwardToChat";
import { useTeamFeature } from "../lib/teamFeatures";
import { toast } from "sonner";
import { SegmentedChoice, TeamShareModePicker, type SegmentedOption } from "./TeamShareModePicker";

interface SharePopoverProps {
  /** Open on mount: the page was reached by a link to its share control
   *  (a call's `?share=open`, from the room's thread). */
  defaultOpen?: boolean;
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
  /** Turns "anyone with the link" off; every copy of the tokened link dies. */
  onRevokeShareLink?: () => Promise<unknown>;
  /** The link that works for anyone: the page link carrying its token. */
  shareUrl: string | null;
  /** The page link, for signed-in people who can already see it. */
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
  /** What else the public link carries, decided per object (a call's video),
   *  shown under link access for whoever manages it. */
  linkExtra?: React.ReactNode;
  /** Why this viewer may close the public link but not open it (a call they
   *  were not in): the choice holds still and says who can, rather than
   *  failing on the press. */
  openRefusal?: string | null;
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

type LinkAccess = "restricted" | "anyone";

const ANYONE_ICON = "M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418";

const LINK_ACCESS: SegmentedOption<LinkAccess>[] = [
  {
    value: "restricted",
    label: "Restricted",
    selected: "bg-sol-bg text-sol-text",
    icon: "M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z",
  },
  {
    value: "anyone",
    label: "Anyone",
    selected: "bg-sol-cyan/15 text-sol-cyan",
    icon: ANYONE_ICON,
  },
];

export function SharePopover({
  isPrivate = false,
  teamVisibility,
  hasShareToken,
  hasTeam,
  teamId,
  onSetPrivate,
  onSetTeamVisibility,
  onGenerateShareLink,
  onRevokeShareLink,
  shareUrl,
  pageUrl,
  forwardUrl,
  forwardLabel,
  sharedVia,
  canManage = true,
  linkExtra,
  openRefusal,
  defaultOpen = false,
}: SharePopoverProps) {
  const chatOn = useTeamFeature("chat");
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [isUpdatingLink, setIsUpdatingLink] = useState(false);

  const currentMode: VisibilityMode = isPrivate ? "private" : (teamVisibility as VisibilityMode || "summary");
  const status = getShareStatus(isPrivate, teamVisibility, hasShareToken, hasTeam);

  // One link. Restricted, it is the page link: it opens for signed-in people
  // who can already see this. Open to anyone, it is the same page link
  // carrying the token, because an id alone grants nothing (issue #27).
  const linkAccess: LinkAccess = hasShareToken ? "anyone" : "restricted";
  const openBlocked = linkAccess === "restricted" && !!openRefusal;
  const link = (canManage && hasShareToken && shareUrl) || pageUrl || null;

  const setLinkAccess = async (next: LinkAccess) => {
    if (next === linkAccess) return;
    setIsUpdatingLink(true);
    try {
      if (next === "anyone") await onGenerateShareLink();
      else await onRevokeShareLink?.();
    } catch {
      toast.error("Couldn't change who can open the link");
    } finally {
      setIsUpdatingLink(false);
    }
  };

  const handleCopyLink = async () => {
    if (!link) return;
    setIsOpen(false);
    await copyToClipboard(link);
    toast.success("Link copied");
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
                {linkAccess === "anyone" ? (
                  // Open to anyone: the same globe as the "Anyone" choice, so
                  // the header says the session is public without opening this.
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d={ANYONE_ICON} />
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="18" cy="5" r="3" />
                    <circle cx="6" cy="12" r="3" />
                    <circle cx="18" cy="19" r="3" />
                    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                    <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                  </svg>
                )}
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
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-medium text-sol-text-muted">Link access</span>
                {isUpdatingLink && <span className="text-[11px] text-sol-text-dim">Saving…</span>}
              </div>
              <SegmentedChoice
                label="Who can open the link"
                options={LINK_ACCESS}
                value={linkAccess}
                onPick={setLinkAccess}
                disabled={isUpdatingLink || openBlocked || (linkAccess === "anyone" && !onRevokeShareLink)}
              />
              <p className="text-xs leading-snug text-sol-text-muted">
                {linkAccess === "anyone"
                  ? "Anyone with the link can view it, no sign in needed."
                  : openBlocked
                    ? `Only people who can already see it can open the link. ${openRefusal}`
                    : "Only people who can already see it can open the link."}
              </p>
              {linkExtra}
            </div>
          )}
        </div>

        {(link || (chatOn && (forwardUrl || pageUrl))) && (
          <div className="flex gap-2 border-t border-sol-border bg-sol-bg-alt/40 px-3.5 py-2.5">
            {link && (
              <button
                onClick={handleCopyLink}
                title={link}
                className="sol-btn-solid flex-1 inline-flex items-center justify-center gap-1.5 rounded-md bg-sol-cyan px-3 py-1.5 text-xs font-semibold text-sol-base03"
              >
                <LinkIcon className="w-3.5 h-3.5" />
                Copy link
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
