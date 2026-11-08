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

  it("lets a repaint supersede what came before it, keeping older cursors resumable", () => {
    const ring = new OutputRing();
    ring.appendOutput(out("old output"));
    ring.appendReseed({ cols: 80, rows: 24, seed: out("S1") });
    ring.appendOutput(out("x"));
    ring.appendReseed({ cols: 90, rows: 20, seed: out("S2") });
    ring.appendOutput(out("tail"));
    // Only the newest repaint and what followed are kept...
    expect(text(ring.since(ring.start))).toBe("[reseed 90x20:S2]tail");
    // ...and a cursor from before it still resumes, through that repaint.
    expect(ring.start).toBe(0);
    expect(text(ring.since(3))).toBe("[reseed 90x20:S2]tail");
  });

  it("cut makes every earlier cursor need a fresh screen", () => {
    const ring = new OutputRing();
    ring.appendOutput(out("before"));
    ring.cut();
    ring.appendOutput(out("after"));
    expect(ring.since(2)).toBeNull();
    expect(text(ring.since(6))).toBe("after");
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

describe("TerminalHub backpressure", () => {
  // A viewer's first screen comes from a command whose reply rides the same
  // stdout as pane output. With tmux paused because every live viewer is
  // backed up, that reply never comes: the joiner waited out the command
  // timeout and opened on a blank screen.
  it("unpauses tmux while a viewer is joining", async () => {
    const { TerminalHub } = await import("./terminalHub.js");
    const { EventEmitter } = await import("node:events");
    let paused = false;
    let pausedAtCapture = null as boolean | null;
    let events!: import("./controlClient.js").ControlClientEvents;
    const client = {
      restoresTo: null,
      start: async () => ({ cols: 80, rows: 24, sessionName: "cast-term-bp" }),
      capture: async (cb: (c: { cols: number; rows: number; seed: Buffer }) => void) => {
        pausedAtCapture = paused;
        cb({ cols: 80, rows: 24, seed: Buffer.from("SCREEN") });
        return true;
      },
      setSizing: async () => {},
      sendInput: () => {},
      resize: () => {},
      setColors: async () => {},
      pauseOutput: () => { paused = true; },
      resumeOutput: () => { paused = false; },
      killSession: async () => {},
      close: () => {},
      closeSync: () => {},
    };
    const hub = new TerminalHub({ kind: "create", sessionName: "cast-term-bp" }, {
      log: () => {},
      onDispose: () => {},
      makeClient: (_m, e) => { events = e; return client as never; },
    });
    const sock = () => Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, send() {}, close() {}, terminate() {} });
    await hub.start(80, 24);
    const a = sock();
    await hub.join(a as never, { viewId: null, canControl: true, resume: null });
    a.bufferedAmount = 5_000_000;
    events.onOutput(Buffer.from("flood"));
    expect(paused).toBe(true);

    const b = sock();
    await hub.join(b as never, { viewId: null, canControl: true, resume: null });
    expect(pausedAtCapture).toBe(false);
    // The joiner keeps up, so tmux stays unpaused for it.
    expect(paused).toBe(false);
    hub.shutdown();
  });
});
