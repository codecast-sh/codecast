import { describe, expect, test } from "bun:test";
import { sanitizeForTerminal } from "./sanitize.js";

describe("sanitizeForTerminal", () => {
  test("an embedded paste end or start is removed, including one rebuilt by the removal", () => {
    expect(sanitizeForTerminal("a\x1b[201~b")).toBe("ab");
    expect(sanitizeForTerminal("a\x1b[200~b")).toBe("ab");
    expect(sanitizeForTerminal("\x1b[2\x1b[201~01~x")).toBe("x");
  });

  test("other escape sequences lose their ESC and C0 controls and DEL go", () => {
    expect(sanitizeForTerminal("\x1b[31mred\x1b[0m")).toBe("[31mred[0m");
    expect(sanitizeForTerminal("a\x00b\x07c\x08d\x0be\x0cf\x0eg\x1fh\x7fi")).toBe("abcdefghi");
    expect(sanitizeForTerminal("\x1b\x01[201~")).toBe("[201~");
  });

  test("C1 controls go, so a one-character CSI cannot start a sequence", () => {
    expect(sanitizeForTerminal("a\x9b201~b\x85c\x9dd\x80e\x9ff")).toBe("a201~bcdef");
    expect(sanitizeForTerminal("\u00a0é")).toBe("\u00a0é");
  });

  test("newlines and tabs survive, carriage returns become newlines, trailing newlines go", () => {
    expect(sanitizeForTerminal("one\ntwo\tthree\r\nfour\rfive\n\n")).toBe("one\ntwo\tthree\nfour\nfive");
  });

  test("an empty or fully stripped message is one space, as the daemon's paste", () => {
    expect(sanitizeForTerminal("")).toBe(" ");
    expect(sanitizeForTerminal("\x1b")).toBe("");
  });

  test("plain and non-ASCII text is untouched", () => {
    expect(sanitizeForTerminal("héllo wörld ✓ 日本")).toBe("héllo wörld ✓ 日本");
  });
});
