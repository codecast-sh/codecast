// The avatar set is a contract between two places: the key list in
// shared/contracts/orgAvatars and the image files in this directory. This test
// keeps them agreeing: every key has a file and every file a key, and every
// file is a real square WebP small enough to ship 24 of them.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AVATAR_KEYS } from "@codecast/shared/contracts/orgAvatars";

const DIR = import.meta.dir;

/** Width and height from a WebP header (VP8, VP8L or VP8X chunk). */
function webpSize(buf: Buffer): { w: number; h: number } {
  expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
  expect(buf.toString("ascii", 8, 12)).toBe("WEBP");
  const chunk = buf.toString("ascii", 12, 16);
  if (chunk === "VP8X") return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
  if (chunk === "VP8 ") return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  const bits = buf.readUInt32LE(21); // VP8L
  return { w: 1 + (bits & 0x3fff), h: 1 + ((bits >> 14) & 0x3fff) };
}

describe("org avatar files (org-staffing.md S13)", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".webp")).map((f) => f.slice(0, -5)).sort();

  test("one file per key, one key per file, and no stray art formats", () => {
    expect(files).toEqual([...AVATAR_KEYS].sort());
    expect(readdirSync(DIR).filter((f) => /\.(svg|png|jpe?g)$/.test(f))).toEqual([]);
  });

  test.each([...AVATAR_KEYS])("%s is a 256 px square WebP under 40 KB", (key) => {
    const buf = readFileSync(join(DIR, `${key}.webp`));
    expect(webpSize(buf)).toEqual({ w: 256, h: 256 });
    expect(buf.byteLength).toBeLessThan(40_000);
  });
});
