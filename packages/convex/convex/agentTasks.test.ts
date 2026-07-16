import { describe, expect, test } from "bun:test";
import { cancelTasksBoundToConversation, reactivateTasksCanceledOnKill } from "./agentTasks";

// Killing a session cancels the schedules that inject into it; restoring the
// session must bring back exactly those schedules — not ones that completed
// naturally. The stamp (canceled_on_kill_at) is what makes the restore exact,
// so these tests pin the full cancel → stamp → re-arm → clear cycle.

// Minimal stand-in for the ctx.db surface the two helpers use:
// query("agent_tasks").withIndex("by_user_status", q => q.eq(...).eq(...)).collect()
// and patch(id, fields).
function fakeDb(rows: any[]) {
  const db = {
    query: (_table: string) => ({
      withIndex: (_name: string, cb: (q: any) => any) => {
        const eqs: any[] = [];
        const q = { eq(_field: string, val: any) { eqs.push(val); return q; } };
        cb(q);
        const [user, status] = eqs;
        return {
          collect: async () =>
            rows.filter((r) => r.user_id === user && (status === undefined || r.status === status)),
        };
      },
    }),
    patch: async (id: string, patch: any) => {
      const row = rows.find((r) => r._id === id);
      if (row) Object.assign(row, patch);
    },
  };
  return { db };
}

const USER = "user1";
const CONV = "conv1";

function taskRow(overrides: Record<string, any>): Record<string, any> {
  return {
    user_id: USER,
    originating_conversation_id: CONV,
    schedule_type: "recurring",
    interval_ms: 60 * 60 * 1000,
    status: "scheduled",
    ...overrides,
  };
}

describe("cancelTasksBoundToConversation", () => {
  test("completes armed inject schedules and stamps canceled_on_kill_at", async () => {
    const loop = taskRow({ _id: "loop" });
    const paused = taskRow({ _id: "paused", status: "paused" });
    const ctx = fakeDb([loop, paused]);

    const n = await cancelTasksBoundToConversation(ctx as any, USER as any, CONV as any);

    expect(n).toBe(2);
    expect(loop.status).toBe("completed");
    expect(loop.canceled_on_kill_at).toBeGreaterThan(0);
    expect(paused.status).toBe("completed");
    expect(paused.canceled_on_kill_at).toBeGreaterThan(0);
  });

  test("leaves other conversations' schedules and spawn schedules alone", async () => {
    const other = taskRow({ _id: "other", originating_conversation_id: "conv2" });
    const spawn = taskRow({ _id: "spawn", originating_conversation_id: undefined });
    const ctx = fakeDb([other, spawn]);

    const n = await cancelTasksBoundToConversation(ctx as any, USER as any, CONV as any);

    expect(n).toBe(0);
    expect(other.status).toBe("scheduled");
    expect(spawn.status).toBe("scheduled");
  });
});

describe("reactivateTasksCanceledOnKill", () => {
  test("re-arms exactly the stamped tasks and clears the stamp", async () => {
    const killed = taskRow({ _id: "killed", status: "completed", canceled_on_kill_at: 111 });
    const natural = taskRow({ _id: "natural", status: "completed" });
    const otherConv = taskRow({ _id: "otherConv", status: "completed", canceled_on_kill_at: 111, originating_conversation_id: "conv2" });
    const ctx = fakeDb([killed, natural, otherConv]);

    const n = await reactivateTasksCanceledOnKill(ctx as any, USER as any, CONV as any);

    expect(n).toBe(1);
    expect(killed.status).toBe("scheduled");
    expect(killed.canceled_on_kill_at).toBeUndefined();
    // Recurring: re-armed one interval out, not an immediate fire.
    expect(killed.run_at).toBeGreaterThan(Date.now() + 30 * 60 * 1000);
    expect(natural.status).toBe("completed");
    expect(otherConv.status).toBe("completed");
  });

  test("kill → restore round-trip is idempotent (second restore is a no-op)", async () => {
    const loop = taskRow({ _id: "loop" });
    const ctx = fakeDb([loop]);

    await cancelTasksBoundToConversation(ctx as any, USER as any, CONV as any);
    expect(loop.status).toBe("completed");

    expect(await reactivateTasksCanceledOnKill(ctx as any, USER as any, CONV as any)).toBe(1);
    expect(loop.status).toBe("scheduled");

    expect(await reactivateTasksCanceledOnKill(ctx as any, USER as any, CONV as any)).toBe(0);
  });
});
