import { describe, expect, test } from "bun:test";
import { cn, TYPE_SCALE } from "../utils";
import config from "../../tailwind.config";

// cn() runs through tailwind-merge, which files any `text-*` it does not know
// under text colour. The type scale's names must sit in the font-size group,
// or a size next to a colour is dropped without a word.
describe("cn() and the type scale", () => {
  test("a scale size and a text colour both survive", () => {
    expect(cn("text-meta", "text-sol-text-dim")).toBe("text-meta text-sol-text-dim");
    expect(cn("text-sol-text-dim", "text-mark")).toBe("text-sol-text-dim text-mark");
    for (const step of TYPE_SCALE) {
      expect(cn(`text-${step}`, "text-sol-cyan")).toBe(`text-${step} text-sol-cyan`);
    }
  });

  test("two sizes collapse to the last, whatever form each takes", () => {
    expect(cn("text-[10px]", "text-meta")).toBe("text-meta");
    expect(cn("text-meta", "text-[10px]")).toBe("text-[10px]");
    expect(cn("text-xs", "text-ui")).toBe("text-ui");
    expect(cn("text-body", "text-sm")).toBe("text-sm");
    expect(cn("text-mark", "text-meta")).toBe("text-meta");
  });

  test("variants stay separate groups", () => {
    expect(cn("text-meta", "sm:text-ui", "text-sol-text-dim")).toBe("text-meta sm:text-ui text-sol-text-dim");
    expect(cn("sm:text-[11px]", "sm:text-meta")).toBe("sm:text-meta");
  });

  test("the names cn() knows are exactly the ones tailwind.config.ts defines", () => {
    const sizes = (config.theme?.extend as { fontSize?: Record<string, unknown> } | undefined)?.fontSize ?? {};
    expect(Object.keys(sizes).sort()).toEqual([...TYPE_SCALE].sort());
  });
});
