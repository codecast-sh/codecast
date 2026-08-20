import { describe, expect, test } from "bun:test";
import { formatRelative, relTimeShort } from "../utils";

// One set of thresholds for the short and the suffixed form. The explicit
// `now` is what lets a surface age every stamp off one shared clock.
describe("relTimeShort / formatRelative", () => {
  const now = 1_700_000_000_000;
  test("share buckets and round down", () => {
    expect(relTimeShort(now - 30_000, now)).toBe("now");
    expect(relTimeShort(now - 90_000, now)).toBe("1m");
    expect(relTimeShort(now - 3_599_000, now)).toBe("59m");
    expect(relTimeShort(now - 5 * 3_600_000, now)).toBe("5h");
    expect(relTimeShort(now - 3 * 86_400_000, now)).toBe("3d");
    expect(formatRelative(now - 30_000, now)).toBe("just now");
    expect(formatRelative(now - 90_000, now)).toBe("1m ago");
    expect(formatRelative(now - 5 * 3_600_000, now)).toBe("5h ago");
    expect(formatRelative(now - 3 * 86_400_000, now)).toBe("3d ago");
  });
  test("a future stamp reads as now", () => {
    expect(relTimeShort(now + 5_000, now)).toBe("now");
  });
});
