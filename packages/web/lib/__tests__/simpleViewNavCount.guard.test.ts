import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// SIMPLE-VIEW COUNT BADGE GUARD.
//
// Simple view restyles the sidebar's count pills (right-aligned, 16px, pale).
// The rule once selected them by colour — any `span.rounded-full` whose class
// list contained `bg-sol-cyan` or `bg-teal` — and so also caught project dots
// that happened to hash to teal or were left at the default cyan. Those two
// projects rendered as right-aligned pale circles while their neighbours
// rendered as 6px dots. The marker is `data-sv-count`, carried by NavCount;
// every count in the rail goes through that component, and the CSS keys on
// the marker only.

const ROOT = join(import.meta.dir, "..", "..");
const css = readFileSync(join(ROOT, "app", "globals.css"), "utf8");
const sidebar = readFileSync(join(ROOT, "components", "Sidebar.tsx"), "utf8");

describe("simple view count badges", () => {
  test("the sidebar rule keys on the NavCount marker, not on a colour class", () => {
    const navRules = css.match(/\.simple-view \[data-sv-nav\][^{]*\{/g) ?? [];
    expect(navRules.some((r) => r.includes("[data-sv-count]"))).toBe(true);
    for (const rule of navRules) {
      expect(rule).not.toMatch(/\[class\*=["']?bg-/);
    }
  });

  test("every count pill in the sidebar renders through NavCount", () => {
    // A hand-rolled pill (the count sizing on a raw span) has no marker, so
    // simple view would leave it in place and full-size.
    const rawPills = sidebar.match(/<span[^>]*min-w-\[(?:16|20)px\][^>]*rounded-full/g) ?? [];
    const insideNavCount = rawPills.filter((m) => m.includes("data-sv-count"));
    expect(rawPills.length).toBe(insideNavCount.length);
  });
});
