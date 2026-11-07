import { describe, expect, it } from "bun:test";
import { OutputRing } from "./terminalHub.js";

const out = (s: string) => Buffer.from(s);
const text = (recs: ReturnType<OutputRing["since"]>) =>
  (recs ?? []).map((r) => (r.kind === "output" ? r.data.toString() : `[reseed ${r.cols}x${r.rows}:${r.seed.toString()}]`)).join("");

describe("OutputRing", () => {
  it("addresses output by absolute byte offset and trims the first record to the cursor", () => {
    const ring = new OutputRing();
    ring.appendOutput(out("hello "));
    ring.appendOutput(out("world"));
    expect(ring.offset).toBe(11);
    expect(text(ring.since(0))).toBe("hello world");
    expect(text(ring.since(3))).toBe("lo world");
    expect(text(ring.since(6))).toBe("world");
    expect(ring.since(11)).toEqual([]);
  });

  it("gives a reseed one offset, so a cursor on either side of it is unambiguous", () => {
    const ring = new OutputRing();
    ring.appendOutput(out("ab"));
    const rec = ring.appendReseed({ cols: 90, rows: 20, seed: out("SCREEN") });
    ring.appendOutput(out("cd"));
    expect(rec.start).toBe(2);
    expect(ring.offset).toBe(5);
    expect(text(ring.since(2))).toBe("[reseed 90x20:SCREEN]cd");
    // Past the reseed (the viewer has it): only what followed.
    expect(text(ring.since(3))).toBe("cd");
  });

  it("refuses a cursor it no longer holds, or never reached", () => {
    const ring = new OutputRing(10);
    ring.appendOutput(out("0123456789"));
    ring.appendOutput(out("abcde"));
    // The first record was evicted to stay within 10 bytes.
    expect(ring.start).toBe(10);
    expect(ring.since(4)).toBeNull();
    expect(text(ring.since(10))).toBe("abcde");
    expect(ring.since(16)).toBeNull();
    expect(ring.since(-1)).toBeNull();
    expect(ring.since(1.5)).toBeNull();
  });

  it("keeps the newest record even when it alone outgrows the ring", () => {
    const ring = new OutputRing(4);
    ring.appendOutput(out("xy"));
    ring.appendOutput(out("a much longer burst"));
    expect(ring.start).toBe(2);
    expect(text(ring.since(2))).toBe("a much longer burst");
  });

  it("starts at the live edge when empty", () => {
    const ring = new OutputRing();
    expect(ring.since(0)).toEqual([]);
    ring.appendOutput(Buffer.alloc(0));
    expect(ring.offset).toBe(0);
  });
});
