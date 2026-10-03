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

const keyOf = (area: string) => area.trim().toLowerCase();

const hashed = (key: string) => parseInt(hash64(["area", key]).slice(0, 8), 16) % PALETTE.length;

/** The colors a page hands its areas, by lowercased name (`assignAreaColors`). */
export type AreaColors = ReadonlyMap<string, string>;

/**
 * One variable per area on a page, so two areas side by side never share a
 * color while the palette lasts. Named areas keep their fixed variable. The
 * rest are walked by name, `first` before `rest`: each starts at its hashed
 * accent and takes the next one no area holds yet. Past seven accents an area
 * falls back to its plain hash. The same areas always give the same map.
 */
export function assignAreaColors(first: readonly string[], rest: readonly string[] = []): Map<string, string> {
  const sorted = (xs: readonly string[]) => [...new Set(xs.map(keyOf))].filter(Boolean).sort();
  const keys = [...new Set([...sorted(first), ...sorted(rest)])];
  const out = new Map<string, string>();
  for (const k of keys) if (NAMED[k]) out.set(k, NAMED[k]);
  const taken = new Set(out.values());
  for (const k of keys) {
    if (out.has(k)) continue;
    const start = hashed(k);
    const free = PALETTE.map((_, i) => PALETTE[(start + i) % PALETTE.length]).find((v) => !taken.has(v));
    out.set(k, free ?? PALETTE[start]);
    if (free) taken.add(free);
  }
  return out;
}

/** The css variable an area or surface wears: the page's assignment when it has one, else its name or hash. */
export function areaVar(area: string, colors?: AreaColors): string {
  const key = keyOf(area);
  return colors?.get(key) ?? NAMED[key] ?? PALETTE[hashed(key)];
}

/** The area's color as a css value. */
export function areaColor(area: string, colors?: AreaColors): string {
  return `var(${areaVar(area, colors)})`;
}

/** A soft fill of the area's color (spec 5.2: fills sit at 14%). */
export function areaFill(area: string, percent = 14, colors?: AreaColors): string {
  return `color-mix(in srgb, var(${areaVar(area, colors)}) ${percent}%, transparent)`;
}

/** An area's name as the page prints it: a dot folder (`.claude`) reads without its dot. */
export const areaLabel = (area: string) => area.replace(/^\.+/, "") || area;

/** Kind glyph colors (spec 4.5). Kinds without a glyph are absent. */
export const KIND_COLOR: Partial<Record<string, string>> = {
  feature: "var(--sol-green)",
  fix: "var(--sol-orange)",
  perf: "var(--sol-cyan)",
  revert: "var(--sol-red)",
};

/** Risk is a texture, never a fill (spec 5.2). Defined once on `.chg-root` in globals.css, with its light theme strength. */
export const RISK_HATCH = "var(--chg-risk-hatch)";

/** The release stamp's pill border. */
export const RELEASE_COLOR = "var(--sol-green)";

/** The Stuck group's rule. */
export const STUCK_RULE = "color-mix(in srgb, var(--sol-red) 80%, transparent)";

/** Ink for the day cells and the double rule: one hue, opacity carries the amount. */
export function ink(percent: number): string {
  return `color-mix(in srgb, var(--sol-text) ${Math.round(percent)}%, transparent)`;
}
