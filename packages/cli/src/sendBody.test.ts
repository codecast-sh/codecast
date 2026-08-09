import { describe, expect, test } from "bun:test";
import {
  expandStdinArgs,
  prepareSessionSendBody,
  readStdinBody,
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

describe("readStdinBody", () => {
  test("strips exactly the one transport newline from the stdin body", () => {
    expect(readStdinBody(() => "# Brief\n\nsteps\n")).toBe("# Brief\n\nsteps");
  });
});

describe("expandStdinArgs", () => {
  test("passes non-dash arguments through untouched", () => {
    expect(expandStdinArgs(["task a", "task b"], () => "unused")).toEqual(["task a", "task b"]);
  });

  test("expands a single '-' to the stdin body in place", () => {
    expect(expandStdinArgs(["task a", "-", "task c"], () => "multi\nline\n")).toEqual([
      "task a",
      "multi\nline",
      "task c",
    ]);
  });

  test("a literal dash inside a longer argument is not stdin", () => {
    expect(expandStdinArgs(["--", "a-b"], () => "unused")).toEqual(["--", "a-b"]);
  });

  test("rejects a second '-' — stdin holds only one body", () => {
    expect(() => expandStdinArgs(["-", "-"], () => "body")).toThrow(
      "Only one argument can be read from stdin",
    );
  });
});
