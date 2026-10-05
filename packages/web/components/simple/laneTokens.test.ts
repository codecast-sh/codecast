import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PALETTE } from "@platform/design";
import { LANE_TOKENS, laneCssName, laneCssValue, paletteCssVar } from "./laneTokens";

// The phone computes the lane's colours from LANE_TOKENS; the web reads them
// from simple.css. These checks keep the two one definition.
const css = readFileSync(join(import.meta.dir, "simple.css"), "utf8");
const block = css.slice(0, css.indexOf("}", css.indexOf("[data-simple-lane],")));
const paletteVars = new Set(Object.keys(PALETTE.light).map(paletteCssVar));

/** simple.css's --sl-* declarations whose value is built only from palette
 *  colours: the lane's colour tokens, as opposed to its radii, faces and
 *  shadows (a palette shadow is a box-shadow, not a colour). */
function declaredColors(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/^\s*(--sl-[a-z0-9-]+):\s*([^;]+);/gm)) {
    const vars = value.match(/var\(--[a-z0-9-]+\)/g) ?? [];
    if (name.startsWith("--sl-shadow") || vars.length === 0 || !vars.every((v) => paletteVars.has(v))) continue;
    out[name] = value.trim();
  }
  return out;
}

const expected = Object.fromEntries(Object.entries(LANE_TOKENS).map(([n, t]) => [laneCssName(n), laneCssValue(t)]));

describe("lane colour tokens", () => {
  it("simple.css declares exactly the shared table", () => {
    expect(declaredColors()).toEqual(expected);
  });

  it("no rule repeats a token's mix inline", () => {
    // A rule may name a plain token (var(--sl-accent)) inside a mix; read it as
    // the palette colour it stands for, then compare with each token's mix.
    const plain = new Map(
      Object.entries(LANE_TOKENS).flatMap(([n, t]) => (typeof t === "string" ? [[`var(${laneCssName(n)})`, paletteCssVar(t)]] : [])),
    );
    const mixes = new Map(Object.entries(expected).filter(([, v]) => v.startsWith("color-mix")).map(([n, v]) => [v, n]));
    const normal = (mix: string) => mix.replace(/var\(--sl-[a-z0-9-]+\)/g, (v) => plain.get(v) ?? v);
    const repeats = [...css.slice(block.length).matchAll(/color-mix\(in srgb, var\(--[a-z0-9-]+\) \d+%, (?:var\(--[a-z0-9-]+\)|transparent)\)/g)]
      .map(([mix]) => mix)
      .filter((mix) => mixes.has(normal(mix)))
      .map((mix) => `${mix} repeats ${mixes.get(normal(mix))}`);
    expect(repeats).toEqual([]);
  });

  it("names follow the custom property spelling", () => {
    expect(laneCssName("ink2")).toBe("--sl-ink-2");
    expect(laneCssName("lampGold")).toBe("--sl-lamp-gold");
    expect(laneCssValue(["accent", 82, "ink"])).toBe("color-mix(in srgb, var(--pd-accent) 82%, var(--pd-ink))");
  });
});
