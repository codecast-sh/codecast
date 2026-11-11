"use client";

import { ArrowLeft } from "lucide-react";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { useBackTarget } from "../../hooks/useNavTrail";
import { cn } from "../../lib/utils";

// The Modern back control: the first thing in every page header and in the
// conversation header, naming where it goes ("← Tasks", "← Slack bot
// rebuild", "← Onboarding"). Along the trail when there is one, else up to
// the page's parent (hooks/useNavTrail). Nothing at all when there is
// nowhere to go: a section page opened cold has no way back to name.
//
// One key does the same (nav.back), shown in its tooltip.

export function BackControl({ fallback, className, compact = false, divider = false }: {
  /** The parent to go up to with no trail, when the page knows it better
   *  than its address does. */
  fallback?: { label: string; href: string } | null;
  className?: string;
  /** The arrow alone (the label in the tooltip), for a tight header. */
  compact?: boolean;
  /** A hairline after it, between the way back and the place (a page header). */
  divider?: boolean;
}) {
  const target = useBackTarget(fallback);
  if (!target) return null;
  const name = target.label || "previous page";
  return (
    <>
    <ShortcutTooltip label={`Back to ${name}`} action="nav.back">
      <button
        type="button"
        onClick={target.go}
        aria-label={`Back to ${name}`}
        data-cc-nav-back={target.fromTrail ? "trail" : "parent"}
        data-cc-nav-back-to={target.path}
        className={cn(
          "inline-flex h-control-sm min-w-0 max-w-[16rem] shrink-0 items-center gap-1 rounded-control px-1.5 text-ui font-medium text-sol-text-muted transition-colors hover:bg-sol-bg-alt hover:text-sol-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-cyan/60",
          compact ? "px-1" : "-ml-1.5",
          className,
        )}
      >
        <ArrowLeft className="size-3.5 shrink-0" aria-hidden />
        {!compact && <span className="min-w-0 truncate">{target.label}</span>}
      </button>
    </ShortcutTooltip>
    {divider && <span aria-hidden className="h-4 w-px shrink-0 bg-sol-border" />}
    </>
  );
}
