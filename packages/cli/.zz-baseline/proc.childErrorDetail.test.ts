import { describe, expect, test } from "bun:test";
import { childErrorDetail, lastErrorLine } from "./proc.js";

describe("childErrorDetail", () => {
  test("keeps the message, drops stack frames and source context", () => {
    const stderr = [
      "error: the aws CLI is not installed (or not on any known PATH) on this machine",
      "      at hostState (/x/cloudHost.ts:120:11)",
      "at _dispatchSubcommand (/x/commander/lib/command.js:1261:25)",
      "1261 |     promise chain",
      "^",
      "",
    ].join("\n");
    expect(childErrorDetail(stderr)).toBe(
      "error: the aws CLI is not installed (or not on any known PATH) on this machine",
    );
  });

  test("falls back to stdout, caps length", () => {
    expect(childErrorDetail("", "plain failure text")).toBe("plain failure text");
    expect(childErrorDetail("x".repeat(900)).length).toBe(500);
  });

  test("multi-line messages join readably", () => {
    expect(childErrorDetail("CONFLICT: tree diverged\nrun pull first")).toBe(
      "CONFLICT: tree diverged — run pull first",
    );
  });
});

describe("lastErrorLine", () => {
  test("names the cause of a Bun crash, not its version banner", () => {
    const stderr = "installing…\nerror: ENOSPC: no space left on device, write\n\nBun v1.4.0 (Linux x64)\n";
    expect(lastErrorLine(stderr)).toBe("error: ENOSPC: no space left on device, write");
  });

  test("is the last non-empty line otherwise, and empty for nothing", () => {
    expect(lastErrorLine("one\n  two  \n\n")).toBe("two");
    expect(lastErrorLine(undefined)).toBe("");
  });
});
