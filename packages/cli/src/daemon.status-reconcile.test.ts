import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { classifyCodexTranscriptTail, classifyTranscriptTail, findCachedSessionIdForConversation, isInterruptControlMessage, paneReconcileTarget, reconciledStatus, transcriptTailLastRealRole, permissionBlockedRecoveryTarget } from "./daemon.js";
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
// The synthetic control message Claude Code appends when the user interrupts a
// turn. Both on-disk shapes occur: a text content-block array, and a raw string.
const interruptMsg = (shape: "block" | "string" = "block", text = "[Request interrupted by user]") =>
  JSON.stringify({ type: "user", message: { role: "user", content: shape === "string" ? text : [{ type: "text", text }] } });

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

  test("trailing interrupt control message -> idle, not active (the bare-terminal bug)", () => {
    // The user pressed ESC mid-turn; the agent is parked at the prompt. Reading
    // this as "active" is what latched interrupted bare-terminal sessions in
    // "working" forever (the reconcile heartbeat re-derived active every cycle).
    expect(classifyTranscriptTail(interruptMsg("block"))).toBe("idle");
    expect(classifyTranscriptTail(interruptMsg("string"))).toBe("idle");
    expect(classifyTranscriptTail(interruptMsg("string", "[Request cancelled]"))).toBe("idle");
    // Trailing system/meta after the interrupt (mode / permission-mode lines that
    // Claude Code writes last) must not hide it.
    expect(classifyTranscriptTail([interruptMsg("block"), sysMeta()].join("\n"))).toBe("idle");
  });

  test("interrupt detection does not misfire on a real prompt that merely mentions one", () => {
    // A genuine user prompt is still the agent's move, even if its text discusses
    // interrupts — only a leading control marker counts.
    expect(classifyTranscriptTail(interruptMsg("string", "fix the [Request interrupted] handling"))).toBe("active");
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

describe("isInterruptControlMessage", () => {
  test("matches the interrupt/cancel control markers (leading, after trim)", () => {
    expect(isInterruptControlMessage("[Request interrupted by user]")).toBe(true);
    expect(isInterruptControlMessage("[Request interrupted by user for tool use]")).toBe(true);
    expect(isInterruptControlMessage("[Request cancelled]")).toBe(true);
    expect(isInterruptControlMessage("  \n[Request interrupted by user]")).toBe(true);
  });
  test("does not match ordinary prompts or empty/nullish input", () => {
    expect(isInterruptControlMessage("please continue")).toBe(false);
    expect(isInterruptControlMessage("see [Request interrupted] note")).toBe(false);
    expect(isInterruptControlMessage("")).toBe(false);
    expect(isInterruptControlMessage(null)).toBe(false);
    expect(isInterruptControlMessage(undefined)).toBe(false);
  });
});

// End-to-end: the exact bug. A bare-terminal session latched at "working" whose
// transcript ends in a user interrupt must reconcile to "idle" — which is what
// lets the server/web route it into NEEDS INPUT. Before the fix the interrupt
// read as "active" and reconciledStatus left it (or flipped it back to) working.
describe("interrupted bare-terminal session reconciles to idle (the full chain)", () => {
  test("working + interrupt tail -> idle", () => {
    const turn = classifyTranscriptTail([asst("tool_use"), interruptMsg("block")].join("\n"));
    expect(turn).toBe("idle");
    expect(reconciledStatus("working", turn)).toBe("idle");
  });
  test("once idle, the interrupt tail no longer flips it back to working", () => {
    const turn = classifyTranscriptTail(interruptMsg("string"));
    expect(reconciledStatus("idle", turn)).toBeNull();
  });
});

// Codex has no Stop-hook equivalent and its watcher-driven idle transition rides a
// setTimeout that dies across macOS sleep, so the heartbeat-driven transcript
// reconcile is its only durable latch recovery. These fixtures mirror the real
// ~/.codex rollout JSONL shape (event_msg turn-boundary records).
const codexEvt = (type: string) => JSON.stringify({ type: "event_msg", payload: { type } });
const codexResp = (ptype: string) => JSON.stringify({ type: "response_item", payload: { type: ptype } });

describe("classifyCodexTranscriptTail", () => {
  test("turn completed -> idle (the latched-working case)", () => {
    expect(classifyCodexTranscriptTail(codexEvt("task_complete"))).toBe("idle");
    expect(classifyCodexTranscriptTail(codexEvt("turn_aborted"))).toBe("idle");
  });

  test("turn in flight (task_started / fresh user_message) -> active", () => {
    expect(classifyCodexTranscriptTail(codexEvt("task_started"))).toBe("active");
    expect(classifyCodexTranscriptTail(codexEvt("user_message"))).toBe("active");
  });

  test("scans past intra-turn noise to the last boundary event", () => {
    // Real tail shape: a completed turn trailed by token_count / agent_message /
    // response_item deltas — must still read as idle.
    expect(classifyCodexTranscriptTail([
      codexEvt("task_started"),
      codexResp("function_call"),
      codexEvt("agent_message"),
      codexEvt("task_complete"),
      codexEvt("token_count"),
      codexResp("message"),
    ].join("\n"))).toBe("idle");
  });

  test("a new turn after a completed one reads as active", () => {
    expect(classifyCodexTranscriptTail([
      codexEvt("task_complete"),
      codexEvt("user_message"),
      codexEvt("task_started"),
    ].join("\n"))).toBe("active");
  });

  test("no boundary event / unparseable -> unknown (defer)", () => {
    expect(classifyCodexTranscriptTail("")).toBe("unknown");
    expect(classifyCodexTranscriptTail([codexResp("reasoning"), codexEvt("token_count")].join("\n"))).toBe("unknown");
    expect(classifyCodexTranscriptTail("not json")).toBe("unknown");
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

describe("warm-restart session id recovery", () => {
  test("recovers the real transcript session id from a conversation-tagged tmux", () => {
    const cache = {
      "5e9f3b9b-a08c-4b97-980c-7e5c1e5e3039": "jx75mtdncevqqf6esgrmja255587w9pn",
      "b66907ab-bf95-445f-ba0b-df9c4933d41b": "jx7dtgcj63bmrg09g8dvzx974587x61d",
    };

    expect(findCachedSessionIdForConversation(cache, "jx75mtdncevqqf6esgrmja255587w9pn")).toBe(
      "5e9f3b9b-a08c-4b97-980c-7e5c1e5e3039",
    );
    expect(findCachedSessionIdForConversation(cache, "missing")).toBeUndefined();
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

// Daemon-side recovery for a permission_blocked latch (the one status reconciledStatus
// and the pane reconcile both refuse to touch). When the resume "working" hook after a
// user answers an AskUserQuestion is lost, the session freezes in "Needs Input". The
// transcript distinguishes answered (tail ends in a user turn) from still-pending (tail
// ends in the assistant tool_use).
describe("transcriptTailLastRealRole", () => {
  test("answered prompt: tail ends in a user turn (tool_result)", () => {
    expect(transcriptTailLastRealRole([asst("tool_use"), userMsg("tool_result")].join("\n"))).toBe("user");
  });
  test("pending prompt: tail ends in the assistant tool_use", () => {
    expect(transcriptTailLastRealRole(asst("tool_use"))).toBe("assistant");
  });
  test("skips system/meta lines to the last real message", () => {
    expect(transcriptTailLastRealRole([userMsg("tool_result"), sysMeta()].join("\n"))).toBe("user");
    expect(transcriptTailLastRealRole([asst("tool_use"), sysMeta()].join("\n"))).toBe("assistant");
  });
  test("partial/corrupt final line is skipped", () => {
    expect(transcriptTailLastRealRole([userMsg("tool_result"), '{"type":"assi'].join("\n"))).toBe("user");
  });
  test("nothing real -> null", () => {
    expect(transcriptTailLastRealRole([sysMeta(), ""].join("\n"))).toBeNull();
  });
});

describe("permissionBlockedRecoveryTarget", () => {
  test("permission_blocked + answered (user tail) -> working", () => {
    expect(permissionBlockedRecoveryTarget("permission_blocked", "user")).toBe("working");
  });
  test("permission_blocked + still pending (assistant tail) -> defer", () => {
    expect(permissionBlockedRecoveryTarget("permission_blocked", "assistant")).toBeNull();
  });
  test("permission_blocked + unparseable tail -> defer", () => {
    expect(permissionBlockedRecoveryTarget("permission_blocked", null)).toBeNull();
  });
  test("only acts on permission_blocked; leaves every other status alone", () => {
    for (const s of ["working", "idle", "thinking", "connected", "stopped", "resuming", undefined] as const) {
      expect(permissionBlockedRecoveryTarget(s, "user")).toBeNull();
    }
  });
});
