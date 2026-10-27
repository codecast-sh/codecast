import { describe, expect, test } from "bun:test";
import { autoDenyDeadline } from "./interactivePrompt.js";

describe("autoDenyDeadline", () => {
  const now = 1_000_000;
  const pane = (line: string) => [
    " Bash command",
    "   rm -rf \"$D\"/tmp",
    "",
    ` ⚠ ${line}`,
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. No",
  ].join("\n");

  test("the M:SS countdown", () => {
    expect(autoDenyDeadline(pane("Claude Code will automatically deny this request in 1:42, to avoid blocking progress on an unattended session"), now)).toBe(now + 102_000);
  });

  test("the reduced-motion wording, wrapped across rows", () => {
    expect(autoDenyDeadline(pane("Claude Code will automatically deny this request in about\n 2 minutes, to avoid blocking progress"), now)).toBe(now + 120_000);
    expect(autoDenyDeadline(pane("Claude Code will automatically deny this request in about 1 second, to avoid"), now)).toBe(now + 1_000);
  });

  test("a dialog with no timeout has no deadline", () => {
    expect(autoDenyDeadline(pane("This command requires approval"), now)).toBeNull();
  });
});
