import { describe, expect, test } from "bun:test";
import { ghosttyKeyName, isGhosttyScreenFile } from "./ghostty.js";

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
});
