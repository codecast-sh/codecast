import { describe, expect, test } from "bun:test";
import { railRowPlacement, type InboxSession } from "../../store/inboxStore";
import { sessionStatusOf, statusFailure } from "../sessionStatus";
import { sessionCardLine } from "../sessionCardLine";

// ct-101500. An agent copied a claude.ai conversation onto a machine as a
// Claude Code transcript (its first message: "[IMPORTED SNAPSHOT, NOT A
// SESSION THAT RAN HERE]"; every assistant entry carries the model
// "imported-snapshot", which Claude Code later named when it could not
// restore it). No agent ever ran it here, yet the inbox drew it as
// "Error · Agent stopped" under the last imported line ("the confirming run
// on main has just started"), and the person had to type "test" to start it.
// Nothing failed: an imported transcript has no process to have died. It is
// the person's move, so it files as Needs you, never as Error.

const NOW = 1_700_000_000_000;
let seq = 0;
const row = (extra: Partial<InboxSession> & Record<string, unknown> = {}): InboxSession => ({
  _id: `jx7${String(++seq).padStart(29, "0")}`,
  session_id: `s${seq}`,
  agent_type: "claude_code",
  title: "Legislative red teaming tool",
  message_count: 109,
  updated_at: NOW - 2 * 60_000,
  agent_status_updated_at: NOW - 2 * 60_000,
  started_at: NOW - 2 * 60_000,
  last_heartbeat: NOW - 5_000,
  is_idle: true,
  has_pending: false,
  is_connected: true,
  agent_status: "stopped",
  last_role_is_user: false,
  idle_summary: "Fixed a CI failure on main; the confirming run is still in progress",
  ...extra,
}) as InboxSession;

// The row the report showed: the imported transcript, its model the import marker.
const imported = () => row({ model: "imported-snapshot" });
// The same facts from an agent that did run here and died mid-task.
const died = () => row({ model: "claude-opus-5-5" });

describe("an imported transcript no agent ever ran here (ct-101500)", () => {
  test("is not a failure", () => {
    expect(statusFailure(imported(), NOW)).toBeNull();
  });

  test("files as Needs you, not Error, and its card says nothing stopped", () => {
    const r = imported();
    const status = sessionStatusOf({ row: r, placement: railRowPlacement(r, NOW), now: NOW });
    expect(status).toBe("needs_you");
    const line = sessionCardLine({ row: r, status, now: NOW, summary: r.idle_summary as string });
    expect(line.reason ?? "").not.toMatch(/Agent stopped|Error/);
  });

  // Guard: a real exit without a done or dormant pin is still an error.
  test("an agent that ran here and died mid-task still shows Agent stopped", () => {
    const r = died();
    expect(statusFailure(r, NOW)).toEqual({ label: "Agent stopped" });
    expect(sessionStatusOf({ row: r, placement: railRowPlacement(r, NOW), now: NOW })).toBe("error");
  });
});
