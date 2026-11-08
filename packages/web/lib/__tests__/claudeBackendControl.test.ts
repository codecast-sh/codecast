import { describe, expect, test } from "bun:test";
import { backendRows, canSwitchClaudeBackend } from "../claudeBackendControl";
import { backendSwitchState, BACKEND_SWITCH_GIVE_UP_MS, type SessionCommandRow } from "../sessionCommands";

const row = (o: Partial<SessionCommandRow>): SessionCommandRow => ({
  _id: "r", conversation_id: "c", command: "switch_claude_backend", kind: "backend", backend: "sdk",
  requested_at: 1_000, executed_at: null, result: null, error: null, ...o,
});

describe("Runs in rows", () => {
  test("an idle tmux session offers the SDK as a plain switch and marks tmux current", () => {
    const rows = backendRows("tmux", "idle", null);
    expect(rows.map((r) => [r.backend, r.current, r.action])).toEqual([["tmux", true, null], ["sdk", false, "switch"]]);
    expect(rows[1].hint).toContain("never parked");
  });

  test("a running turn turns the other row into the interrupt, named on the row", () => {
    const [tmux] = backendRows("sdk", "working", null);
    expect(tmux.action).toBe("interrupt_and_switch");
    expect(tmux.verb).toBe("Stop the turn, move to the terminal");
    expect(backendRows("tmux", "permission_blocked", null)[1].verb).toBe("Stop the turn, move to the Agent SDK");
  });

  test("while a switch is in flight nothing is pressable and the target says it is moving", () => {
    const rows = backendRows("tmux", "idle", { moving: "sdk" });
    expect(rows.every((r) => r.action === null)).toBe(true);
    expect(rows[1].hint).toBe("Moving…");
  });

  test("only a started Claude session has a backend to move", () => {
    expect(canSwitchClaudeBackend("claude_code", "s", 3)).toBe(true);
    expect(canSwitchClaudeBackend(undefined, "s", 3)).toBe(true);
    expect(canSwitchClaudeBackend("codex", "s", 3)).toBe(false);
    expect(canSwitchClaudeBackend("claude_code", "s", 0)).toBe(false);
    expect(canSwitchClaudeBackend("claude_code", null, 3)).toBe(false);
  });
});

describe("backendSwitchState", () => {
  test("asked and not reported is moving, until its deadline says no daemon took it", () => {
    expect(backendSwitchState(row({}), "tmux", 2_000)).toEqual({ moving: "sdk" });
    expect(backendSwitchState(row({}), "tmux", 1_000 + BACKEND_SWITCH_GIVE_UP_MS + 1)).toEqual({ failed: expect.stringContaining("never reported back") });
  });

  test("a daemon's refusal is shown as it said it", () => {
    expect(backendSwitchState(row({ executed_at: 5_000, error: "A turn is running (working); switching would interrupt it" }), "tmux", 6_000))
      .toEqual({ failed: "A turn is running (working); switching would interrupt it" });
  });

  test("a landed switch keeps moving until the session's own fact follows, then says nothing", () => {
    const landed = row({ executed_at: 5_000, result: JSON.stringify({ backend: "sdk" }) });
    expect(backendSwitchState(landed, "tmux", 6_000)).toEqual({ moving: "sdk" });
    expect(backendSwitchState(landed, "sdk", 6_000)).toBeNull();
  });

  test("an SDK host that did not come up is a failure that says the session runs in the terminal", () => {
    const fell = row({ executed_at: 5_000, result: JSON.stringify({ backend: "tmux", fell_back: "Claude Code did not finish starting" }) });
    expect(backendSwitchState(fell, "tmux", 6_000)).toEqual({ failed: expect.stringContaining("runs in the terminal: Claude Code did not finish starting") });
  });
});
