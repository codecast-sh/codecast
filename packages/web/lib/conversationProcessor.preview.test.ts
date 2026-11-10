import { expect, test } from "bun:test";
import { cleanContent } from "./conversationProcessor";

test("plain content bypasses cleanup without changing tagged, ANSI or caveat text", () => {
  expect(cleanContent("  Ordinary **markdown**\n  ")).toBe("Ordinary **markdown**");
  expect(cleanContent("<system-reminder>hidden</system-reminder>Visible")).toBe("Visible");
  expect(cleanContent("\x1b[31mRed\x1b[0m")).toBe("Red");
  expect(cleanContent("Visible\n  Caveat: omitted\nEnd")).toBe("Visible\n\nEnd");
  expect(cleanContent("Embedded Caveat: kept")).toBe("Embedded Caveat: kept");
});
