import { describe, expect, it } from "bun:test";
import { relativeTime, withEditParam } from "./artifactCardUtils";

describe("withEditParam", () => {
  it("inserts ?edit=1 before the owner-key fragment", () => {
    expect(withEditParam("https://codecast.sh/a/report#o=abc123")).toBe(
      "https://codecast.sh/a/report?edit=1#o=abc123",
    );
  });

  it("appends ?edit=1 when there is no fragment", () => {
    expect(withEditParam("https://codecast.sh/a/report")).toBe(
      "https://codecast.sh/a/report?edit=1",
    );
  });
});

describe("relativeTime", () => {
  it("returns null for missing timestamps", () => {
    expect(relativeTime(null)).toBeNull();
    expect(relativeTime(undefined)).toBeNull();
  });

  it("buckets ages coarsely", () => {
    const now = Date.now();
    expect(relativeTime(now - 10_000)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000)).toBe("5m ago");
    expect(relativeTime(now - 3 * 3_600_000)).toBe("3h ago");
    expect(relativeTime(now - 2 * 86_400_000)).toBe("2d ago");
  });
});
