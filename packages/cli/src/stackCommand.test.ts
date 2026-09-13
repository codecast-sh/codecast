import { describe, expect, test } from "bun:test";
import { parseDuration, formatDuration, parsePolicyArg, formatStackList, describePolicy } from "./stackCommand";

describe("cast stack policy parsing", () => {
  test("durations", () => {
    expect(parseDuration("24h")).toBe(86_400_000);
    expect(parseDuration("90m")).toBe(5_400_000);
    expect(parseDuration("2d")).toBe(172_800_000);
    expect(() => parseDuration("soon")).toThrow(/duration/);
    expect(formatDuration(86_400_000)).toBe("1d");
    expect(formatDuration(5_400_000)).toBe("90m");
  });
  test("--policy auto-default:<dur>", () => {
    expect(parsePolicyArg("auto-default:24h")).toEqual({ auto_default_after_ms: 86_400_000 });
    expect(() => parsePolicyArg("auto-default")).toThrow(/duration/);
    expect(() => parsePolicyArg("magic:1")).toThrow(/Unknown policy/);
  });
  test("list formatting", () => {
    const now = 10_000_000;
    const out = formatStackList(
      [{ _id: "s", short_id: "ds-3", title: "Launch", status: "open", policy: { auto_default_after_ms: 3_600_000 }, decision_ids: ["a", "b"], total: 2, resolved: 1, pending: 1, next_short_id: "sd-9", created_at: now - 120_000, updated_at: now }],
      now,
    );
    expect(out).toBe("● ds-3  Launch  1/2 resolved  next sd-9  (auto default after 1h; 2m ago)");
    expect(describePolicy({})).toBe("no policy");
    expect(formatStackList([])).toContain("No decision stacks");
  });
});
