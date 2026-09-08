import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { runPaneStream } from "./terminal/paneStream.js";
import {
  INTERRUPT_SETTLE_MS,
  classifyInputBytes,
  createKeystrokeInference,
  isInterruptibleTurn,
  readAskInputSidecar,
  singleSelectOptionCount,
  type InferenceBaseline,
  type InferenceOutcome,
  type InputIntent,
  type KeystrokeInference,
} from "./keystrokeInference.js";

const SID = "11111111-2222-3333-4444-555555555555";

describe("classifyInputBytes", () => {
  it("reads the keystrokes the inference acts on", () => {
    expect(classifyInputBytes([0x03])).toEqual({ kind: "ctrl-c" });
    expect(classifyInputBytes([0x1b])).toEqual({ kind: "escape" });
    expect(classifyInputBytes([0x0d])).toEqual({ kind: "enter" });
    expect(classifyInputBytes([0x0a])).toEqual({ kind: "enter" });
    expect(classifyInputBytes([0x0d, 0x0a])).toEqual({ kind: "enter" });
    expect(classifyInputBytes(Buffer.from("\x1b[13u"))).toEqual({ kind: "enter" });
    expect(classifyInputBytes(Buffer.from("\x1b[13;1u"))).toEqual({ kind: "enter" });
    expect(classifyInputBytes([0x33])).toEqual({ kind: "digit", value: 3 });
  });

  it("reads nothing out of anything longer than one keystroke", () => {
    expect(classifyInputBytes(Buffer.from("hello"))).toBeNull();
    // A paste that merely CONTAINS an escape or a digit is not a keypress.
    expect(classifyInputBytes(Buffer.from("run 3 tests\x1b"))).toBeNull();
    expect(classifyInputBytes([])).toBeNull();
    expect(classifyInputBytes([0x30])).toBeNull();
    expect(classifyInputBytes(Buffer.from("\x1b[A"))).toBeNull();
  });
});

describe("singleSelectOptionCount", () => {
  it("counts the options of a one-question single select", () => {
    expect(singleSelectOptionCount([{ options: [{ label: "a" }, { label: "b" }] }])).toBe(2);
  });

  it("rules digits out for every shape one keystroke cannot finish", () => {
    expect(singleSelectOptionCount([{ multiSelect: true, options: [{ label: "a" }] }])).toBeNull();
    expect(singleSelectOptionCount([{ options: [] }, { options: [] }])).toBeNull();
    expect(singleSelectOptionCount([{ question: "no options" }])).toBeNull();
    expect(singleSelectOptionCount(undefined)).toBeNull();
    expect(singleSelectOptionCount([])).toBeNull();
  });
});

describe("isInterruptibleTurn", () => {
  it("covers a producing turn but not a permission prompt", () => {
    expect(isInterruptibleTurn("working")).toBe(true);
    expect(isInterruptibleTurn("thinking")).toBe(true);
    expect(isInterruptibleTurn("compacting")).toBe(true);
    // Escape there declines the tool; the agent carries on.
    expect(isInterruptibleTurn("permission_blocked")).toBe(false);
    expect(isInterruptibleTurn("idle")).toBe(false);
    expect(isInterruptibleTurn("done")).toBe(false);
  });
});

// A test rig standing in for the daemon: one mutable status row, one AUQ wait
// flag, one sidecar answer, and a timer the test fires by hand.
function rig(overrides: { optionCount?: number | null } = {}) {
  const state = {
    baseline: <InferenceBaseline | null>{
      status: "working",
      statusSentAt: 1_000,
      turnStartedAt: 500,
      agentType: "claude",
    },
    awaiting: false,
    optionCount: overrides.optionCount ?? null,
    interrupted: <string[]>[],
    answered: <string[]>[],
    now: 1_100,
  };
  let armed: (() => void) | null = null;
  const inference: KeystrokeInference = createKeystrokeInference({
    readBaseline: () => state.baseline,
    isAwaitingQuestion: () => state.awaiting,
    readOptionCount: async () => state.optionCount,
    writeInterrupted: (sessionId) => { state.interrupted.push(sessionId); },
    writeQuestionAnswered: (sessionId) => { state.answered.push(sessionId); },
    now: () => state.now,
    setTimer: (fn) => { armed = fn; return 0 as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: () => { armed = null; },
  });
  return {
    state,
    inference,
    isArmed: () => armed !== null,
    /** Fire the 500ms settle timer the way the event loop would. */
    settle: () => {
      const fn = armed;
      armed = null;
      state.now += INTERRUPT_SETTLE_MS;
      fn?.();
    },
    observe: (intent: InputIntent): Promise<InferenceOutcome> => inference.observeInput(SID, intent),
  };
}

describe("interrupt inference", () => {
  it("writes the interrupted turn end when no hook arrives", async () => {
    const r = rig();
    expect(await r.observe({ kind: "ctrl-c" })).toBe("armed");
    expect(r.state.interrupted).toEqual([]);
    r.settle();
    expect(r.state.interrupted).toEqual([SID]);
  });

  it("arms on Escape too", async () => {
    const r = rig();
    expect(await r.observe({ kind: "escape" })).toBe("armed");
    r.settle();
    expect(r.state.interrupted).toEqual([SID]);
  });

  it("stands down when a late hook moved the status row", async () => {
    const r = rig();
    await r.observe({ kind: "ctrl-c" });
    // The real Stop hook lands inside the settle window.
    r.state.baseline = { status: "idle", statusSentAt: 1_200, turnStartedAt: 500, agentType: "claude" };
    r.settle();
    expect(r.state.interrupted).toEqual([]);
  });

  it("stands down when a late hook re-asserted working at a new time", async () => {
    const r = rig();
    await r.observe({ kind: "ctrl-c" });
    r.state.baseline = { status: "working", statusSentAt: 1_250, turnStartedAt: 500, agentType: "claude" };
    r.settle();
    expect(r.state.interrupted).toEqual([]);
  });

  it("stands down when a new turn started inside the window", async () => {
    const r = rig();
    await r.observe({ kind: "ctrl-c" });
    r.state.baseline = { status: "working", statusSentAt: 1_000, turnStartedAt: 1_050, agentType: "claude" };
    r.settle();
    expect(r.state.interrupted).toEqual([]);
  });

  it("stands down when the row was rebuilt under a different agent", async () => {
    const r = rig();
    await r.observe({ kind: "ctrl-c" });
    r.state.baseline = { status: "working", statusSentAt: 1_000, turnStartedAt: 500, agentType: "codex" };
    r.settle();
    expect(r.state.interrupted).toEqual([]);
  });

  it("does nothing on a session that is not producing", async () => {
    const r = rig();
    r.state.baseline = { status: "idle", statusSentAt: 1_000, turnStartedAt: 500, agentType: "claude" };
    expect(await r.observe({ kind: "ctrl-c" })).toBe("ignored");
    expect(r.isArmed()).toBe(false);
  });

  it("does nothing when nothing is known about the session", async () => {
    const r = rig();
    r.state.baseline = null;
    expect(await r.observe({ kind: "escape" })).toBe("ignored");
  });

  it("drops an armed interrupt on cancel", async () => {
    const r = rig();
    await r.observe({ kind: "ctrl-c" });
    r.inference.cancel(SID);
    expect(r.inference.flushPending(SID)).toBe("ignored");
    expect(r.state.interrupted).toEqual([]);
  });

  it("does nothing on Enter over a plain working session", async () => {
    const r = rig();
    expect(await r.observe({ kind: "enter" })).toBe("ignored");
    expect(await r.observe({ kind: "digit", value: 2 })).toBe("ignored");
    expect(r.isArmed()).toBe(false);
    expect(r.state.interrupted).toEqual([]);
    expect(r.state.answered).toEqual([]);
  });
});

describe("AskUserQuestion answer inference", () => {
  function waiting(optionCount: number | null) {
    const r = rig({ optionCount });
    r.state.awaiting = true;
    r.state.baseline = { status: "permission_blocked", statusSentAt: 1_000, turnStartedAt: 500, agentType: "claude" };
    return r;
  }

  it("clears the wait on Enter", async () => {
    const r = waiting(3);
    expect(await r.observe({ kind: "enter" })).toBe("answered");
    expect(r.state.answered).toEqual([SID]);
  });

  it("clears the wait on a digit inside the declared option count", async () => {
    const r = waiting(3);
    expect(await r.observe({ kind: "digit", value: 3 })).toBe("answered");
    expect(r.state.answered).toEqual([SID]);
  });

  it("leaves the wait alone on a digit past the declared options", async () => {
    const r = waiting(3);
    // 4 is Claude's trailing "Type something" row: it opens an editor and the
    // session stays blocked.
    expect(await r.observe({ kind: "digit", value: 4 })).toBe("ignored");
    expect(r.state.answered).toEqual([]);
  });

  it("leaves the wait alone on a digit when the prompt shape rules digits out", async () => {
    const r = waiting(null);
    expect(await r.observe({ kind: "digit", value: 1 })).toBe("ignored");
    // Enter is still the ordinary submit path, whatever the shape.
    expect(await r.observe({ kind: "enter" })).toBe("answered");
  });

  it("clears the wait on Escape, which dismisses the question", async () => {
    const r = waiting(3);
    expect(await r.observe({ kind: "escape" })).toBe("answered");
    expect(r.state.answered).toEqual([SID]);
    // Dismissing a question is not interrupting a turn.
    expect(r.isArmed()).toBe(false);
    expect(r.state.interrupted).toEqual([]);
  });

  it("infers nothing from Ctrl+C at a question", async () => {
    const r = waiting(3);
    expect(await r.observe({ kind: "ctrl-c" })).toBe("ignored");
    expect(r.state.answered).toEqual([]);
    expect(r.isArmed()).toBe(false);
  });

  it("stands down when the wait closed while the sidecar was being read", async () => {
    const r = waiting(3);
    r.state.optionCount = 3;
    const pending = r.observe({ kind: "digit", value: 1 });
    // The real answer's hook lands while the async sidecar read is in flight.
    r.state.awaiting = false;
    expect(await pending).toBe("ignored");
    expect(r.state.answered).toEqual([]);
  });

  it("stands down when a hook moved the status row during the sidecar read", async () => {
    const r = waiting(3);
    const pending = r.observe({ kind: "digit", value: 1 });
    r.state.baseline = { status: "working", statusSentAt: 1_090, turnStartedAt: 500, agentType: "claude" };
    expect(await pending).toBe("ignored");
    expect(r.state.answered).toEqual([]);
  });

  it("cancels an armed interrupt when a question opens over it", async () => {
    const r = rig({ optionCount: 2 });
    expect(await r.observe({ kind: "ctrl-c" })).toBe("armed");
    r.state.awaiting = true;
    r.state.baseline = { status: "permission_blocked", statusSentAt: 1_050, turnStartedAt: 500, agentType: "claude" };
    expect(await r.observe({ kind: "enter" })).toBe("answered");
    expect(r.isArmed()).toBe(false);
    expect(r.state.interrupted).toEqual([]);
  });
});

describe("ask-input sidecar", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-askinput-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function write(sessionId: string, body: unknown): string {
    const dir = path.join(home, ".codecast", "ask-input");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sessionId}.json`);
    fs.writeFileSync(file, JSON.stringify(body));
    return dir;
  }

  it("reads the option count the status hook dropped", async () => {
    const dir = write(SID, { questions: [{ question: "pick", options: [{ label: "a" }, { label: "b" }] }] });
    const sidecar = await readAskInputSidecar(dir, SID, Date.now());
    expect(singleSelectOptionCount(sidecar?.questions)).toBe(2);
  });

  it("ignores a sidecar older than the freshness window", async () => {
    const dir = write(SID, { questions: [{ options: [{ label: "a" }] }] });
    // The sidecar is never deleted, so an old one is a question answered long ago.
    expect(await readAskInputSidecar(dir, SID, Date.now() + 10 * 60_000)).toBeNull();
  });

  it("returns null for a session that never asked", async () => {
    const dir = write(SID, { questions: [{ options: [] }] });
    expect(await readAskInputSidecar(dir, "other-session", Date.now())).toBeNull();
  });

  it("returns null for a malformed sidecar", async () => {
    const dir = path.join(home, ".codecast", "ask-input");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${SID}.json`), "{not json");
    expect(await readAskInputSidecar(dir, SID, Date.now())).toBeNull();
  });
});

describe("pane stream input observation", () => {
  // A pane stream that hands back one hex payload and then stops, so the input
  // reaches the same seam the daemon wires observePaneInput into.
  async function feed(hex: string): Promise<InputIntent | null> {
    let seen: InputIntent | null = null;
    let pushes = 0;
    let clock = 0;
    await runPaneStream("cc-claude-abc:0.0", {
      capture: () => ({ frame: "screen", cols: 80, rows: 24, cursorX: 0, cursorY: 0 }),
      push: async () => (pushes++ === 0 ? { stop: false, input: hex } : { stop: true }),
      write: (_target, bytes) => { seen = classifyInputBytes(bytes); },
      now: () => (clock += 100),
      sleep: async () => {},
    });
    return seen;
  }

  it("sees a Ctrl+C the viewer typed", async () => {
    expect(await feed("03")).toEqual({ kind: "ctrl-c" });
  });

  it("sees an option digit the viewer typed", async () => {
    expect(await feed("32")).toEqual({ kind: "digit", value: 2 });
  });

  it("reads nothing out of a pasted line", async () => {
    expect(await feed(Buffer.from("ship it\r").toString("hex"))).toBeNull();
  });
});
