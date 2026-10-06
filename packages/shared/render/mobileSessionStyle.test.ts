import { describe, expect, test } from "bun:test";
import { MOBILE_COMPOSER_STATUS, mobileRelativeTime } from "./mobileSessionStyle";
import { toolResultHint } from "./toolCall";

const call = (name: string) => ({ name, input: "{}" });

describe("toolResultHint", () => {
  test("names how a call came out, as the app's transcript does", () => {
    expect(toolResultHint(call("Read"), { content: "a\nb\nc" })).toBe("(3 lines)");
    expect(toolResultHint(call("Bash"), { content: "one\ntwo" })).toBe("(2 lines)");
    expect(toolResultHint(call("Bash"), { content: "one" })).toBeNull();
    expect(toolResultHint(call("Grep"), { content: "x.ts\n\ny.ts\n" })).toBe("(2 matches)");
    expect(toolResultHint(call("Edit"), { content: "updated with 3 additions and 1 removal" })).toBe("(+3 -1)");
    expect(toolResultHint(call("Edit"), { content: "The file has been updated" })).toBe("(ok)");
    expect(toolResultHint(call("Bash"), { content: "boom", is_error: true })).toBe("(error)");
    expect(toolResultHint(call("Bash"), undefined)).toBeNull();
  });
});

describe("mobile session spec", () => {
  test("relative time reads as the app's", () => {
    const now = 1_000_000_000;
    expect(mobileRelativeTime(now - 5_000, now)).toBe("just now");
    expect(mobileRelativeTime(now - 3 * 60_000, now)).toBe("3m ago");
    expect(mobileRelativeTime(now - 2 * 3_600_000, now)).toBe("2h ago");
    expect(mobileRelativeTime(now - 3 * 86_400_000, now)).toBe("3d ago");
  });

  test("statuses the composer shows", () => {
    expect(MOBILE_COMPOSER_STATUS.permission_blocked.label).toBe("Needs Input");
    expect(MOBILE_COMPOSER_STATUS.idle).toBeUndefined();
  });
});
