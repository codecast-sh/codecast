import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONVEX_URL } from "./convexPreconnect";

describe("Convex preconnect", () => {
  test("hints the deployment the app connects to when the build sets none", () => {
    const source = readFileSync(join(import.meta.dir, "../lib/convexUrl.ts"), "utf8");
    expect(source).toContain(`import.meta.env.VITE_CONVEX_URL || "${DEFAULT_CONVEX_URL}"`);
  });
});
