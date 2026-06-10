import { LogoMark } from "./Logo";

/**
 * Full-screen holding state for app boot / auth gates: monochrome mark over a
 * thin shimmer bar. Must stay pixel-identical to the pre-React #boot-shell in
 * index.html (same colors, geometry, and animation) so the static → React
 * handoff is invisible — change them together.
 */
export function AppLoader() {
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center gap-5 bg-sol-bg text-sol-text-dim"
      role="status"
      aria-label="Loading"
    >
      <LogoMark size={44} monochrome className="opacity-45" />
      <div className="app-loader-bar" />
    </div>
  );
}
