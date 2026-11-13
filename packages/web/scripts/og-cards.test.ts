import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEO_ROUTES, cardHeading, cardImagePath } from "../lib/seoRoutes";
import { CARD_HEIGHT, CARD_WIDTH, renderCards } from "./og-cards.mjs";

// satori refuses some layouts only at render time, and the prerender fails
// open, so a broken card would ship silently as the default image.
describe("og cards", () => {
  // A blog post has a cover (the picture card); /documentation has none (the text card).
  for (const path of [SEO_ROUTES.find((e) => e.path.startsWith("/blog/"))!.path, "/documentation"]) {
    test(`renders ${path} as a 1200x630 PNG at its card path`, async () => {
      const entry = SEO_ROUTES.find((e) => e.path === path)!;
      const outDir = mkdtempSync(join(tmpdir(), "og-cards-"));
      const written = await renderCards({
        entries: [entry],
        cardHeading,
        cardImagePath,
        outDir,
        logoPath: join(import.meta.dir, "..", "public", "logo-final.png"),
      });
      expect([...written]).toEqual([entry.path]);
      const png = readFileSync(join(outDir, cardImagePath(entry.path)));
      expect(png.subarray(1, 4).toString()).toBe("PNG");
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([CARD_WIDTH, CARD_HEIGHT]);
    }, 120_000);
  }

  test("every feature page names a picture", () => {
    expect(SEO_ROUTES.filter((e) => e.path.startsWith("/features/") && !e.card?.art)).toEqual([]);
  });

  // A missing or WebP picture would quietly fall back to the text card.
  test("every card picture exists as a PNG or JPEG", () => {
    const bad = SEO_ROUTES.filter((e) => e.card?.art)
      .map((e) => e.card!.art!)
      .filter((art) => !/\.(png|jpe?g)$/i.test(art) || !existsSync(join(import.meta.dir, "..", art)));
    expect(bad).toEqual([]);
  });
});
