import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEO_ROUTES, cardHeading, cardImagePath } from "../lib/seoRoutes";
import { CARD_HEIGHT, CARD_WIDTH, renderCards } from "./og-cards.mjs";

// satori refuses some layouts only at render time, and the prerender fails
// open, so a broken card would ship silently as the default image.
describe("og cards", () => {
  test("renders a blog post card as a 1200x630 PNG at its card path", async () => {
    const entry = SEO_ROUTES.find((e) => e.path.startsWith("/blog/"))!;
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
});
