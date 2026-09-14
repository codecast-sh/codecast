import { describe, expect, test } from "bun:test";
import { isChunkLoadError } from "../chunkReloadGuard";

describe("isChunkLoadError", () => {
  test("a module served without a named export is a stale-module error", () => {
    // The exact message a dev tab showed on 2026-09-13 after Vite served
    // EntityIdPill.tsx mid-edit. React.lazy memoizes the rejection, so the
    // pane can only heal by reloading, which this classification triggers.
    expect(
      isChunkLoadError(
        "The requested module '/components/EntityIdPill.tsx?t=1789356290505' does not provide an export named 'EntityAwareCode'",
      ),
    ).toBe(true);
    expect(isChunkLoadError("The requested module './x' doesn't provide an export named 'y'")).toBe(true);
    expect(isChunkLoadError("Importing binding name 'y' is not found.")).toBe(true);
  });

  test("a stale hashed chunk after a deploy is a stale-module error", () => {
    expect(isChunkLoadError("Failed to fetch dynamically imported module: https://x/assets/page-abc.js")).toBe(true);
    expect(isChunkLoadError("Loading CSS chunk 12 failed")).toBe(true);
  });

  test("ordinary code bugs never trigger an auto-reload", () => {
    expect(isChunkLoadError("Cannot read properties of undefined (reading 'map')")).toBe(false);
    expect(isChunkLoadError("x is not a function")).toBe(false);
    expect(isChunkLoadError("")).toBe(false);
  });
});
