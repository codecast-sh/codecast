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
 * override drop the default `min-h-screen`. This is the single loader for any
 * full-page holding state — don't hand-roll `<div>Loading...</div>` fallbacks.
 */
export function AppLoader({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "min-h-screen flex flex-col items-center justify-center gap-5 bg-sol-bg text-sol-text-dim",
        className,
      )}
      role="status"
      aria-label="Loading"
    >
      <LogoMark size={44} monochrome className="opacity-45" />
      <div className="app-loader-bar" />
    </div>
  );
}
