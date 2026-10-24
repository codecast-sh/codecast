import { describe, expect, test } from "bun:test";
import schema from "../schema";
import { makeFakeDb, schemaIndexes } from "../testDb";
import { makeChangeTrackedDb } from "../changeLog";
import { backfillProjectCountsPage, countBucket, projectCountsFor, resetProjectCounts } from "./projectTaskCounts";

// The counters must always equal a recount of the tasks themselves, whatever
// order live writes and backfill pages interleave in.

function setup() {
  let t = 1000;
  const raw = makeFakeDb(
    { users: [{ _id: "u1" }, { _id: "u2" }, { _id: "u3" }], team_memberships: [{ _id: "m1", user_id: "u1", team_id: "t1" }, { _id: "m2", user_id: "u2", team_id: "t1" }] },
    { indexes: schemaIndexes(schema as any), creationTime: () => ++t, strictPatch: true, mintId: (table, n) => `${table}:${n}` },
  );
  const db = makeChangeTrackedDb(raw);
  const task = (fields: Record<string, unknown>) =>
    db.insert("tasks", { user_id: "u1", title: "t", status: "open", source: "human", workspace: "team:t1", project_id: "p1", ...fields });
  // Bucket -> count, from the tasks and from the counter rows.
  const recount = async () => {
    const out: Record<string, number> = {};
    for (const row of await raw.query("tasks").collect()) {
      const b = countBucket(row);
      if (b) out[`${b.project_id}|${b.workspace}|${b.status}`] = (out[`${b.project_id}|${b.workspace}|${b.status}`] ?? 0) + 1;
    }
    return out;
  };
  const counters = async () => {
    const out: Record<string, number> = {};
    for (const r of await raw.query("project_task_counts").collect()) if (r.count) out[`${r.project_id}|${r.workspace}|${r.status}`] = r.count;
    return out;
  };
  const backfill = async () => { while (!(await backfillProjectCountsPage({ db: raw }, 2)).done); };
  return { raw, db, task, recount, counters, backfill };
}

describe("project task counters", () => {
  test("backfill counts board tasks only", async () => {
    const { task, recount, counters, backfill } = setup();
    await task({});
    await task({ status: "done" });
    await task({ status: "dropped" });
    await task({ triage_status: "suggested" });
    await task({ project_id: undefined });
    await task({ status: "in_review", workspace: "user:u1" });
    await backfill();
    expect(await counters()).toEqual({ "p1|team:t1|open": 1, "p1|team:t1|done": 1, "p1|user:u1|in_review": 1 });
    expect(await counters()).toEqual(await recount());
  });

  test("live writes move tasks between buckets once the backfill is done", async () => {
    const { db, task, recount, counters, backfill } = setup();
    const a = await task({});
    await backfill();
    const b = await task({ status: "in_progress" });
    await db.patch(a, { status: "done" });
    await db.patch(b, { project_id: "p2" });
    await db.patch(b, { workspace: "user:u1" });
    await db.patch(b, { title: "renamed" });
    const c = await task({ source: "insight" });
    await db.patch(c, { promoted: true });
    await db.delete(a);
    expect(await counters()).toEqual(await recount());
    expect(await counters()).toEqual({ "p2|user:u1|in_progress": 1, "p1|team:t1|open": 1 });
  });

  test("writes during a backfill are counted exactly once", async () => {
    const { raw, db, task, recount, counters } = setup();
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await task({}));
    await backfillProjectCountsPage({ db: raw }, 2);
    await db.patch(ids[0], { status: "done" });
    await db.patch(ids[4], { status: "done" });
    await task({ status: "in_progress" });
    await db.delete(ids[1]);
    await db.delete(ids[3]);
    while (!(await backfillProjectCountsPage({ db: raw }, 2)).done) await task({});
    expect(await counters()).toEqual(await recount());
  });

  test("reset recounts from zero", async () => {
    const { raw, task, recount, counters, backfill } = setup();
    await task({});
    await backfill();
    await raw.insert("project_task_counts", { project_id: "p1", workspace: "team:t1", status: "open", count: 40 });
    await resetProjectCounts({ db: raw });
    await backfill();
    expect(await counters()).toEqual(await recount());
  });

  test("a viewer sums only the workspaces they hold", async () => {
    const { raw, task, backfill } = setup();
    await task({});
    await task({ status: "done" });
    await task({ status: "in_review" });
    await task({ workspace: "user:u1" });
    await task({ workspace: "user:u3" });
    await backfill();
    const of = async (u: string) => (await projectCountsFor({ db: raw }, u as any, ["p1" as any])).get("p1");
    expect(await of("u1")).toEqual({ total: 4, done: 1, in_progress: 1, open: 2 });
    expect(await of("u2")).toEqual({ total: 3, done: 1, in_progress: 1, open: 1 });
    expect(await of("u3")).toEqual({ total: 1, done: 0, in_progress: 0, open: 1 });
  });
});
