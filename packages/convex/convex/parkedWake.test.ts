import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { api, internal } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { makeParkedWakeDb } from "./lib/parkedWake";
import { placeProjectableRow } from "@codecast/shared/contracts";

setDefaultTimeout(30_000);

// conversations.parked_wake_kind stays true across the writes it derives from
// (lib/parkedWake.ts): runs a session spawned, its active task's blockers and
// waits, its blockers closing, and its binding. Writes go through the wrapper
// the way every wrapped mutation's do (functions.ts).

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const prWait = (state: "waiting" | "met" | "failed") => ({ id: "w1", kind: "pr_merged" as const, repository: "o/r", pr_number: 7, state, created_at: NOW });

const passthrough = (db: any) => ({
  get: (...a: any[]) => db.get(...a),
  query: (...a: any[]) => db.query(...a),
  normalizeId: (...a: any[]) => db.normalizeId(...a),
  insert: (...a: any[]) => db.insert(...a),
  patch: (...a: any[]) => db.patch(...a),
  replace: (...a: any[]) => db.replace(...a),
  delete: (...a: any[]) => db.delete(...a),
});

async function setup() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx: any) => {
    const user = await ctx.db.insert("users", { name: "Me" } as any);
    const conv = await ctx.db.insert("conversations", { user_id: user, agent_type: "claude_code", started_at: NOW, updated_at: NOW, status: "active", message_count: 0 } as any);
    const workflow = await ctx.db.insert("workflows", { user_id: user, name: "flow", slug: "flow", nodes: [], edges: [], created_at: NOW, updated_at: NOW } as any);
    return { user, conv, workflow };
  });
  let n = 0;
  const task = (fields: Record<string, any> = {}) =>
    t.run(async (ctx: any) =>
      makeParkedWakeDb(ctx.db, ctx.db).insert("tasks", {
        user_id: ids.user, workspace: `user:${ids.user}`, short_id: `ct-${++n}`, title: `task ${n}`, task_type: "task", priority: "medium",
        source: "human", status: "open", created_at: NOW, updated_at: NOW, conversation_ids: [ids.conv], ...fields,
      }),
    );
  const run = (fields: Record<string, any> = {}) =>
    t.run(async (ctx: any) =>
      makeParkedWakeDb(ctx.db, ctx.db).insert("workflow_runs", {
        user_id: ids.user, workflow_id: ids.workflow, workflow_name: "flow", status: "running", node_statuses: [],
        spawner_conversation_id: ids.conv, run_kind: "routine", created_at: NOW, updated_at: NOW, ...fields,
      }),
    );
  const write = (fn: (db: any) => Promise<unknown>) => t.run(async (ctx: any) => { await fn(makeParkedWakeDb(ctx.db, ctx.db)); });
  const kind = () => t.run(async (ctx: any) => (await ctx.db.get(ids.conv)).parked_wake_kind ?? "none");
  /** Another live session holds `taskId`: a blocker task with a holder is an exact "blocker". */
  const hold = (taskId: any, extra: Record<string, any> = {}) =>
    t.run(async (ctx: any) => ctx.db.insert("conversations", { user_id: ids.user, agent_type: "claude_code", started_at: NOW, updated_at: NOW, status: "active", message_count: 0, active_task_id: taskId, ...extra } as any));
  return { t, ...ids, task, run, write, kind, hold };
}

describe("parked_wake_kind: runs", () => {
  test("a live run the session spawned parks it until the run ends", async () => {
    const s = await setup();
    const r = await s.run();
    expect(await s.kind()).toBe("run");
    await s.write((db) => db.patch(r, { status: "completed" }));
    expect(await s.kind()).toBe("none");
  });

  test("a run counts only on the spawner's own machine", async () => {
    const s = await setup();
    await s.write((db) => db.patch(s.conv, { owner_device_id: "laptop" }));
    const r = await s.run({ runner_device: "cloud-host" });
    expect(await s.kind()).toBe("none");
    await s.write((db) => db.patch(r, { runner_device: "laptop" }));
    expect(await s.kind()).toBe("run");
    // The session moves to another machine: the run is no longer on its own.
    await s.write((db) => db.patch(s.conv, { owner_device_id: "mac-mini" }));
    expect(await s.kind()).toBe("none");
    await s.write((db) => db.patch(r, { runner_device: undefined }));
    expect(await s.kind()).toBe("run");
  });

  test("a paused run parks only while its gate's card is out", async () => {
    const s = await setup();
    const r = await s.run();
    await s.write((db) => db.patch(r, { status: "paused" }));
    expect(await s.kind()).toBe("none");
    const card = await s.t.run(async (ctx: any) => ctx.db.insert("session_decisions", { user_id: s.user, conversation_id: s.conv, question: "Ship?", options: [], status: "pending", created_at: NOW } as any));
    await s.write((db) => db.patch(r, { gate_decision_id: card }));
    expect(await s.kind()).toBe("run");
    await s.write((db) => db.patch(r, { gate_decision_id: undefined }));
    expect(await s.kind()).toBe("none");
  });

  test("a failed run and a deleted run clear it", async () => {
    const s = await setup();
    const a = await s.run();
    await s.write((db) => db.patch(a, { status: "failed" }));
    expect(await s.kind()).toBe("none");
    const b = await s.run({ status: "pending" });
    expect(await s.kind()).toBe("run");
    await s.write((db) => db.delete(b));
    expect(await s.kind()).toBe("none");
  });

  test("a run on another task, a workflow run, or one waiting on the session does not park it", async () => {
    const s = await setup();
    const other = await s.task();
    await s.run({ task_id: other });
    await s.run({ run_kind: "workflow" });
    const waiting = await s.run({ waiting_on_session: { node_id: "n", conversation_id: String(s.conv), since: NOW, note: "review" } });
    expect(await s.kind()).toBe("none");
    // The run stops waiting on the session: now it is a machine wake.
    await s.write((db) => db.patch(waiting, { waiting_on_session: undefined }));
    expect(await s.kind()).toBe("run");
  });

  test("a run on the task the session holds parks it, and follows the binding", async () => {
    const s = await setup();
    const held = await s.task();
    await s.run({ task_id: held });
    expect(await s.kind()).toBe("none");
    await s.write((db) => db.patch(s.conv, { active_task_id: held }));
    expect(await s.kind()).toBe("run");
    await s.write((db) => db.patch(s.conv, { active_task_id: undefined }));
    expect(await s.kind()).toBe("none");
  });

  test("a patch of node_statuses alone writes nothing to the conversation", async () => {
    const s = await setup();
    const r = await s.run();
    const patched: string[] = [];
    let rawReads = 0;
    await s.t.run(async (ctx: any) => {
      const spy = { ...passthrough(ctx.db), patch: (id: any, f: any) => { patched.push(String(id)); return ctx.db.patch(id, f); } };
      const raw = { ...passthrough(ctx.db), get: (...a: any[]) => { rawReads++; return ctx.db.get(...a); } };
      const db = makeParkedWakeDb(spy, raw);
      // The runner's progress shape: no status unless it moves.
      await db.patch(r, { node_statuses: [{ node_id: "a", status: "running" }], current_node_id: "a", updated_at: NOW + 1 });
      expect(rawReads).toBe(0);
      // Re-stating the same status costs a read and no recompute write.
      await db.patch(r, { status: "running", updated_at: NOW + 2 });
    });
    expect(patched).toEqual([String(r), String(r)]);
    expect(await s.kind()).toBe("run");
  });
});

describe("parked_wake_kind: blockers", () => {
  test("an open blocked_by parks the held task's session; the blocker closing clears it", async () => {
    const s = await setup();
    const blocker = await s.task({ status: "in_review", conversation_ids: [] });
    await s.hold(blocker);
    const blockerShort = await s.t.run(async (ctx: any) => (await ctx.db.get(blocker)).short_id);
    const held = await s.task({ blocked_by: [blockerShort] });
    await s.write((db) => db.patch(s.conv, { active_task_id: held }));
    expect(await s.kind()).toBe("blocker");
    // in_review -> in_progress is not a closing: nothing to recompute.
    await s.write((db) => db.patch(blocker, { status: "in_progress" }));
    expect(await s.kind()).toBe("blocker");
    await s.write((db) => db.patch(blocker, { status: "done" }));
    expect(await s.kind()).toBe("none");
  });

  test("a waiting wait parks; met and failed do not", async () => {
    const s = await setup();
    const held = await s.task();
    await s.write((db) => db.patch(s.conv, { active_task_id: held }));
    expect(await s.kind()).toBe("none");
    await s.write((db) => db.patch(held, { waits: [prWait("waiting")], waiting_since: NOW }));
    expect(await s.kind()).toBe("wait");
    await s.write((db) => db.patch(held, { waits: [prWait("met")], waiting_since: undefined }));
    expect(await s.kind()).toBe("none");
    await s.write((db) => db.patch(held, { waits: [prWait("waiting")], waiting_since: NOW }));
    expect(await s.kind()).toBe("wait");
    await s.write((db) => db.patch(held, { waits: [prWait("failed")], waiting_since: undefined }));
    expect(await s.kind()).toBe("none");
    // A failed wait still holds the task back, but it can never clear: no wake.
    const closed = await s.task({ status: "done", conversation_ids: [] });
    const closedShort = await s.t.run(async (ctx: any) => (await ctx.db.get(closed)).short_id);
    await s.write((db) => db.patch(held, { blocked_by: [closedShort] }));
    expect(await s.kind()).toBe("none");
  });

  test("closing the held task, or unbinding it, clears the wait", async () => {
    const s = await setup();
    const held = await s.task({ waits: [prWait("waiting")], waiting_since: NOW });
    await s.write((db) => db.patch(s.conv, { active_task_id: held }));
    expect(await s.kind()).toBe("wait");
    await s.write((db) => db.patch(held, { status: "dropped" }));
    expect(await s.kind()).toBe("none");
    await s.write((db) => db.patch(held, { status: "open" }));
    expect(await s.kind()).toBe("wait");
    await s.write((db) => db.patch(s.conv, { active_task_id: undefined }));
    expect(await s.kind()).toBe("none");
  });

  test("a run beats a wait, and the wait shows once the run ends", async () => {
    const s = await setup();
    const held = await s.task({ waits: [prWait("waiting")], waiting_since: NOW });
    await s.write((db) => db.patch(s.conv, { active_task_id: held }));
    const r = await s.run();
    expect(await s.kind()).toBe("run");
    await s.write((db) => db.patch(r, { status: "completed" }));
    expect(await s.kind()).toBe("wait");
  });

  // A task blocker is exact (every task write recomputes it), a run follows
  // its machine's heartbeat and a wait lives 72h: the exact one wins.
  // A blocker task nobody holds is closed by nothing but a person or a webhook
  // that can be lost (jx7cn1s's ct-99107): it gets the wait's 72h lifetime, not
  // the exact stamp. A killed or reviewing session holds nothing.
  test("a blocker task nobody holds stamps wait; one a live session holds stamps blocker", async () => {
    const s = await setup();
    const blocker = await s.task({ conversation_ids: [] });
    const blockerShort = await s.t.run(async (ctx: any) => (await ctx.db.get(blocker)).short_id);
    await s.hold(blocker, { inbox_killed_at: NOW });
    await s.hold(blocker, { review_of_task_id: blocker });
    const held = await s.task({ blocked_by: [blockerShort] });
    await s.write((db) => db.patch(s.conv, { active_task_id: held }));
    expect(await s.kind()).toBe("wait");
    // Pinned dormant with no daemon: the wait's lifetime runs out at 72h.
    const placed = async (quietFor: number) => {
      const conv = await s.t.run(async (ctx: any) => ctx.db.get(s.conv));
      return placeProjectableRow({ ...conv, agent_status: null, is_idle: true, message_count: 10, thread_state_status: "dormant", updated_at: NOW - quietFor }, false, NOW).bucket;
    };
    expect(await placed(71 * HOUR)).toBe("dormant");
    expect(await placed(73 * HOUR)).toBe("needs_input");
    // Closing it still clears the stamp.
    await s.write((db) => db.patch(blocker, { status: "done" }));
    expect(await s.kind()).toBe("none");
    // A live holder makes the reopened blocker exact.
    await s.hold(blocker);
    await s.write((db) => db.patch(blocker, { status: "open" }));
    expect(await s.kind()).toBe("blocker");
    // Exact, so it stays parked at 4 days.
    expect(await placed(96 * HOUR)).toBe("dormant");
  });

  // ct-B's only live holder A stops holding it: S, holding ct-A blocked by
  // ct-B, must not stay exact and hidden. A is killed, moves off, or turns to
  // review it. A completed holder still holds it (a wake resumes it).
  test.each([
    ["killed", (a: any, _other: any, _b: any) => ({ id: a, fields: { inbox_killed_at: NOW } }), "wait"],
    ["moved to another task", (a: any, other: any, _b: any) => ({ id: a, fields: { active_task_id: other } }), "wait"],
    ["turned to review it", (a: any, _other: any, b: any) => ({ id: a, fields: { review_of_task_id: b } }), "wait"],
    ["completed", (a: any, _other: any, _b: any) => ({ id: a, fields: { status: "completed" } }), "blocker"],
  ] as const)("the blocker's only holder %s: the dependent's stamp follows", async (_name, leave, want) => {
    const s = await setup();
    const blocker = await s.task({ conversation_ids: [] });
    const other = await s.task({ conversation_ids: [] });
    const holder = await s.hold(blocker);
    const blockerShort = await s.t.run(async (ctx: any) => (await ctx.db.get(blocker)).short_id);
    const held = await s.task({ blocked_by: [blockerShort] });
    await s.write((db) => db.patch(s.conv, { active_task_id: held }));
    expect(await s.kind()).toBe("blocker");
    const { id, fields } = leave(holder, other, blocker);
    await s.write((db) => db.patch(id, fields));
    expect(await s.kind()).toBe(want);
  });

  test("a conversation patch naming no holder or binding field reads nothing more", async () => {
    const s = await setup();
    let rawReads = 0;
    await s.t.run(async (ctx: any) => {
      const raw = { ...passthrough(ctx.db), get: (...a: any[]) => { rawReads++; return ctx.db.get(...a); }, query: (...a: any[]) => { rawReads++; return ctx.db.query(...a); } };
      await makeParkedWakeDb(passthrough(ctx.db), raw).patch(s.conv, { updated_at: NOW + 1, message_count: 5 });
    });
    expect(rawReads).toBe(0);
  });

  test("a task blocker beats a run and a wait", async () => {
    const s = await setup();
    const blocker = await s.task({ conversation_ids: [] });
    await s.hold(blocker);
    const blockerShort = await s.t.run(async (ctx: any) => (await ctx.db.get(blocker)).short_id);
    const held = await s.task({ blocked_by: [blockerShort], waits: [prWait("waiting")], waiting_since: NOW });
    await s.write((db) => db.patch(s.conv, { active_task_id: held }));
    await s.run();
    expect(await s.kind()).toBe("blocker");
    await s.write((db) => db.patch(blocker, { status: "done" }));
    expect(await s.kind()).toBe("run");
  });

  // A blocker with more dependents than one page: closing it clears every
  // one of their sessions' stamps, none left behind.
  test("closing a blocker of 60 dependents clears all their stamps", async () => {
    const s = await setup();
    const blocker = await s.task({ conversation_ids: [] });
    await s.hold(blocker);
    const blockerShort = await s.t.run(async (ctx: any) => (await ctx.db.get(blocker)).short_id);
    const convs: any[] = [];
    for (let i = 0; i < 60; i++) {
      const held = await s.task({ blocked_by: [blockerShort], conversation_ids: [] });
      const conv = await s.t.run(async (ctx: any) => ctx.db.insert("conversations", { user_id: s.user, agent_type: "claude_code", started_at: NOW, updated_at: NOW, status: "active", message_count: 0 } as any));
      await s.write((db) => db.patch(conv, { active_task_id: held }));
      convs.push(conv);
    }
    const kinds = () => s.t.run(async (ctx: any) => Promise.all(convs.map(async (c) => (await ctx.db.get(c)).parked_wake_kind ?? "none")));
    expect(new Set(await kinds())).toEqual(new Set(["blocker"]));
    await s.write((db) => db.patch(blocker, { status: "done" }));
    expect(new Set(await kinds())).toEqual(new Set(["none"]));
    // Reopened, it parks them all again.
    await s.write((db) => db.patch(blocker, { status: "open" }));
    expect(new Set(await kinds())).toEqual(new Set(["blocker"]));
  });

  test("a real mutation deleting the blocker clears the dependent's session (functions.ts wiring)", async () => {
    const s = await setup();
    const blocker = await s.task({ conversation_ids: [] });
    await s.hold(blocker);
    const held = await s.task({ blocked_by: ["ct-1"] });
    await s.write((db) => db.patch(s.conv, { active_task_id: held }));
    expect(await s.kind()).toBe("blocker");
    await s.t.mutation(internal.tasks.adminDeleteTask, { short_id: "ct-1" });
    expect(await s.kind()).toBe("none");
  });
});

describe("parked_wake_kind: review sessions and waits set elsewhere", () => {
  test("a session reviewing the task it holds gets no blocker from it", async () => {
    const s = await setup();
    const held = await s.task({ waits: [prWait("waiting")], waiting_since: NOW });
    await s.write((db) => db.patch(s.conv, { active_task_id: held, review_of_task_id: held }));
    expect(await s.kind()).toBe("none");
    await s.write((db) => db.patch(s.conv, { review_of_task_id: undefined }));
    expect(await s.kind()).toBe("wait");
  });

  test("a wait the session set on another task parks it while it is owed", async () => {
    const s = await setup();
    const mine = { ...prWait("waiting"), created_in: String(s.conv) };
    const other = await s.task({ conversation_ids: [], waits: [mine], waiting_since: NOW });
    await s.write((db) => db.patch(s.conv, { parked_on_task_ids: [other] }));
    expect(await s.kind()).toBe("wait");
    // Met but not yet told (something else still blocks the task): still owed.
    await s.write((db) => db.patch(other, { waits: [{ ...mine, state: "met", settled_at: NOW }] }));
    expect(await s.kind()).toBe("wait");
    await s.write((db) => db.patch(other, { waits: [{ ...mine, state: "met", settled_at: NOW, setter_told_at: NOW }] }));
    expect(await s.kind()).toBe("none");
    // Nothing there is owed any more: the list drops the task, and the field with it.
    const parkedOn = () => s.t.run(async (ctx: any) => (await ctx.db.get(s.conv)).parked_on_task_ids);
    expect((await parkedOn()) ?? null).toBeNull();
    // Another session's wait on that task is not this one's wake.
    await s.write((db) => db.patch(other, { waits: [{ ...mine, created_in: "someone-else" }] }));
    await s.write((db) => db.patch(s.conv, { parked_on_task_ids: [other] }));
    expect(await s.kind()).toBe("none");
    expect((await parkedOn()) ?? null).toBeNull();
    await s.write((db) => db.patch(other, { waits: [mine] }));
    await s.write((db) => db.patch(s.conv, { parked_on_task_ids: [other] }));
    expect(await s.kind()).toBe("wait");
    await s.write((db) => db.patch(other, { status: "done" }));
    expect(await s.kind()).toBe("none");
  });

  test("waits on two tasks: each keeps it parked until both are settled", async () => {
    const s = await setup();
    const mine = { ...prWait("waiting"), created_in: String(s.conv) };
    const first = await s.task({ conversation_ids: [], waits: [mine], waiting_since: NOW });
    const second = await s.task({ conversation_ids: [], waits: [mine], waiting_since: NOW });
    await s.write((db) => db.patch(s.conv, { parked_on_task_ids: [first, second] }));
    expect(await s.kind()).toBe("wait");
    await s.write((db) => db.patch(second, { waits: [{ ...mine, state: "met", settled_at: NOW, setter_told_at: NOW }] }));
    expect(await s.kind()).toBe("wait");
    expect(await s.t.run(async (ctx: any) => (await ctx.db.get(s.conv)).parked_on_task_ids)).toEqual([first]);
    await s.write((db) => db.patch(first, { waits: [{ ...mine, state: "met", settled_at: NOW, setter_told_at: NOW }] }));
    expect(await s.kind()).toBe("none");
  });
});

describe("parked_wake_kind: the blocks mirror", () => {
  test("a blocker named before it existed gets its mirror repaired, so its closing clears the stamp", async () => {
    const s = await setup();
    // ct-1 names ct-2 before ct-2 exists, outside a plan: ct-2's mirror stays empty.
    const held = await s.task({ blocked_by: ["ct-2"] });
    const blocker = await s.task({ blocks: [], conversation_ids: [] });
    await s.hold(blocker);
    await s.write((db) => db.patch(s.conv, { active_task_id: held }));
    expect(await s.kind()).toBe("blocker");
    expect((await s.t.run(async (ctx: any) => ctx.db.get(blocker))).blocks).toEqual(["ct-1"]);
    await s.write((db) => db.patch(blocker, { status: "done" }));
    expect(await s.kind()).toBe("none");
  });

  test("a mirror that already names the dependent is left alone", async () => {
    const s = await setup();
    const blocker = await s.task({ blocks: ["ct-2"], conversation_ids: [] });
    const held = await s.task({ blocked_by: ["ct-1"] });
    const writes: string[] = [];
    await s.t.run(async (ctx: any) => {
      const spy = { ...passthrough(ctx.db), patch: (id: any, f: any) => { writes.push(String(id)); return ctx.db.patch(id, f); } };
      await makeParkedWakeDb(spy, ctx.db).patch(s.conv, { active_task_id: held });
    });
    expect(writes).toEqual([String(s.conv), String(s.conv)]);
    expect((await s.t.run(async (ctx: any) => ctx.db.get(blocker))).blocks).toEqual(["ct-2"]);
  });
});

describe("parked_wake_kind: runner progress", () => {
  test("a progress report with an unchanged status writes nothing to the spawner", async () => {
    const s = await setup();
    const TOKEN = "cc_parked_wake_token";
    await s.t.run(async (ctx: any) => ctx.db.insert("api_tokens", { user_id: s.user, token_hash: await hashToken(TOKEN), name: "cli", created_at: NOW, last_used_at: NOW } as any));
    const r = await s.run();
    const convActions = () => s.t.run(async (ctx: any) => (await ctx.db.query("change_log").collect()).filter((row: any) => String(row.entity_id) === String(s.conv)).map((row: any) => row._creationTime + ":" + (row.seq ?? row.updated_at ?? "")));
    const before = await convActions();
    const conv0 = await s.t.run(async (ctx: any) => ctx.db.get(s.conv));
    await s.t.mutation(api.workflow_runs.updateProgress, { api_token: TOKEN, run_id: r, current_node_id: "a", node_id: "a", node_status: "running", run_status: "running" });
    expect(await convActions()).toEqual(before);
    expect(await s.t.run(async (ctx: any) => ctx.db.get(s.conv))).toEqual(conv0);
    expect(await s.kind()).toBe("run");
    // The run ending through the same mutation clears the stamp.
    await s.t.mutation(api.workflow_runs.updateProgress, { api_token: TOKEN, run_id: r, current_node_id: "a", node_id: "a", node_status: "completed", run_status: "completed" });
    expect(await s.kind()).toBe("none");
  });
});

describe("parked_wake_kind backfill", () => {
  test("a dry run counts and writes nothing; a real run stamps", async () => {
    const s = await setup();
    // Seed without the wrapper: rows written before the field existed.
    const other = await s.t.run(async (ctx: any) => ctx.db.insert("conversations", { user_id: s.user, agent_type: "claude_code", started_at: NOW, updated_at: NOW, status: "active", message_count: 0 } as any));
    await s.t.run(async (ctx: any) => {
      await ctx.db.insert("workflow_runs", { user_id: s.user, workflow_id: s.workflow, workflow_name: "flow", status: "running", node_statuses: [], spawner_conversation_id: s.conv, created_at: NOW, updated_at: NOW });
      const held = await ctx.db.insert("tasks", {
        user_id: s.user, workspace: `user:${s.user}`, short_id: "ct-9", title: "held", task_type: "task", priority: "medium", source: "human",
        status: "open", created_at: NOW, updated_at: NOW, conversation_ids: [other], waits: [prWait("waiting")], waiting_since: NOW,
      });
      await ctx.db.patch(other, { active_task_id: held });
      await ctx.db.insert("tasks", {
        user_id: s.user, workspace: `user:${s.user}`, short_id: "ct-10", title: "closed", task_type: "task", priority: "medium", source: "human",
        status: "done", created_at: NOW, updated_at: NOW,
      });
    });
    const kindOf = (id: any) => s.t.run(async (ctx: any) => (await ctx.db.get(id)).parked_wake_kind ?? "none");

    // Walk every phase the way an operator would, summing the counts.
    const walk = async (dry: boolean, numItems?: number) => {
      const total = { calls: 0, candidates: 0, stamped: { run: 0, blocker: 0, wait: 0, none: 0 }, repaired: 0 };
      let args: any = { dry, ...(numItems ? { numItems } : {}) };
      while (args) {
        const r: any = await s.t.mutation(internal.parkedWakeBackfill.backfill, args);
        total.calls++;
        total.candidates += r.candidates;
        total.repaired += r.repaired;
        for (const k of ["run", "blocker", "wait", "none"] as const) total.stamped[k] += r.stamped[k];
        args = r.next ? { dry, ...r.next } : null;
      }
      return total;
    };
    const dry = await walk(true);
    expect(dry).toMatchObject({ calls: 4, candidates: 2, stamped: { run: 1, blocker: 0, wait: 1, none: 0 } });
    // A smaller page takes more calls and finds the same rows.
    const small = await walk(true, 1);
    expect(small.calls).toBeGreaterThan(4);
    expect(small).toMatchObject({ candidates: 2, stamped: { run: 1, blocker: 0, wait: 1, none: 0 } });
    expect(await kindOf(s.conv)).toBe("none");
    expect(await kindOf(other)).toBe("none");

    const real = await walk(false);
    expect(real.stamped).toEqual({ run: 1, blocker: 0, wait: 1, none: 0 });
    expect(await kindOf(s.conv)).toBe("run");
    expect(await kindOf(other)).toBe("wait");

    expect((await walk(false)).stamped).toEqual({ run: 0, blocker: 0, wait: 0, none: 0 });
  });
});
