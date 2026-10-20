import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performSeatRootRoles } from "./orgRootSeat";
import { routeUpHears, routeUpWaitingSession } from "./agentTasks";
import { ROLE_MACHINE_AWAY_MS, roleMachineAway } from "./lib/orgRoutine";

// The route up reaches a role only on a machine that is there to hear it
// (org-staffing.md S28). A role whose machine is away is no reader, so the
// wait is reported unreachable and goes on to the person instead of piling up
// in a queue nobody drains.

const ME = "u".repeat(31) + "m";
const BOT = "u".repeat(31) + "b";
const TEAM = "teams_acme" as any;
const MACHINE = "9ab14acad2604760";

async function world(machineSilentMs: number | null) {
  const now = Date.now();
  const tables: Record<string, any[]> = {
    users: [{ _id: ME, name: "Me", email: "me@x.ai" }, { _id: BOT, name: "Anchor", is_bot: true, bot_kind: "anchor" }],
    team_memberships: [
      { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: BOT, team_id: TEAM, role: "member", joined_at: 1, visibility: "full" },
    ],
    teams: [{ _id: TEAM, name: "Acme", features: { org: true } }],
    counters: [],
    org_roles: [],
    anchors: [{ _id: "anchor-t", scope_type: "team", team_id: TEAM, bot_user_id: BOT, host_user_id: ME, name: "Anchor", status: "active", conversation_id: "conv-t", project_path: "/repo", created_at: 1, updated_at: 1 }],
    conversations: [
      { _id: "conv-t", user_id: ME, acting_user_id: BOT, anchor_id: "anchor-t", session_id: "s-t", short_id: "jxanct1", title: "Anchor", status: "active", agent_type: "claude_code", updated_at: now, message_count: 9, team_id: TEAM, is_private: false, persistent: true, project_path: "/repo", owner_device_id: MACHINE },
      { _id: "conv-w", user_id: ME, session_id: "s-w", short_id: "jxwork1", title: "Worker", status: "active", agent_type: "claude_code", updated_at: now, message_count: 4, team_id: TEAM, thread_state: "Needs a key", thread_state_status: "blocked" },
    ],
    devices: machineSilentMs == null ? [] : [{ _id: "dev-1", user_id: ME, device_id: MACHINE, label: "jb-m5-max", platform: "darwin", last_seen: now - machineSilentMs }],
    agent_tasks: [], pending_messages: [], managed_sessions: [], session_owners: [], messages: [], user_presence: [], docs: [], projects: [], plans: [], tasks: [], session_decisions: [],
  };
  const ctx: any = { db: makeFakeDb(tables), scheduler: { runAfter: async () => {} } };
  await performSeatRootRoles(ctx, false);
  const worker = tables.conversations.find((c) => c._id === "conv-w")!;
  worker.org_role_id = tables.org_roles[0]._id;
  const queuedBefore = tables.pending_messages.length;
  return { ctx, tables, worker, wakes: () => tables.pending_messages.slice(queuedBefore).filter((m) => String(m.content).startsWith("<scheduled-task")) };
}

const wait = { why: "blocked", since: 1 };

describe("a role whose machine is away does not hear", () => {
  test("the rule: silent past the window is away; a nap, or no machine at all, is not", () => {
    const now = 1_800_000_000_000;
    expect(roleMachineAway({ last_seen: now - ROLE_MACHINE_AWAY_MS }, now)).toBe(true);
    expect(roleMachineAway({ last_seen: now - ROLE_MACHINE_AWAY_MS + 1 }, now)).toBe(false);
    expect(roleMachineAway(null, now)).toBe(false);
  });

  test("a role on a live machine is told, and the wake is queued for it", async () => {
    const w = await world(60_000);
    expect(await routeUpHears(w.ctx, w.worker)).toBe("hears");
    expect(await routeUpWaitingSession(w.ctx, w.worker, wait)).toBe("told");
    expect(w.wakes()).toHaveLength(1);
  });

  test("a role whose machine has been off for days is unreachable: nothing is queued, and the ask stays unspent for when it is back", async () => {
    const w = await world(5 * 24 * 60 * 60 * 1000);
    expect(await routeUpHears(w.ctx, w.worker)).toBe("unreachable");
    expect(await routeUpWaitingSession(w.ctx, w.worker, wait)).toBe("unreachable");
    expect(w.wakes()).toHaveLength(0);
    expect(w.worker.hand_wake_notified_key).toBeUndefined();
    // The machine returns: the same ask is told now.
    w.tables.devices[0].last_seen = Date.now();
    expect(await routeUpWaitingSession(w.ctx, w.worker, wait)).toBe("told");
    expect(w.wakes()).toHaveLength(1);
  });

  test("a standing session that names no machine still hears", async () => {
    const w = await world(null);
    expect(await routeUpWaitingSession(w.ctx, w.worker, wait)).toBe("told");
  });
});
