"use client";
// The one button for the org surfaces (canvas panel, confirm popover, scope
// page): violet primary, bordered secondary, red for danger. One primary
// colour across the page, so cyan stays the "done" state and orange stays the
// anchor's identity.
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/utils";

export const OrgButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  primary?: boolean;
  danger?: boolean;
  size?: "sm" | "md";
  grow?: boolean;
  children: ReactNode;
}>(function OrgButton({ primary, danger, size = "md", grow, className, children, style, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-45 disabled:cursor-not-allowed",
        size === "sm" ? "h-7 px-2.5 text-[12px] rounded-md" : "h-[32px] px-3 text-[12.5px]",
        grow && "flex-1",
        primary ? "font-semibold hover:brightness-110" : danger ? "hover:bg-sol-red/10" : "hover:bg-sol-bg-highlight/70",
        className,
      )}
      style={primary
        ? { background: "var(--sol-violet)", color: "var(--sol-bg)", ...style }
        : { border: "1px solid color-mix(in srgb, var(--sol-border) 40%, transparent)", color: danger ? "var(--sol-red)" : "var(--sol-text-muted)", ...style }}
      {...rest}
    >
      {children}
    </button>
  );
});
