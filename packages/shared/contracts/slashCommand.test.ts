import { describe, expect, test } from "bun:test";
import { canonicalSlashCommand, parseSlashCommand } from "./slashCommand";

describe("canonicalSlashCommand", () => {
  test("a typed command and Claude Code's record of it read the same", () => {
    const recorded = "<command-name>/mcp</command-name>\n            <command-message>mcp</command-message>\n            <command-args></command-args>";
    expect(canonicalSlashCommand("/mcp")).toBe("/mcp");
    expect(canonicalSlashCommand(recorded)).toBe("/mcp");
    expect(canonicalSlashCommand("<command-message>model</command-message>\n<command-name>/model</command-name>\n<command-args>opus</command-args>")).toBe("/model opus");
    expect(canonicalSlashCommand("/model   opus")).toBe("/model opus");
  });

  test("ordinary text and paths are not commands", () => {
    expect(canonicalSlashCommand("Update")).toBeNull();
    expect(canonicalSlashCommand("/tmp/x is broken")).toBeNull();
    expect(parseSlashCommand("")).toBeNull();
  });
});
