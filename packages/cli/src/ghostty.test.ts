import { describe, expect, test } from "bun:test";
import { ghosttyKeyName, ghosttyPane, ghosttyUnscriptableHint, isGhosttyScreenFile, type GhosttyIo } from "./ghostty.js";
import { TerminalHoldError } from "./terminalHold.js";
import { unreachableTerminalOf } from "@codecast/shared/contracts/deliveryHold";

describe("ghostty", () => {
  // Ghostty's `send key` takes W3C key codes in lower camel case and refuses
  // "up" or "1" (checked against Ghostty 1.4).
  test("maps poll keys and keystroke bytes to Ghostty key names", () => {
    expect(["Return", "Enter", "\r"].map(ghosttyKeyName)).toEqual(["enter", "enter", "enter"]);
    expect(["Escape", "\x1b"].map(ghosttyKeyName)).toEqual(["escape", "escape"]);
    expect(["Up", "Down", "Left", "Right"].map(ghosttyKeyName)).toEqual(["arrowUp", "arrowDown", "arrowLeft", "arrowRight"]);
    expect(["1", "9", "Tab", "y"].map(ghosttyKeyName)).toEqual(["digit1", "digit9", "tab", "y"]);
  });

  // The dump's path comes off the clipboard, and its directory is deleted
  // after the read: only Ghostty's own `<tmp>/<random>/screen.txt` qualifies.
  test("accepts only a Ghostty screen dump in a temp dir", () => {
    const tmp = "/var/folders/sr/abc/T";
    expect(isGhosttyScreenFile("/private/var/folders/sr/abc/T/Ncyu6vQD2iJdT5uMowB6pw/screen.txt", tmp)).toBe(true);
    expect(isGhosttyScreenFile("/var/folders/zz/other/T/x/screen.txt", "/tmp")).toBe(true);
    expect(isGhosttyScreenFile("/tmp/x/screen.txt", "/tmp")).toBe(true);
    expect(isGhosttyScreenFile("/Users/a/src/repo/screen.txt", tmp)).toBe(false);
    expect(isGhosttyScreenFile("/var/folders/sr/abc/T/screen.txt", tmp)).toBe(false);
    expect(isGhosttyScreenFile("/var/folders/sr/abc/T/x/notes.txt", tmp)).toBe(false);
    expect(isGhosttyScreenFile("hello world", tmp)).toBe(false);
  });

  // The Mac Studio's daemon was refused Automation for Ghostty after the
  // consent prompt timed out on a locked screen; the hold must say so.
  test("names the fix for each way Ghostty's scripting is out of reach", () => {
    const denied = ghosttyUnscriptableHint({ stderr: "execution error: Not authorized to send Apple events to Ghostty. (-1743)" });
    expect(denied).toContain("Privacy & Security, Automation");
    expect(ghosttyUnscriptableHint({ message: "Command failed: osascript", killed: true, signal: "SIGTERM" })).toContain("did not answer");
    expect(ghosttyUnscriptableHint({ stderr: "execution error: Ghostty got an error: AppleEvent timed out. (-1712)" })).toContain("did not answer");
    expect(ghosttyUnscriptableHint({ stderr: "syntax error: Expected class name but found identifier. (-2741)" })).toContain("1.3 or later");
    expect(ghosttyUnscriptableHint({ stderr: "something else" })).toBeNull();
  });

  test("an unscriptable Ghostty holds the message with the hint in the reason", async () => {
    const io = {
      probe: async () => ({ state: "unscriptable" as const, detail: "(-1743)", hint: "turn it on" }),
    } as unknown as GhosttyIo;
    const err = await ghosttyPane("/dev/ttys001", false, () => {}, io).catch((e) => e);
    expect(err).toBeInstanceOf(TerminalHoldError);
    expect(err.holdReason).toBe("runs in Ghostty, which Codecast can't type into: turn it on");
    expect(unreachableTerminalOf(err.holdReason)).toBe("Ghostty");
  });
});
