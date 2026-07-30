import { describe, expect, test } from "bun:test";
import {
  prepareSessionSendBody,
  removeStdinTransportNewline,
} from "./sendBody";

describe("removeStdinTransportNewline", () => {
  test("removes one LF added by a heredoc transport", () => {
    expect(removeStdinTransportNewline("briefing\n")).toBe("briefing");
  });

  test("removes one CRLF transport terminator", () => {
    expect(removeStdinTransportNewline("briefing\r\n")).toBe("briefing");
  });

  test("preserves leading indentation and intentional trailing blank lines", () => {
    expect(removeStdinTransportNewline("    const answer = 42;\n\n\n")).toBe(
      "    const answer = 42;\n\n",
    );
  });

  test("does not alter input without a terminal newline", () => {
    expect(removeStdinTransportNewline("  exact body  ")).toBe("  exact body  ");
  });
});

describe("prepareSessionSendBody", () => {
  test("does not trim an inline quoted body", () => {
    expect(prepareSessionSendBody("  exact body  ", false)).toBe("  exact body  ");
  });

  test("only stdin receives transport-newline normalization", () => {
    expect(prepareSessionSendBody("body\n", false)).toBe("body\n");
    expect(prepareSessionSendBody("body\n", true)).toBe("body");
  });
});
