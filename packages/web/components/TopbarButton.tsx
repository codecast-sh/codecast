"use client";

// The top bar's icon controls, one treatment: a 28px square, an 18px glyph,
// quiet until hovered, cyan while its surface is open. Every control in the
// header row (sidebar toggles, new session, anchor, bell, theme, user menu,
// terminal, comments) renders through this so the row reads as one set —
// before it, each had its own padding, radius, icon size and hover.

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../lib/utils";

export const TopbarButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    /** The surface this control opens is showing. */
    active?: boolean;
    /** Hidden below the md breakpoint (the mobile header keeps only the essentials). */
    desktopOnly?: boolean;
  }
>(function TopbarButton({ active, desktopOnly, className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      {...props}
      className={cn(
        desktopOnly ? "hidden md:flex" : "flex",
        "relative h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors [&>svg]:h-[18px] [&>svg]:w-[18px]",
        active ? "bg-sol-cyan/10 text-sol-cyan" : "text-sol-text-muted hover:bg-sol-bg-alt hover:text-sol-text",
        className,
      )}
    />
  );
});

/** A hairline between groups of top bar controls. */
export function TopbarDivider() {
  return <div aria-hidden className="hidden md:block h-4 w-px shrink-0 bg-sol-border" />;
}
