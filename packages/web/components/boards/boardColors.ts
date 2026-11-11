// Board color names -> theme tokens. Elements store a name ("yellow"), never
// a hex, so the same board reads right in light and dark themes.
import type { BoardColor } from "@codecast/shared/artifacts/board";

const TOKEN: Record<BoardColor, string> = {
  yellow: "var(--sol-yellow)",
  orange: "var(--sol-orange)",
  red: "var(--sol-red)",
  pink: "var(--sol-magenta)",
  violet: "var(--sol-violet)",
  blue: "var(--sol-blue)",
  cyan: "var(--sol-cyan)",
  green: "var(--sol-green)",
  gray: "var(--sol-text-dim)",
};

export function colorToken(name: unknown, fallback: BoardColor = "gray"): string {
  return TOKEN[(typeof name === "string" && name in TOKEN ? name : fallback) as BoardColor];
}

/** A sticky's paper: the color washed into the card surface, strong enough to read as that color. */
export function stickyFill(name: unknown): string {
  const n = typeof name === "string" && name in TOKEN ? name : "yellow";
  return `var(--board-sticky-${n})`;
}

/** A soft tint for frames and outlined shapes. */
export function tint(name: unknown, pct = 12): string {
  return `color-mix(in srgb, ${colorToken(name, "blue")} ${pct}%, transparent)`;
}

/** The stamp palette, in toolbar order. */
export const STAMPS = ["👍", "❤️", "🎉", "🔥", "✅", "❓", "⭐", "👀", "🚀", "💡", "⚠️", "😂"] as const;
