import { describe, expect, test } from "bun:test";
import { parseDuration, formatDuration, parsePolicyArg, formatStackList, describePolicy, parseDue, formatDue, resolveReorderIds } from "./stackCommand";

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

// The due time (the-line.md L10) and the reorder wire shape.
describe("cast stack policy --due and reorder", () => {
  // A fixed local clock: 2026-09-15 10:30 local time.
  const now = new Date(2026, 8, 15, 10, 30).getTime();
  const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

  test("--due takes a duration, today, tomorrow, a date, or a date and time", () => {
    expect(parseDue("3h", now)).toBe(now + 3 * 3_600_000);
    expect(parseDue("today", now)).toBe(local(2026, 9, 15, 23, 59));
    expect(parseDue("tomorrow", now)).toBe(local(2026, 9, 16, 23, 59));
    expect(parseDue("2026-09-20", now)).toBe(local(2026, 9, 20, 23, 59));
    expect(parseDue("2026-09-20T15:00", now)).toBe(local(2026, 9, 20, 15, 0));
    expect(() => parseDue("soon", now)).toThrow(/not a time/);
    expect(() => parseDue("", now)).toThrow(/needs a time/);
  });

  test("a due time reads as due or overdue in the policy line and the list", () => {
    expect(formatDue(local(2026, 9, 20, 23, 59), now)).toBe("due 2026-09-20 23:59");
    expect(formatDue(local(2026, 9, 10, 9, 0), now)).toBe("overdue since 2026-09-10 09:00");
    expect(describePolicy({ due_at: local(2026, 9, 10, 9, 0) }, undefined, now)).toBe("overdue since 2026-09-10 09:00");
    const out = formatStackList(
      [{ _id: "s", short_id: "ds-3", title: "Launch", status: "open", policy: { due_at: local(2026, 9, 20, 23, 59) }, decision_ids: [], total: 0, resolved: 0, pending: 0, created_at: now - 60_000, updated_at: now }],
      now,
    );
    expect(out).toContain("(due 2026-09-20 23:59; 1m ago)");
  });

  test("reorder resolves short ids to raw ids and requires every member exactly once", () => {
    const members = [{ _id: "sd_a", short_id: "sd-1" }, { _id: "sd_b", short_id: "sd-2" }, { _id: "sd_c", short_id: "sd-3" }];
    expect(resolveReorderIds(members, ["sd-3", "sd-1", "sd_b"])).toEqual(["sd_c", "sd_a", "sd_b"]);
    expect(() => resolveReorderIds(members, ["sd-3", "sd-1", "sd-9"])).toThrow(/sd-9 is not a member/);
    expect(() => resolveReorderIds(members, ["sd-3", "sd-3", "sd-1"])).toThrow(/appears twice/);
    expect(() => resolveReorderIds(members, ["sd-3", "sd-1"])).toThrow(/missing: sd-2/);
  });
});
