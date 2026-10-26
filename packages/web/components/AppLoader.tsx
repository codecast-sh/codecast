import { useState } from "react";
import { LogoMark } from "./Logo";
import { useMountEffect } from "../hooks/useMountEffect";
import { cn } from "../lib/utils";
import { hostedBoot } from "./simple/laneBoot";

/**
 * Holding state for app boot / auth gates and full-page route/data loads:
 * monochrome mark over a thin shimmer bar. The default full-screen form must
 * stay pixel-identical to the pre-React #boot-shell in index.html (same colors,
 * geometry, and animation) so the static → React handoff is invisible — change
 * them together.
 *
 * Pass `className` to fill a bounded container instead of the viewport (e.g.
 * `className="min-h-0 h-full"` inside DashboardLayout). twMerge lets the
 * override drop the default `min-h-screen` (and `bg-sol-bg` via
 * `bg-transparent` when embedding in a card). `size` shrinks the mark for
 * panel/popover-scale containers; `label` adds a dim status line under the
 * bar for states with meaningful copy ("Redirecting to GitHub..."). This is
 * the single loader for any holding state — don't hand-roll
 * `<div>Loading...</div>` fallbacks or spinner SVGs.
 *
 * On a hosted boot (/welcome, or an app page on a device last seen in hosted
 * mode) it takes the hosted form instead: the family paper and the
 * assistant's solid disc over the same bar, styled beside #boot-shell in
 * index.html, so a hosted person never sees the developer splash.
 */
export function AppLoader({
  className,
  size = 44,
  label,
  deferIndicator = false,
}: {
  className?: string;
  size?: number;
  label?: string;
  deferIndicator?: boolean;
}) {
  const hosted = hostedBoot();
  return (
    <div
      className={cn(
        "app-loader min-h-screen flex flex-col items-center justify-center gap-5 bg-sol-bg text-sol-text-dim",
        className,
      )}
      data-hosted={hosted ? "" : undefined}
      role="status"
      aria-label={label ?? "Loading"}
    >
      <div className={cn("flex flex-col items-center gap-5", deferIndicator && "app-loader-indicator-delayed")}>
        {hosted ? (
          <span className="hosted-orb" aria-hidden><LogoMark size={28} monochrome /></span>
        ) : (
          <LogoMark size={size} monochrome className="opacity-45" />
        )}
        <div className="app-loader-bar" />
      </div>
      {label && <div className="text-sm text-sol-text-dim">{label}</div>}
    </div>
  );
}

/** How long a boot may sit on the mark before it says so. */
const SLOW_BOOT_MS = 8_000;

/**
 * Said under the boot loader once a cold load has run long (a slow device,
 * a busy machine, a large cache, offline): its state and two ways out, so a
 * loader that will not finish never reads as a dead site. Fixed below the
 * mark, so the loader itself does not move. The markup, styles and button
 * behavior are the static #boot-shell's `.boot-stuck` in index.html (which
 * covers a bundle that never runs), so both look and act the same.
 */
export function SlowBootNote() {
  const [slow, setSlow] = useState(false);
  useMountEffect(() => {
    const t = window.setTimeout(() => setSlow(true), SLOW_BOOT_MS);
    return () => window.clearTimeout(t);
  });
  if (!slow) return null;
  return (
    <div className="boot-stuck text-sol-text-dim" data-slow-boot>
      <span className="state">
        <span className="state-slow">Taking longer than usual</span>
        <span className="state-offline">Offline · reloads when back</span>
      </span>
      <div className="actions">
        <button type="button" className="primary" data-boot-action="reload">Reload</button>
        <button type="button" data-boot-action="clear">Clear cache &amp; reload</button>
      </div>
    </div>
  );
}
