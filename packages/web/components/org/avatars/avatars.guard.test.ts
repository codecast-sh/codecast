// The avatar set is a contract between three places: the key list in
// shared/contracts/orgAvatars, the SVG files in this directory, and the
// palette in app/globals.css. This test keeps them agreeing: every key has a
// file and every file a key; every file is a self contained 96 box using only
// palette hex (no currentColor, no gradients, no external refs), so it renders
// the same inline, as an <img>, and in a static page.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AVATAR_KEYS } from "@codecast/shared/contracts/orgAvatars";

const DIR = import.meta.dir;
const css = readFileSync(join(DIR, "../../../app/globals.css"), "utf8");
const palette = new Set([...css.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0].toLowerCase()));

describe("org avatar files (org-staffing.md S13)", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".svg")).map((f) => f.slice(0, -4)).sort();

  test("one file per key, one key per file", () => {
    expect(files).toEqual([...AVATAR_KEYS].sort());
  });

  test.each([...AVATAR_KEYS])("%s is a self contained portrait in palette tones", (key) => {
    const svg = readFileSync(join(DIR, `${key}.svg`), "utf8");
    expect(svg).toContain('viewBox="0 0 96 96"');
    expect(svg).toContain('role="img"');
    expect(svg).toMatch(/aria-label="[A-Z][a-z]+"/);
    expect(svg).not.toMatch(/currentColor|Gradient|url\(http|<image|<style|<script/);
    // the round ground, then the bust clipped to it
    expect(svg).toContain('<circle cx="48" cy="48" r="48" fill="#');
    expect(svg).toContain(`clip-path="url(#c-${key})"`);
    const used = [...svg.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0].toLowerCase());
    expect(used.length).toBeGreaterThan(2);
    const tinted = svg.match(/<!-- tones: ([^>]+) -->/);
    for (const c of used) {
      // literal palette hex, or one of the two derived tones the file declares
      if (!palette.has(c)) expect(tinted?.[1] ?? "").toContain(c);
    }
    expect(svg.length).toBeLessThan(4000); // under Vite's inline limit
  });
});
