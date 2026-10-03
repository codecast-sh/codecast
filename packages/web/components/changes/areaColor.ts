// The one source of color on the Changes page (docs/proposals/changes-page.md
// 5.2). Every value is a `var(--sol-*)` string, so the minimal and graphite
// themes repaint it; the page never uses Tailwind's accent classes, which are
// hardcoded Solarized hex. Areas and surfaces share this map, so `cli` the area
// and `cli` the surface wear one color.
import { hash64 } from "@codecast/shared/changes";

const NAMED: Record<string, string> = {
  web: "--sol-blue",
  cli: "--sol-green",
  convex: "--sol-violet",
  backend: "--sol-violet",
  desktop: "--sol-cyan",
  electron: "--sol-cyan",
  mobile: "--sol-magenta",
  shared: "--sol-orange",
  docs: "--sol-text-dim",
  extension: "--sol-yellow",
  "chrome-extension": "--sol-yellow",
  "browser-extension": "--sol-yellow",
};

/** Accents an unnamed area draws from, by a stable hash of its name. */
const PALETTE = ["--sol-blue", "--sol-cyan", "--sol-green", "--sol-violet", "--sol-magenta", "--sol-orange", "--sol-yellow"];

/** The css variable an area or surface wears. */
export function areaVar(area: string): string {
  const key = area.trim().toLowerCase();
  const named = NAMED[key];
  if (named) return named;
  return PALETTE[parseInt(hash64(["area", key]).slice(0, 8), 16) % PALETTE.length];
}

/** The area's color as a css value. */
export function areaColor(area: string): string {
  return `var(${areaVar(area)})`;
}

/** A soft fill of the area's color (spec 5.2: fills sit at 14%). */
export function areaFill(area: string, percent = 14): string {
  return `color-mix(in srgb, var(${areaVar(area)}) ${percent}%, transparent)`;
}

/** Kind glyph colors (spec 4.5). Kinds without a glyph are absent. */
export const KIND_COLOR: Partial<Record<string, string>> = {
  feature: "var(--sol-green)",
  fix: "var(--sol-orange)",
  perf: "var(--sol-cyan)",
  revert: "var(--sol-red)",
};

/** Risk is a texture, never a fill (spec 5.2). */
export const RISK_HATCH =
  "repeating-linear-gradient(135deg, color-mix(in srgb, var(--sol-red) 22%, transparent) 0 2px, transparent 2px 6px)";

/** The release stamp's pill border. */
export const RELEASE_COLOR = "var(--sol-green)";

/** The Stuck group's rule. */
export const STUCK_RULE = "color-mix(in srgb, var(--sol-red) 80%, transparent)";

/** Ink for the day cells and the double rule: one hue, opacity carries the amount. */
export function ink(percent: number): string {
  return `color-mix(in srgb, var(--sol-text) ${Math.round(percent)}%, transparent)`;
}
