// frameToBytes turns one relayed screen into the escape sequence that repaints
// an xterm in place. Every rule here exists because the obvious alternative
// looks fine in a single frame and breaks over a stream of them.

import { describe, expect, test } from "bun:test";
import { frameToBytes } from "../terminal/remotePane";

describe("frameToBytes", () => {
  test("homes the cursor and erases each row's tail", () => {
    const out = frameToBytes("ab\ncd");
    expect(out.startsWith("\x1b[H")).toBe(true);
    // \x1b[K after every row: without it, a row that shrinks leaves the
    // previous frame's longer text hanging off the end.
    expect(out).toContain("ab\x1b[0m\x1b[K");
    expect(out).toContain("cd\x1b[0m\x1b[K");
  });

  test("resets attributes before erasing, so color can't smear", () => {
    // \x1b[K erases using the CURRENT background. A row ending inside a colored
    // span would paint that color across the rest of the line.
    const out = frameToBytes("\x1b[41mred");
    expect(out).toContain("\x1b[0m\x1b[K");
    expect(out.indexOf("\x1b[0m")).toBeLessThan(out.indexOf("\x1b[K"));
  });

  test("does not emit a newline after the last row", () => {
    // On a full-height screen a trailing newline scrolls the buffer by one, and
    // over a stream of frames the whole view walks upward.
    const out = frameToBytes("one\ntwo\nthree");
    expect(out.endsWith("\r\n")).toBe(false);
    expect(out.split("\r\n").length).toBe(3);
  });

  test("erases below the last row instead of clearing the screen", () => {
    // \x1b[2J between frames flickers; \x1b[J only clears what the new frame
    // doesn't cover.
    const out = frameToBytes("short");
    expect(out).toContain("\x1b[J");
    expect(out).not.toContain("\x1b[2J");
  });

  test("places the cursor where tmux has it, 1-indexed", () => {
    // capture-pane is text only, so without this the caret parks at the end of
    // the last line rather than in the agent's input box.
    expect(frameToBytes("hi", { x: 3, y: 5 }).endsWith("\x1b[6;4H")).toBe(true);
  });

  test("omits cursor positioning when the relay didn't report one", () => {
    const out = frameToBytes("hi", null);
    expect(out.endsWith("\x1b[J")).toBe(true);
  });

  test("an empty screen still repaints (clears) rather than doing nothing", () => {
    expect(frameToBytes("")).toBe("\x1b[H\x1b[0m\x1b[K\x1b[J");
  });
});
