// Renders the tokens as CSS custom properties, prefixed --pd-. tokens.css is
// this function's output, checked in so a stylesheet can import it without a
// build step (src/build.ts writes it; tokens.test.ts fails if it drifts).
import { DARK_SELECTOR, FONTS, MOTION, PALETTE, SHAPE, type Palette } from "./tokens";

const kebab = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function block(selector: string, vars: Record<string, string>): string {
  const lines = Object.entries(vars).map(([k, v]) => `  --pd-${kebab(k)}: ${v};`);
  return `${selector} {\n${lines.join("\n")}\n}\n`;
}

const fontVars = Object.fromEntries(Object.entries(FONTS).map(([k, v]) => [`font-${k}`, v]));
const motionVars = Object.fromEntries(Object.entries(MOTION).map(([k, v]) => [`t-${k}`, v]));

export function tokensCss(): string {
  const header = "/* Generated from src/tokens.ts by src/build.ts. Do not edit by hand. */\n\n";
  const light: Record<string, string> = { ...fontVars, ...SHAPE, ...motionVars, ...(PALETTE.light as Palette) };
  return header + block(":root", light) + "\n" + block(DARK_SELECTOR, PALETTE.dark);
}
