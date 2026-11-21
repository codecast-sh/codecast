import { describe, expect, test } from "bun:test";
import { stateFromAnswer } from "../remoteFile";

const abs = "/Users/ashot/src/family/x-growth/daily/2026-11-12.md";
const machine = "MacBook-Pro-182";

describe("stateFromAnswer", () => {
  test("a file the machine sent is ready to read", () => {
    const row = { executed_at: 1, result: JSON.stringify({ exists: true, content: "# Daily", size: 7, truncated: false }) };
    expect(stateFromAnswer(row, abs, machine)).toEqual({ status: "ready", abs, machine, content: "# Daily", size: 7, truncated: false });
  });

  test("a missing file names the machine it is missing from", () => {
    const row = { executed_at: 1, result: JSON.stringify({ exists: false }) };
    expect(stateFromAnswer(row, abs, machine)).toMatchObject({ status: "failed", message: `${abs} does not exist on ${machine}.` });
  });

  test("an old daemon is told to update, by name", () => {
    expect(stateFromAnswer({ executed_at: 1, error: "Unknown command: read_file" }, abs, machine)).toMatchObject({
      status: "failed",
      message: `Update Codecast on ${machine} to open its files from here.`,
    });
  });

  test("a fenced path says why", () => {
    expect(stateFromAnswer({ executed_at: 1, error: "Path not allowed" }, abs, machine)).toMatchObject({ status: "failed" });
    expect((stateFromAnswer({ executed_at: 1, error: "Path not allowed" }, abs, machine) as { message: string }).message).toContain("doesn't share");
  });
});
