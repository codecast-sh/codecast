"use client";
// The one button for the org surfaces (canvas panel, confirm popover, scope
// page): violet primary, bordered secondary, red for danger. One primary
// colour across the page, so cyan stays the "done" state and orange stays the
// anchor's identity. `quiet` is the outlined violet of a list where every row
// carries its own Accept (the proposal ledger, org-staffing.md S39): a frame
// keeps one filled button, so the rest read as outlines until the pointer or
// the keyboard lands on them.
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/utils";

// The ink is a variable so the dark theme can lift it toward the text colour
// and the hover fill still wins over it.
const QUIET = "border border-[color-mix(in_srgb,var(--sol-violet)_50%,transparent)] font-semibold [transition-duration:120ms] motion-reduce:transition-none [--ink:var(--sol-violet)] dark:[--ink:color-mix(in_srgb,var(--sol-violet)_68%,var(--sol-text))] text-[color:var(--ink)] hover:border-[var(--sol-violet)] hover:bg-[var(--sol-violet)] hover:text-[color:var(--sol-bg)] focus-visible:border-[var(--sol-violet)] focus-visible:bg-[var(--sol-violet)] focus-visible:text-[color:var(--sol-bg)] focus-visible:outline-none";

export const OrgButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  primary?: boolean;
  /** Outlined violet, no fill; fills on hover and on keyboard focus. */
  quiet?: boolean;
  danger?: boolean;
  size?: "sm" | "md";
  grow?: boolean;
  children: ReactNode;
}>(function OrgButton({ primary, quiet, danger, size = "md", grow, className, children, style, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-45 disabled:cursor-not-allowed",
        size === "sm" ? "h-7 px-2.5 text-[12px] rounded-md" : "h-[32px] px-3 text-[12.5px]",
        grow && "flex-1",
        quiet ? QUIET : primary ? "font-semibold hover:brightness-110" : danger ? "hover:bg-sol-red/10" : "hover:bg-sol-bg-highlight/70",
        className,
      )}
      style={quiet ? style : primary
        ? { background: "var(--sol-violet)", color: "var(--sol-bg)", ...style }
        : { border: "1px solid color-mix(in srgb, var(--sol-border) 40%, transparent)", color: danger ? "var(--sol-red)" : "var(--sol-text-muted)", ...style }}
      {...rest}
    >
      {children}
    </button>
  );
});
