import { describe, test, expect } from "bun:test";
import { redactSecrets, maskToken } from "./redact.js";

// redactSecrets / containsSecrets behavior is covered comprehensively in
// secretRedaction.test.ts. Here we only guard that redact.ts still re-exports
// the shared redactor (the syncService / daemon chokepoint) and owns maskToken.
describe("redact.ts barrel", () => {
  test("re-exports the shared redactor", () => {
    expect(redactSecrets("ghp_0123456789abcdefghijklmnopqrstuvwxyz")).toBe(
      "[redacted:github-token]",
    );
  });
});

describe("maskToken", () => {
  test("masks long tokens", () => {
    expect(maskToken("1234567890abcdef")).toBe("123...def");
  });

  test("returns stars for short tokens", () => {
    expect(maskToken("short")).toBe("*****");
  });

  test("handles undefined", () => {
    expect(maskToken(undefined)).toBe("(not set)");
  });
});
