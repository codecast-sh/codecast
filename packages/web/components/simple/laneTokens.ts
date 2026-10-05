// The lane's colour names (plan pl-840), one per meaning, each defined once
// over the family palette (@platform/design). simple.css declares them as
// --sl-* custom properties and the phone lane (packages/mobile laneTheme.ts)
// computes them as hex from this same table, so a colour tweak reaches both.
// laneTokens.test.ts fails when simple.css's declarations and this table
// disagree, or when a rule repeats a token's mix inline. The phone imports
// this file, so it stays free of the router and the DOM.
import type { Palette } from "@platform/design";

type Base = keyof Palette;

/** A token is a palette colour, or `color-mix(in srgb, base pct%, other)`. */
export type LaneToken = Base | readonly [base: Base, pct: number, other: Base | "transparent"];

export const LANE_TOKENS = {
  paper: "bg",
  sheet: "bgRaised",
  sheet2: "bgSunken",
  hover: "bgHover",
  ink: "ink",
  ink2: ["ink", 62, "inkMuted"],
  soft: "inkMuted",
  faint: "inkFaint",
  line: "rule",
  lineStrong: "ruleStrong",
  // What needs the person, and the yes.
  accent: "accent",
  accentPressed: ["accent", 88, "ink"],
  accentWash: "accentSoft",
  accentLine: ["accent", 38, "transparent"],
  // The accent as words on paper (an approval's label, a routine in trouble).
  accentText: ["accent", 82, "ink"],
  // Text on a solid fill (the accent, or done green).
  onSolid: "accentInk",
  // The assistant at work: dots, a running step, the meter. Quiet ink.
  working: "inkMuted",
  // Ornament that reads without competing: checks, the current tab, links.
  mark: "ink",
  // A neutral wash: focus rings, the current plan, quiet chips, the track.
  wash: ["ink", 7, "transparent"],
  // The calmest fill: notes in a conversation, callouts, code blocks.
  quiet: ["ink", 5, "transparent"],
  // Lamplight on the page: a warm glow from above, a faint gold in the far
  // corner. Each fades to nothing from this colour.
  lamp: ["accent", 7, "transparent"],
  lampGold: ["star", 5, "transparent"],
  star: "star",
  ok: "ok",
  danger: "danger",
  dangerWash: ["danger", 10, "transparent"],
} as const satisfies Record<string, LaneToken>;

export type LaneTokenName = keyof typeof LANE_TOKENS;

const kebab = (key: string) => key.replace(/[A-Z]|\d+/g, (c) => `-${c.toLowerCase()}`);

/** The custom property a lane token is declared as: ink2 is --sl-ink-2. */
export function laneCssName(name: string): string {
  return `--sl-${kebab(name)}`;
}

/** A palette colour as the family's custom property: bgRaised is --pd-bg-raised. */
export function paletteCssVar(base: string): string {
  return base === "transparent" ? base : `var(--pd-${kebab(base)})`;
}

/** The CSS value simple.css declares for a token. */
export function laneCssValue(token: LaneToken): string {
  if (typeof token === "string") return paletteCssVar(token);
  const [base, pct, other] = token;
  return `color-mix(in srgb, ${paletteCssVar(base)} ${pct}%, ${paletteCssVar(other)})`;
}

/** Every token as a colour for one palette, given a mixer that does what
 *  color-mix(in srgb, a pct%, b) does. */
export function resolveLaneTokens(
  p: Palette,
  mix: (a: string, pct: number, b: string) => string,
): Record<LaneTokenName, string> {
  const pick = (base: Base | "transparent") => (base === "transparent" ? base : p[base]);
  return Object.fromEntries(
    Object.entries(LANE_TOKENS).map(([name, t]) => [
      name,
      typeof t === "string" ? p[t] : mix(p[t[0]], t[1], pick(t[2])),
    ]),
  ) as Record<LaneTokenName, string>;
}
