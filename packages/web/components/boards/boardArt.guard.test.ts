import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { BOARD_ART, boardArtFor } from "@codecast/shared/artifacts/board";
import { BOARD_ART_URLS } from "./boardArtUrls";

describe("board illustrations", () => {
  test("every name has a file and a url, and every file has a name", () => {
    const files = readdirSync(join(import.meta.dir, "art")).filter((f) => f.endsWith(".webp")).map((f) => f.slice(0, -5)).sort();
    expect(files).toEqual([...BOARD_ART].sort());
    expect(Object.keys(BOARD_ART_URLS).sort()).toEqual([...BOARD_ART].sort());
  });
  test("names and emoji resolve, other text does not", () => {
    expect(boardArtFor("rocket")).toBe("rocket");
    expect(boardArtFor("🚀")).toBe("rocket");
    expect(boardArtFor("🗺️")).toBe("map");
    expect(boardArtFor("🦄")).toBeNull();
    expect(boardArtFor("Rocket")).toBeNull();
  });
});
