import { describe, expect, test } from "bun:test";
import { isTriageBarCompact } from "./graduation";

describe("isTriageBarCompact", () => {
  test("unset is expanded", () => {
    expect(isTriageBarCompact(undefined)).toBe(false);
    expect(isTriageBarCompact({})).toBe(false);
  });

  test("the compact toggle hides the bar", () => {
    expect(isTriageBarCompact({ triage_bar_compact: true })).toBe(true);
    expect(isTriageBarCompact({ triage_bar_compact: false })).toBe(false);
  });

  test("legacy hint-strip dismissal maps to compact, but the toggle wins", () => {
    expect(isTriageBarCompact({ inbox_shortcuts_hidden: true })).toBe(true);
    expect(isTriageBarCompact({ inbox_shortcuts_hidden: true, triage_bar_compact: false })).toBe(false);
  });
});
