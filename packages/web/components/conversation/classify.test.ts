import { describe, expect, test } from "bun:test";
import { cleanStickyContent } from "./classify";

describe("cleanStickyContent", () => {
  test("keeps an HTML comment the person typed, as the message body does", () => {
    expect(cleanStickyContent('add one line "<!-- codecast spike -->" at the end of README.md')).toBe('add one line "<!-- codecast spike -->" at the end of README.md');
  });

  test("drops system wrappers around the prompt", () => {
    expect(cleanStickyContent("<system-reminder>ignore</system-reminder>fix the bug<bash-input>")).toBe("fix the bug");
  });
});
