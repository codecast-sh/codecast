import { describe, expect, test } from "bun:test";
import { parseExecTimeout, parseOutputFormat, resolveExecPrompt } from "./execCommand.js";

describe("resolveExecPrompt", () => {
  test("joins positional words into one prompt", () => {
    expect(resolveExecPrompt(["summarize", "this", "repo"], { stdinIsTTY: true, readStdin: () => "" }))
      .toEqual({ prompt: "summarize this repo", inheritStdin: false });
  });

  test("'-' reads stdin as the prompt and does not inherit it", () => {
    expect(resolveExecPrompt(["-"], { stdinIsTTY: false, readStdin: () => "from stdin\n" }))
      .toEqual({ prompt: "from stdin", inheritStdin: false });
  });

  test("a prompt with piped stdin inherits stdin for the child", () => {
    expect(resolveExecPrompt(["summarize"], { stdinIsTTY: false, readStdin: () => "FILE" }))
      .toEqual({ prompt: "summarize", inheritStdin: true });
  });

  test("no prompt and piped stdin uses stdin as the prompt", () => {
    expect(resolveExecPrompt([], { stdinIsTTY: false, readStdin: () => "hello\n" }))
      .toEqual({ prompt: "hello", inheritStdin: false });
  });

  test("no prompt on a tty is empty", () => {
    expect(resolveExecPrompt([], { stdinIsTTY: true, readStdin: () => "should not read" }))
      .toEqual({ prompt: "", inheritStdin: false });
  });
});

describe("parseExecTimeout", () => {
  test("accepts seconds, minutes, hours, and a bare number of seconds", () => {
    expect(parseExecTimeout("30s")).toBe(30_000);
    expect(parseExecTimeout("2m")).toBe(120_000);
    expect(parseExecTimeout("1h")).toBe(3_600_000);
    expect(parseExecTimeout("45")).toBe(45_000);
  });

  test("rejects junk", () => {
    expect(parseExecTimeout("soon")).toBeUndefined();
    expect(parseExecTimeout("")).toBeUndefined();
  });
});

describe("parseOutputFormat", () => {
  test("accepts the three unified formats", () => {
    expect(parseOutputFormat("text")).toBe("text");
    expect(parseOutputFormat("JSON")).toBe("json");
    expect(parseOutputFormat("stream-json")).toBe("stream-json");
  });

  test("rejects unknown values", () => {
    expect(parseOutputFormat("yaml")).toBeUndefined();
    expect(parseOutputFormat(undefined)).toBeUndefined();
  });
});
