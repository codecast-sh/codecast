import { LogoMark } from "./Logo";
import { cn } from "../lib/utils";

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
 */
export function AppLoader({
  className,
  size = 44,
  label,
}: {
  className?: string;
  size?: number;
  label?: string;
}) {
  return (
    <div
      className={cn(
        "min-h-screen flex flex-col items-center justify-center gap-5 bg-sol-bg text-sol-text-dim",
        className,
      )}
      role="status"
      aria-label={label ?? "Loading"}
    >
      <LogoMark size={size} monochrome className="opacity-45" />
      <div className="app-loader-bar" />
      {label && <div className="text-sm text-sol-text-dim">{label}</div>}
    </div>
  );
}
