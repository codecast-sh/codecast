import { describe, it, expect } from "vitest";
import { PaneStreamFilter } from "../terminal/paneStreamFilter";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const run = (f: PaneStreamFilter, ...chunks: string[]) => chunks.map((c) => dec(f.process(enc(c)))).join("");

describe("PaneStreamFilter", () => {
  it("passes plain output through untouched", () => {
    const f = new PaneStreamFilter({ syncFrames: true });
    const s = "hello \x1b[31mred\x1b[0m world\r\n\x1b[2J\x1b[H";
    expect(run(f, s)).toBe(s);
  });

  it("drops the capability queries tmux already answers", () => {
    const f = new PaneStreamFilter({ syncFrames: false });
    expect(run(f, "a\x1b[cb\x1b[>0qc\x1b[6nd\x1b[0ce\x1b[>cf\x1b[5ng")).toBe("abcdefg");
  });

  it("keeps DECRQM and explicit color changes", () => {
    const f = new PaneStreamFilter({ syncFrames: false });
    const s = "\x1b[?2026$p\x1b]11;#ffffff\x07\x1b]4;1;?\x07";
    expect(run(f, s)).toBe(s);
  });

  it("drops duplicate default-color queries with either terminator at every chunk boundary", () => {
    for (const code of [10, 11]) {
      for (const end of ["\x07", "\x1b\\"]) {
        const query = `\x1b]${code};?${end}`;
        for (let at = 1; at < query.length; at++) {
          const f = new PaneStreamFilter({ syncFrames: true });
          expect(run(f, `before${query.slice(0, at)}`, `${query.slice(at)}after`)).toBe("beforeafter");
        }
      }
    }
  });

  it("brackets a cursor hide…show frame in synchronized output", () => {
    const f = new PaneStreamFilter({ syncFrames: true });
    expect(run(f, "\x1b[?25lFRAME\x1b[?25h")).toBe("\x1b[?2026h\x1b[?25lFRAME\x1b[?25h\x1b[?2026l");
  });

  it("leaves cursor visibility alone when frame sync is off", () => {
    const f = new PaneStreamFilter({ syncFrames: false });
    const s = "\x1b[?25lFRAME\x1b[?25h";
    expect(run(f, s)).toBe(s);
  });

  it("never corrupts a sequence split across chunks", () => {
    const f = new PaneStreamFilter({ syncFrames: true });
    // Query split mid-sequence: still dropped, nothing leaks as text.
    expect(run(f, "x\x1b[", "cy")).toBe("xy");
    // Cursor hide split three ways: still bracketed.
    expect(run(f, "\x1b", "[?2", "5lF\x1b[?25h")).toBe("\x1b[?2026h\x1b[?25lF\x1b[?25h\x1b[?2026l");
    // A held-back prefix that turns out to be something else is released intact.
    expect(run(f, "a\x1b[", "31mb")).toBe("a\x1b[31mb");
    expect(run(f, "a\x1b[?2", "5;1H")).toBe("a\x1b[?25;1H");
  });

  it("does not hold back a complete sequence at the end of a chunk", () => {
    const f = new PaneStreamFilter({ syncFrames: true });
    expect(run(f, "abc\x1b[?25h")).toBe("abc\x1b[?25h\x1b[?2026l");
    expect(run(f, "abc\x1b[31m")).toBe("abc\x1b[31m");
  });

  it("holds a bare trailing ESC for the next chunk", () => {
    const f = new PaneStreamFilter({ syncFrames: true });
    expect(dec(f.process(enc("abc\x1b")))).toBe("abc");
    expect(dec(f.process(enc("[cdef")))).toBe("def");
  });
});
