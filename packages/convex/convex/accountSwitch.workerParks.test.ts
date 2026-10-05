import { describe, expect, test } from "bun:test";
import { autoSwitchCheck } from "./accountSwitch";
import { makeFakeDb } from "./testDb";

// An orchestrator waiting on a workflow: its workers run inside its process
// and hit the limit, the orchestrator itself never parks (2026-10-04, jx7e4fy).
function fixture(opts: { fleetStore?: boolean } = {}) {
  const now = Date.now();
  const usage = (percent: number) => ({
    fetched_at: now - 1_000,
    session: { percent: 10, resets_at: now + 3_600_000 },
    weekly: { percent, resets_at: now + 86_400_000 },
  });
  const device = {
    _id: "devices_primary", user_id: "users_owner", device_id: "mac", last_seen: now,
    cc_auto_switch: true,
    cc_accounts: {
      active_email: "spent@example.com", active_since: now - 3_600_000,
      ...(opts.fleetStore === false ? {} : { fleet_store: true }),
      profiles: [
        { name: "spent", email: "spent@example.com", usage: usage(100) },
        { name: "roomy", email: "roomy@example.com", usage: usage(20) },
      ],
    },
    cc_auto_switch_state: {} as any,
  };
  const parent = {
    _id: "conversations_parent", user_id: "users_owner", session_id: "s-parent", agent_type: "claude_code",
    owner_device_id: "mac", updated_at: now - 60_000, model: "claude-opus-5-5",
  };
  const worker = (id: string) => ({
    _id: id, user_id: "users_owner", session_id: `s-${id}`, agent_type: "claude_code", owner_device_id: "mac",
    is_subagent: true, parent_conversation_id: parent._id, model: "claude-opus-5-5",
    pending_api_error: true, pending_api_error_kind: "limit", pending_api_error_at: now - 30_000, updated_at: now - 30_000,
  });
  const tables: Record<string, any[]> = {
    devices: [device], conversations: [parent, worker("conversations_w1"), worker("conversations_w2")],
    daemon_commands: [], pending_messages: [],
  };
  const db = makeFakeDb(tables);
  const scheduler = { async runAt() {}, async runAfter() {} };
  const run = () => (autoSwitchCheck as any)._handler({ db, scheduler }, { user_id: "users_owner" });
  return { now, device, tables, run, row: (id: string) => tables.conversations.find((c) => c._id === id) };
}

describe("workers parked on a limit recover through their parent", () => {
  test("worker-only parks switch the fleet and send the continue to the parent", async () => {
    const f = fixture();
    expect(await f.run()).toMatchObject({ acted: "switch", profile: "roomy", conversations: 1 });
    const args = JSON.parse(f.tables.daemon_commands[0].args);
    // The parent follows the store: no restart, a continue after the swap.
    expect(args).toMatchObject({ profile: "roomy", conversation_ids: [], follow_ids: ["conversations_parent"] });
    // The workers leave the blocked set once acted on; the parent row is never marked parked.
    expect(f.row("conversations_w1").pending_api_error).toBe(false);
    expect(f.row("conversations_w2").pending_api_error).toBe(false);
    expect(f.row("conversations_parent").pending_api_error).toBeUndefined();
  });

  test("workers stay blocked through a cooldown so the follow-up pass still sees them", async () => {
    const f = fixture();
    f.device.cc_auto_switch_state = { last_action_at: f.now - 30_000, last_action: "switch:spent" };
    expect(await f.run()).toMatchObject({ acted: "cooldown" });
    expect(f.row("conversations_w1").pending_api_error).toBe(true);
  });

  test("a parent parked on its own carries the recovery, and its workers are dismissed as before", async () => {
    const f = fixture();
    Object.assign(f.row("conversations_parent"), { pending_api_error: true, pending_api_error_kind: "limit", pending_api_error_at: f.now - 20_000 });
    expect(await f.run()).toMatchObject({ acted: "switch", conversations: 1 });
    expect(JSON.parse(f.tables.daemon_commands[0].args).follow_ids).toEqual(["conversations_parent"]);
    expect(f.row("conversations_w1").pending_api_error).toBe(false);
  });

  test("off the fleet store a switch would restart the parent and kill its workers, so workers are dismissed", async () => {
    const f = fixture({ fleetStore: false });
    expect(await f.run()).toMatchObject({ acted: "nothing_blocked" });
    expect(f.tables.daemon_commands).toHaveLength(0);
  });
});
