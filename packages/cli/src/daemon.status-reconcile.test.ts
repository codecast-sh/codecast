import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { classifyTranscriptTail, paneReconcileTarget, reconciledStatus } from "./daemon.js";
import type { TranscriptTurnState } from "./daemon.js";

// Regression test for the "session stuck in 'working' (or 'stopped') forever" bug,
// re-surfaced via session jx770k5 (2026-05-24). The status hook is a last-write-wins
// latch; when a terminal transition is lost end-to-end the daemon's local
// lastSentAgentStatus freezes and the heartbeat re-broadcasts the wrong value
// forever. We reconcile it against the JSONL transcript -- the universal ground
// truth that exists for every session (tmux-managed or bare-terminal alike).
//
// The contract is "can never be wrong in either direction": correct ONLY on a
// positive structural signal, defer (null / "unknown") on anything ambiguous.

// Fixtures mirror the real Claude JSONL shape observed on disk.
const asst = (stop_reason: string | null) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason, content: [{ type: "text", text: "hi" }] } });
const userMsg = (kind: "prompt" | "tool_result") =>
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: kind === "tool_result" ? "tool_result" : "text" }] } });
const sysMeta = () => JSON.stringify({ type: "system", subtype: "hook", content: [] });

describe("classifyTranscriptTail", () => {
  test("last assistant turn ended -> idle", () => {
    expect(classifyTranscriptTail(asst("end_turn"))).toBe("idle");
    expect(classifyTranscriptTail(asst("stop_sequence"))).toBe("idle");
    expect(classifyTranscriptTail(asst("max_tokens"))).toBe("idle");
  });

  test("mid-turn (pending tool_use) -> active", () => {
    expect(classifyTranscriptTail(asst("tool_use"))).toBe("active");
  });

  test("ball in the agent's court (user prompt or tool_result) -> active", () => {
    expect(classifyTranscriptTail(userMsg("prompt"))).toBe("active");
    expect(classifyTranscriptTail(userMsg("tool_result"))).toBe("active");
  });

  test("skips trailing system/meta lines to find the last real turn", () => {
    // The exact b09ad864 shape: an end_turn assistant turn followed by a system line.
    expect(classifyTranscriptTail([asst("end_turn"), sysMeta()].join("\n"))).toBe("idle");
    expect(classifyTranscriptTail([asst("tool_use"), sysMeta(), sysMeta()].join("\n"))).toBe("active");
  });

  test("skips a partial/corrupt final line (mid-write tail)", () => {
    expect(classifyTranscriptTail([asst("end_turn"), '{"type":"assist'].join("\n"))).toBe("idle");
  });

  test("streaming / unrecognized stop_reason -> unknown (defer)", () => {
    expect(classifyTranscriptTail(asst(null))).toBe("unknown");
    expect(classifyTranscriptTail(asst("pause_turn"))).toBe("unknown");
  });

  test("no parseable real message -> unknown (defer)", () => {
    expect(classifyTranscriptTail("")).toBe("unknown");
    expect(classifyTranscriptTail([sysMeta(), sysMeta()].join("\n"))).toBe("unknown");
    expect(classifyTranscriptTail("not json at all")).toBe("unknown");
  });
});

describe("reconciledStatus", () => {
  test("active + ended turn -> idle (the lost-Stop-hook case)", () => {
    expect(reconciledStatus("working", "idle")).toBe("idle");
    expect(reconciledStatus("thinking", "idle")).toBe("idle");
  });

  test("NEVER flips a genuinely mid-turn session to idle", () => {
    // A long tool run reads as active. Flipping it to idle would make it eligible
    // for the auto-kill -> wrongful kill. AskUserQuestion-blocked is also active.
    expect(reconciledStatus("working", "active")).toBeNull();
    expect(reconciledStatus("thinking", "active")).toBeNull();
  });

  test("quiet + mid-turn -> working (inverse: a lost activity hook)", () => {
    expect(reconciledStatus("idle", "active")).toBe("working");
    expect(reconciledStatus("connected", "active")).toBe("working");
  });

  test("no correction when the transcript already agrees", () => {
    expect(reconciledStatus("idle", "idle")).toBeNull();
    expect(reconciledStatus("working", "active")).toBeNull();
    expect(reconciledStatus("connected", "idle")).toBeNull();
  });

  test("defers on unknown turn state in both directions", () => {
    expect(reconciledStatus("working", "unknown")).toBeNull();
    expect(reconciledStatus("idle", "unknown")).toBeNull();
  });

  test("never touches statuses owned by other code paths", () => {
    const turns: TranscriptTurnState[] = ["idle", "active", "unknown"];
    for (const stored of ["permission_blocked", "resuming", "compacting", "stopped"] as const) {
      for (const turn of turns) expect(reconciledStatus(stored, turn)).toBeNull();
    }
    for (const turn of turns) expect(reconciledStatus(undefined, turn)).toBeNull();
  });
});

// Pane-state reconcile: the tmux counterpart that fixes the jx770k5 holdout — a
// finished agent sitting at an idle prompt whose status was latched at "working"
// (lost Stop hook + a daemon restart that wiped lastSentAgentStatus, after which
// the heartbeat re-asserted the server's stale "working" forever). The transcript
// can't catch this (the killed-mid-tool turn reads "active"); the live pane can.
describe("paneReconcileTarget", () => {
  test("idle pane + stale-active status -> idle (the latch fix)", () => {
    expect(paneReconcileTarget("idle", "working")).toBe("idle");
    expect(paneReconcileTarget("idle", "thinking")).toBe("idle");
    expect(paneReconcileTarget("idle", "connected")).toBe("idle");
  });

  test("idle pane + post-restart unknown status -> idle (the b09ad864 case)", () => {
    // After a daemon restart the in-memory latch is empty; the pane is the only
    // signal left, and it says idle.
    expect(paneReconcileTarget("idle", undefined)).toBe("idle");
  });

  test("busy pane + quiet/unknown status -> working (inverse: lost activity hook)", () => {
    expect(paneReconcileTarget("busy", "idle")).toBe("working");
    expect(paneReconcileTarget("busy", "connected")).toBe("working");
    expect(paneReconcileTarget("busy", undefined)).toBe("working");
  });

  test("no correction when the pane already agrees", () => {
    expect(paneReconcileTarget("idle", "idle")).toBeNull();
    expect(paneReconcileTarget("busy", "working")).toBeNull();
    expect(paneReconcileTarget("busy", "thinking")).toBeNull();
  });

  test("never overrides statuses owned by other code paths", () => {
    // permission_blocked / resuming are not bare idle/busy panes anyway, but be
    // explicit: the pane reconcile must not stomp them or a terminal "stopped".
    for (const stored of ["permission_blocked", "resuming", "stopped"] as const) {
      expect(paneReconcileTarget("idle", stored)).toBeNull();
      expect(paneReconcileTarget("busy", stored)).toBeNull();
    }
  });

  test("defers on modal / exited / unknown panes", () => {
    for (const state of ["interrupted", "rewind", "warning", "exited", "unknown"] as const) {
      expect(paneReconcileTarget(state, "working")).toBeNull();
      expect(paneReconcileTarget(state, undefined)).toBeNull();
    }
  });
});

// E2E: validate the classifier against a real on-disk transcript tail. Guarded so
// it skips cleanly on machines/CI without the fixture. Proves the structural parse
// works on actual Claude JSONL bytes, not just synthesized fixtures.
describe("classifyTranscriptTail on real transcripts", () => {
  const dir = `${process.env.HOME}/.claude/projects/-Users-ashot-src-codecast`;
  const present = (() => { try { return fs.existsSync(dir); } catch { return false; } })();
  test.if(present)("every local transcript classifies to a known turn-state", () => {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl")).slice(0, 12);
    for (const f of files) {
      const p = `${dir}/${f}`;
      const fd = fs.openSync(p, "r");
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - 65536);
      const buf = Buffer.allocUnsafe(size - start);
      fs.readSync(fd, buf, 0, size - start, start);
      fs.closeSync(fd);
      const turn = classifyTranscriptTail(buf.toString("utf8"));
      expect(["idle", "active", "unknown"]).toContain(turn);
    }
  });
});
