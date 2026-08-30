import { describe, expect, test } from "bun:test";
import { applyTaskUpdate, cancelTasksBoundToConversation, reactivateTasksCanceledOnKill } from "./agentTasks";

// Killing a session cancels the schedules that inject into it; restoring the
// session must bring back exactly those schedules — not ones that completed
// naturally. The stamp (canceled_on_kill_at) is what makes the restore exact,
// so these tests pin the full cancel → stamp → re-arm → clear cycle.

// Minimal stand-in for the ctx.db surface the helpers use: an eq-filtered
// withIndex(...).collect(), patch(id, fields) and get(id). The home
// conversation is a row too, so the armed_trigger_kind stamp every lifecycle
// transition writes (refreshArmedTriggerKind) is observable.
function fakeDb(rows: any[]) {
  const db = {
    query: (_table: string) => ({
      withIndex: (_name: string, cb: (q: any) => any) => {
        const eqs: Array<[string, any]> = [];
        const q = { eq(field: string, val: any) { eqs.push([field, val]); return q; } };
        cb(q);
        return {
          collect: async () => rows.filter((r) => eqs.every(([f, v]) => r[f] === v)),
        };
      },
    }),
    patch: async (id: string, patch: any) => {
      const row = rows.find((r) => r._id === id);
      if (row) Object.assign(row, patch);
    },
    get: async (id: string) => rows.find((r) => r._id === id) ?? null,
    insert: async (table: string, doc: any) => {
      const _id = `${table}_${rows.length}`;
      rows.push({ _id, _table: table, ...doc });
      return _id;
    },
  };
  return { db, rows };
}

const USER = "user1";
const CONV = "conv1";
const home = () => ({ _id: CONV, user_id: USER });

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
    const conv = home();
    const ctx = fakeDb([loop, paused, conv]);

    const n = await cancelTasksBoundToConversation(ctx as any, USER as any, CONV as any);

    expect(n).toBe(2);
    expect((conv as any).armed_trigger_kind).toBe("none"); // the home's denormalized state follows
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

// Every effective edit — CLI or web, both go through applyTaskUpdate — must
// append an agent_task_revisions row: the pre-edit snapshot (version history)
// plus who changed what from where (audit log). A no-op edit writes nothing.
describe("applyTaskUpdate", () => {
  const ACTOR = { userId: "user1" as any, source: "cli" as const };
  const editable = () =>
    taskRow({
      _id: "t1",
      title: "Check CI",
      prompt: "Check if CI is green",
      mode: "apply",
      run_at: 1000,
    });
  const revisionsOf = (rows: any[]) => rows.filter((r) => r._table === "agent_task_revisions");

  test("records a revision with the pre-edit snapshot and the audit fields", async () => {
    const task = editable();
    const { db, rows } = fakeDb([task, home()]);

    const result = await applyTaskUpdate({ db } as any, task as any, { prompt: "Check CI and the deploy" }, ACTOR);

    expect(result).toEqual({ ok: true, changed: ["prompt"] });
    expect(task.prompt).toBe("Check CI and the deploy");
    const [rev] = revisionsOf(rows);
    expect(rev.revision).toBe(1);
    expect(rev.actor_user_id).toBe("user1");
    expect(rev.source).toBe("cli");
    expect(rev.changed_fields).toEqual(["prompt"]);
    expect(rev.before.prompt).toBe("Check if CI is green");
    expect(rev.before.title).toBe("Check CI"); // full snapshot, not just the diff
  });

  test("a prompt edit resets the stale distillation without auditing it as a change", async () => {
    const task = editable();
    task.display_title = "Old distilled name";
    task.display_summary = "Old gist";
    const { db, rows } = fakeDb([task, home()]);

    await applyTaskUpdate({ db } as any, task as any, { prompt: "New prompt" }, ACTOR);

    expect(task.display_title).toBeUndefined();
    expect(task.display_summary).toBeUndefined();
    expect(revisionsOf(rows)[0].changed_fields).toEqual(["prompt"]);
  });

  test("no-op edit writes neither a patch nor a revision", async () => {
    const task = editable();
    const { db, rows } = fakeDb([task, home()]);

    const result = await applyTaskUpdate(
      { db } as any,
      task as any,
      { prompt: "Check if CI is green", title: "Check CI" },
      ACTOR
    );

    expect(result).toEqual({ ok: true, changed: [] });
    expect(revisionsOf(rows)).toHaveLength(0);
  });

  test("revision numbers are monotonic across edits", async () => {
    const task = editable();
    const { db, rows } = fakeDb([task, home()]);

    await applyTaskUpdate({ db } as any, task as any, { title: "First rename" }, ACTOR);
    await applyTaskUpdate({ db } as any, task as any, { title: "Second rename" }, { userId: "user2" as any, source: "web" });

    const revs = revisionsOf(rows);
    expect(revs.map((r) => r.revision)).toEqual([1, 2]);
    // The chain reconstructs every version: v1 → v2 → current.
    expect(revs[0].before.title).toBe("Check CI");
    expect(revs[1].before.title).toBe("First rename");
    expect(task.title).toBe("Second rename");
    expect(revs[1].actor_user_id).toBe("user2");
    expect(revs[1].source).toBe("web");
  });

  test("switching recurring to once clears the interval and audits both fields", async () => {
    const task = editable();
    const { db, rows } = fakeDb([task, home()]);

    const runAt = Date.now() + 60_000;
    const result = await applyTaskUpdate(
      { db } as any,
      task as any,
      { schedule_type: "once", run_at: runAt },
      ACTOR
    );

    expect(result.ok).toBe(true);
    expect(result.changed).toEqual(["schedule_type", "run_at", "interval_ms"]);
    expect(task.schedule_type).toBe("once");
    expect(task.interval_ms).toBeUndefined();
    expect(task.run_at).toBe(runAt);
    expect(revisionsOf(rows)[0].before.schedule_type).toBe("recurring");
    expect(revisionsOf(rows)[0].before.interval_ms).toBe(60 * 60 * 1000);
  });

  test("rejects a running or finished task", async () => {
    for (const status of ["running", "completed", "failed"]) {
      const task = editable();
      task.status = status;
      const { db, rows } = fakeDb([task, home()]);
      const result = await applyTaskUpdate({ db } as any, task as any, { title: "Nope" }, ACTOR);
      expect(result.ok).toBe(false);
      expect(task.title).toBe("Check CI");
      expect(revisionsOf(rows)).toHaveLength(0);
    }
  });
});
