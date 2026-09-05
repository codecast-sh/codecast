import { useState } from "react";
import { X } from "lucide-react";
import { useMountEffect } from "../hooks/useMountEffect";
import { useStatusNoticeStore, type StatusNotice } from "../hooks/useStatusNotice";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

const TONE_COLOR: Record<StatusNotice["tone"], string> = {
  yellow: "var(--sol-yellow)",
  orange: "var(--sol-orange)",
  red: "var(--sol-red)",
};
const TONE_RANK: Record<StatusNotice["tone"], number> = { yellow: 0, orange: 1, red: 2 };

/**
 * Header home for transient status notices (see useStatusNotice): offline,
 * storage degraded, CLI offline, tmux missing. Sits beside the sync and
 * daemon chips and follows their rule — a fixed slot in every state, so the
 * header never reflows and nothing is covered when a notice comes or goes.
 * Quiet: the slot is empty. Active: the most severe notice's icon lights in
 * its tone with a pulse ring; hovering opens a panel with every notice, its
 * detail, its inline action (copy a command) and its dismiss.
 */
export function StatusNoticeChip() {
  const notices = useStatusNoticeStore((s) => s.notices);
  // Paint only once mounted so SSR markup and the first client render agree;
  // the slot itself always renders.
  const [mounted, setMounted] = useState(false);
  useMountEffect(() => setMounted(true));

  const list = mounted ? [...notices.values()] : [];
  const lead = list.reduce<StatusNotice | null>(
    (best, n) => (!best || TONE_RANK[n.tone] > TONE_RANK[best.tone] ? n : best),
    null,
  );
  const color = lead ? TONE_COLOR[lead.tone] : undefined;
  const Icon = lead?.icon;

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="relative flex h-7 w-5 flex-shrink-0 items-center justify-center rounded cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-cyan"
            aria-label={lead ? `Status: ${lead.title}` : "Status: all good"}
            aria-hidden={!lead}
            tabIndex={lead ? 0 : -1}
          >
            {lead && Icon && (
              <span aria-hidden="true" className="relative flex items-center justify-center">
                <span
                  className="animate-ping absolute inline-flex h-3 w-3 rounded-full opacity-30"
                  style={{ background: color }}
                />
                <Icon className="relative h-3.5 w-3.5" style={{ color }} />
              </span>
            )}
          </button>
        </TooltipTrigger>
        {lead && (
          <TooltipContent
            side="bottom"
            align="end"
            sideOffset={6}
            collisionPadding={8}
            className="w-[340px] max-w-[calc(100vw-16px)] border bg-popover p-0 text-popover-foreground shadow-md"
          >
            <div className="divide-y divide-sol-border">
              {[...notices].map(([id, n]) => (
                <NoticeRow key={id} {...n} />
              ))}
            </div>
          </TooltipContent>
        )}
      </Tooltip>
    </TooltipProvider>
  );
}

function NoticeRow({ tone, icon: Icon, title, detail, action, onDismiss }: StatusNotice) {
  const color = TONE_COLOR[tone];
  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5">
      <Icon className="mt-0.5 h-4 w-4 flex-shrink-0" style={{ color }} />
      <div className="min-w-0 flex-1 text-sm leading-snug text-sol-text">
        <div>{title}</div>
        {detail && <div className="mt-0.5 text-xs text-sol-text-dim">{detail}</div>}
        {action && <div className="mt-1.5">{action}</div>}
      </div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="-mr-1 p-1 rounded-md text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt transition-colors flex-shrink-0"
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
