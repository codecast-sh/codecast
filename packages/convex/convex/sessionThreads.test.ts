import { describe, expect, test } from "bun:test";
import { parseSessionThreadMessage } from "./sessionThreads";

describe("session thread message framing", () => {
  test("removes only the formatter newlines and preserves exact body whitespace", () => {
    const body = "    const answer = 42;\n\n";
    expect(
      parseSessionThreadMessage(
        `<session-message from="jx7c6zk">\n${body}\n</session-message>`,
      ),
    ).toEqual({ from: "jx7c6zk", body });
  });

  test("uses the final closing tag when the body contains a literal close tag", () => {
    const body = "Explain </session-message> literally.\nThen continue.";
    expect(
      parseSessionThreadMessage(
        `<session-message from="jx7c6zk">\n${body}\n</session-message>`,
      ),
    ).toEqual({ from: "jx7c6zk", body });
  });
});
