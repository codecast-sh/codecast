// The clipboard bridge inside the capture loop: after the viewer types, a tmux
// buffer that was not there when the typing began is offered once, redacted.
import { describe, expect, test } from "bun:test";
import { clipboardWatch, paneBufferReader, runPaneStream, splitLoneEscape } from "./paneStream.js";
import { PANE_CLIPBOARD_MAINTAIN_MS, PANE_CLIPBOARD_POLL_MS, PANE_CLIPBOARD_WINDOW_MS, PANE_MAX_CLIPBOARD_CHARS, bytesToHex } from "@codecast/shared/contracts";

function clock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("clipboardWatch", () => {
  test("offers a buffer that appears inside the window, once", () => {
    const c = clock();
    let names = ["buffer3"];
    const texts: Record<string, string> = { buffer3: "old", buffer4: "fresh copy" };
    const pushed: string[] = [];
    const w = clipboardWatch({ list: () => names, read: (k) => texts[k] ?? null, push: async (t) => { pushed.push(t); } }, c.now);
    w.maintain();
    w.arm();
    c.advance(PANE_CLIPBOARD_POLL_MS);
    w.tick();
    expect(pushed).toEqual([]);
    names = ["buffer4", "buffer3"];
    c.advance(PANE_CLIPBOARD_POLL_MS);
    w.tick();
    c.advance(PANE_CLIPBOARD_POLL_MS);
    w.tick();
    expect(pushed).toEqual(["fresh copy"]);
  });

  test("a buffer that vanished does not make an old one look new", () => {
    const c = clock();
    let names = ["buffer4", "buffer3"];
    const pushed: string[] = [];
    const w = clipboardWatch({ list: () => names, read: () => "old", push: async (t) => { pushed.push(t); } }, c.now);
    w.maintain();
    w.arm();
    names = ["buffer3"];
    c.advance(PANE_CLIPBOARD_POLL_MS);
    w.tick();
    expect(pushed).toEqual([]);
  });

  test("a keystroke costs no tmux call; looks happen on the loop's own clock", () => {
    const c = clock();
    let calls = 0;
    const w = clipboardWatch({ list: () => { calls++; return ["buffer9"]; }, read: () => "x", push: async () => {} }, c.now);
    w.maintain();
    expect(calls).toBe(1);
    w.arm();
    w.arm();
    expect(calls).toBe(1);
    w.maintain();
    expect(calls).toBe(1);
    c.advance(PANE_CLIPBOARD_MAINTAIN_MS);
    w.maintain();
    expect(calls).toBe(2);
  });

  test("nothing outside the window", () => {
    const c = clock();
    let calls = 0;
    const w = clipboardWatch({ list: () => { calls++; return ["buffer9"]; }, read: () => "x", push: async () => {} }, c.now);
    w.tick();
    expect(calls).toBe(0);
    w.maintain();
    w.arm();
    c.advance(PANE_CLIPBOARD_WINDOW_MS + 1);
    const before = calls;
    w.tick();
    expect(calls).toBe(before);
  });

  test("a bridge that went off (terminal attached) opens no window", () => {
    const c = clock();
    let names: string[] | null = ["buffer1"];
    const pushed: string[] = [];
    const w = clipboardWatch({ list: () => names, read: () => "x", push: async (t) => { pushed.push(t); } }, c.now);
    w.maintain();
    names = null;
    c.advance(PANE_CLIPBOARD_MAINTAIN_MS);
    w.maintain();
    w.arm();
    names = ["buffer2", "buffer1"];
    c.advance(PANE_CLIPBOARD_POLL_MS);
    w.tick();
    expect(pushed).toEqual([]);
  });

  test("polls at most every PANE_CLIPBOARD_POLL_MS", () => {
    const c = clock();
    let calls = 0;
    const w = clipboardWatch({ list: () => { calls++; return []; }, read: () => null, push: async () => {} }, c.now);
    w.maintain();
    w.arm();
    const armed = calls;
    for (let i = 0; i < 10; i++) { c.advance(100); w.tick(); }
    expect(calls - armed).toBe(1);
  });

  test("the offer is redacted before it is cut", () => {
    const c = clock();
    let names: string[] = [];
    const pushed: string[] = [];
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const w = clipboardWatch({ list: () => names, read: () => "x".repeat(PANE_MAX_CLIPBOARD_CHARS - 10) + secret, push: async (t) => { pushed.push(t); } }, c.now);
    w.maintain();
    w.arm();
    names = ["buffer0"];
    c.advance(PANE_CLIPBOARD_POLL_MS);
    w.tick();
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).not.toContain(secret.slice(0, 12));
    expect(pushed[0].length).toBeLessThanOrEqual(PANE_MAX_CLIPBOARD_CHARS);
  });

  test("a baseline tmux could not list opens no window, so old buffers are never offered", () => {
    const c = clock();
    let names: string[] | null = null;
    const pushed: string[] = [];
    const w = clipboardWatch({ list: () => names, read: () => "old token", push: async (t) => { pushed.push(t); } }, c.now);
    w.maintain();
    w.arm();
    names = ["buffer7"];
    c.advance(PANE_CLIPBOARD_POLL_MS);
    w.tick();
    expect(pushed).toEqual([]);
  });

  test("a tmux failure is no offer, never a throw", () => {
    const c = clock();
    const w = clipboardWatch({ list: () => { throw new Error("no server"); }, read: () => null, push: async () => {} }, c.now);
    w.maintain();
    w.arm();
    c.advance(PANE_CLIPBOARD_POLL_MS);
    expect(() => w.tick()).not.toThrow();
  });
});

describe("splitLoneEscape", () => {
  test("a lone Esc before an arrow goes alone; sequences stay whole", () => {
    expect(splitLoneEscape([0x1b, 0x1b, 0x5b, 0x41])).toEqual([[0x1b], [0x1b, 0x5b, 0x41]]);
    expect(splitLoneEscape([0x1b, 0x5b, 0x41, 0x0d])).toEqual([[0x1b, 0x5b, 0x41, 0x0d]]);
    expect(splitLoneEscape([0x61, 0x1b, 0x1b, 0x1b])).toEqual([[0x61, 0x1b], [0x1b], [0x1b]]);
  });
});

describe("paneBufferReader", () => {
  test("stays off for a pane without its own tmux server", () => {
    expect(paneBufferReader("cc-no-such-session-zz")).toBeNull();
    expect(paneBufferReader("%3")).toBeNull();
  });
});

describe("runPaneStream with the bridge", () => {
  test("typed input arms the window and the new buffer is pushed", async () => {
    const c = clock();
    let pushes = 0;
    let names = ["buffer1"];
    const offers: string[] = [];
    await runPaneStream("cc-test", {
      capture: () => ({ frame: "screen", cols: 80, rows: 24, cursorX: 0, cursorY: 0 }),
      push: async () => {
        pushes++;
        if (pushes === 2) return { stop: false, input: bytesToHex(new TextEncoder().encode("\r")) };
        return { stop: pushes > 40 };
      },
      write: () => { names = ["buffer2", "buffer1"]; },
      now: c.now,
      sleep: async (ms) => c.advance(ms),
      clipboard: { list: () => names, read: (k) => (k === "buffer2" ? "selected text" : null), push: async (t) => { offers.push(t); } },
    });
    expect(offers).toEqual(["selected text"]);
  });

  test("without typing, the loop looks at tmux only on the maintenance clock", async () => {
    const c = clock();
    let pushes = 0;
    let asked = 0;
    await runPaneStream("cc-test", {
      capture: () => ({ frame: "screen", cols: 80, rows: 24, cursorX: 0, cursorY: 0 }),
      push: async () => ({ stop: ++pushes > 20 }),
      write: () => {},
      now: c.now,
      sleep: async (ms) => c.advance(ms),
      clipboard: { list: () => { asked++; return []; }, read: () => null, push: async () => {} },
    });
    expect(asked).toBeLessThanOrEqual(Math.ceil(c.now() / PANE_CLIPBOARD_MAINTAIN_MS) + 1);
  });

  test("Esc then an arrow, drained together, reach the pane as two writes", async () => {
    const c = clock();
    let pushes = 0;
    const writes: number[][] = [];
    await runPaneStream("cc-test", {
      capture: () => ({ frame: "screen", cols: 80, rows: 24, cursorX: 0, cursorY: 0 }),
      push: async () => {
        pushes++;
        if (pushes === 2) return { stop: false, input: "1b1b5b41" };
        return { stop: pushes > 6 };
      },
      write: (_t, b) => { writes.push(b); },
      now: c.now,
      sleep: async (ms) => c.advance(ms),
    });
    expect(writes).toEqual([[0x1b], [0x1b, 0x5b, 0x41]]);
  });
});
