"use client";

// The top bar's icon controls, one treatment: a 28px square, an 18px glyph,
// quiet until hovered, cyan while its surface is open. Every control in the
// header row (sidebar toggles, new session, anchor, bell, theme, user menu,
// terminal, comments) renders through this so the row reads as one set —
// before it, each had its own padding, radius, icon size and hover.

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
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
        "relative h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors [&>svg]:h-[18px] [&>svg]:w-[18px] [&>svg]:[stroke-width:1.75]",
        active ? "bg-sol-cyan/10 text-sol-cyan" : "text-sol-text-muted hover:bg-sol-bg-alt hover:text-sol-text",
        className,
      )}
    />
  );
});

/**
 * The top bar's status chips (model usage, daemon, running agents), one
 * treatment: a 24px capsule that sits inside the status tray, neutral at
 * rest, with the state carried by its dot. Only `alert` (something is wrong
 * right now) tints the fill and the text in `tone`. Before it, each chip drew
 * its own tinted fill, border and glow, and four of them side by side read as
 * four alarms.
 */
export const TopbarChip = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { tone?: string; alert?: boolean }
>(function TopbarChip({ tone, alert, className, style, ...props }, ref) {
  const tinted = alert && tone;
  return (
    <button
      ref={ref}
      type="button"
      {...props}
      data-topbar-chip={tinted ? "alert" : ""}
      className={cn(
        "flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11px] font-medium tabular-nums select-none transition-colors",
        tinted ? "hover:brightness-110" : "text-sol-text-muted hover:bg-sol-bg-highlight hover:text-sol-text",
        className,
      )}
      style={tinted ? { background: `color-mix(in srgb, ${tone} 14%, transparent)`, color: tone, ...style } : style}
    />
  );
});

/** The tray the status chips sit in: one outlined capsule for the whole group. */
export function TopbarTray({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-cc-topbar-tray
      className={cn(
        "hidden md:has-[*]:flex h-7 shrink-0 items-center gap-0.5 rounded-full border border-sol-border/70 bg-sol-bg-alt/40 p-px",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A hairline between groups of top bar controls. */
export function TopbarDivider() {
  return <div aria-hidden className="hidden md:block h-4 w-px shrink-0 bg-sol-border" />;
}
