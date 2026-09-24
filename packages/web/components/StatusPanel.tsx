"use client";

// The hover panel behind a top bar status chip (sync LED, daemon pill): a
// kicker naming the surface, a headline led by the chip's own colour, and
// sections divided by hairlines. One markup so every status panel in the
// header reads as one family, whichever chip opened it.

import type { ReactNode } from "react";
import { cn } from "../lib/utils";

export function StatusPanelHeader({
  kicker,
  color,
  headline,
  sub,
  aside,
}: {
  kicker: string;
  color: string;
  headline: ReactNode;
  /** A dim line under the headline: the machine a daemon runs on, a scope. */
  sub?: ReactNode;
  /** Right-aligned detail on the headline row: a counter, a timestamp. */
  aside?: ReactNode;
}) {
  return (
    <div className="px-3 pt-2 pb-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-sol-text-dim">{kicker}</div>
      <div className="flex items-center gap-2 pt-1">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
        <span className="min-w-0 truncate text-xs font-semibold text-sol-text">{headline}</span>
        {aside && <span className="ml-auto shrink-0 tabular-nums text-[11px] font-normal text-sol-text-dim">{aside}</span>}
      </div>
      {sub && <div className="truncate pl-3.5 text-[11px] text-sol-text-dim">{sub}</div>}
    </div>
  );
}

export function StatusPanelSection({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("border-t border-sol-border/60 px-3 py-2", className)}>{children}</div>;
}
