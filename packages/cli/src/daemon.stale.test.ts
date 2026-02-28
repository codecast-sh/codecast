import { describe, expect, test } from "bun:test";
import { shouldTreatClaudeFileAsStale } from "./daemon.js";

describe("shouldTreatClaudeFileAsStale", () => {
  test("marks file stale when there is no sync record", () => {
    expect(
      shouldTreatClaudeFileAsStale(
        { mtimeMs: 2000, size: 100 },
        null
      )
    ).toBe(true);
  });

  test("ignores mtime drift for legacy fallback records", () => {
    expect(
      shouldTreatClaudeFileAsStale(
        { mtimeMs: 5000, size: 100 },
        {
          lastSyncedAt: 0,
          lastSyncedPosition: 100,
          messageCount: 0,
          isLegacyFallback: true,
        }
      )
    ).toBe(false);
  });

  test("marks legacy fallback record stale when size grows", () => {
    expect(
      shouldTreatClaudeFileAsStale(
        { mtimeMs: 5000, size: 101 },
        {
          lastSyncedAt: 0,
          lastSyncedPosition: 100,
          messageCount: 0,
          isLegacyFallback: true,
        }
      )
    ).toBe(true);
  });

  test("marks non-legacy record stale when mtime moves forward", () => {
    expect(
      shouldTreatClaudeFileAsStale(
        { mtimeMs: 5000, size: 100 },
        {
          lastSyncedAt: 4000,
          lastSyncedPosition: 100,
          messageCount: 10,
        }
      )
    ).toBe(true);
  });
});
