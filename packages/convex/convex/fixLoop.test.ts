// The fix loop's server side: a deferred finding without an owner or a due
// date is refused, the overdue sweep fires once per finding, and the health
// board's per-role counts read the right rows.
import { describe, expect, test } from "bun:test";
import { DEFERRAL_NEEDS_OWNER, overduePromises, promiseFields } from "./reviewNotes";
import { fixLoopCounts, readFixLoopCounts } from "./orgHealth";

const DAY = 86_400_000;

describe("disposition", () => {
  test("deferred needs an owner and a due date", () => {
    const due = Date.now() + 7 * DAY;
    expect(() => promiseFields({ disposition: "deferred", due_at: due }, {})).toThrow(DEFERRAL_NEEDS_OWNER);
    expect(() => promiseFields({ disposition: "deferred" }, { role_id: "r1" as any })).toThrow(DEFERRAL_NEEDS_OWNER);
    expect(promiseFields({ disposition: "deferred", due_at: due }, { role_id: "r1" as any })).toMatchObject({ disposition: "deferred", owner_role_id: "r1", due_at: due });
    expect(promiseFields({ disposition: "fixed" }, {})).toEqual({ disposition: "fixed" });
    expect(promiseFields({}, {})).toEqual({});
  });
});

/** A fake db over one table with the two indexes the code reads. */
function fakeDb(rows: Record<string, any>[]) {
  const query = (table: string) => ({
    withIndex: (_name: string, build: (q: any) => any) => {
      const conds: ((r: any) => boolean)[] = [];
      const q = {
        eq: (f: string, val: any) => { conds.push((r) => r[f] === val); return q; },
        lt: (f: string, val: any) => { conds.push((r) => r[f] !== undefined && r[f] < val); return q; },
        gte: (f: string, val: any) => { conds.push((r) => r[f] !== undefined && r[f] >= val); return q; },
      };
      build(q);
      const matching = rows.filter((r) => r.table === table && conds.every((c) => c(r)));
      return { take: async (n: number) => matching.slice(0, n), collect: async () => matching };
    },
  });
  return { query, patch: async (id: string, p: any) => { Object.assign(rows.find((r) => r._id === id)!, p); } };
}

describe("overdue sweep", () => {
  test("fires once per overdue, unresolved, deferred finding", async () => {
    const now = Date.now();
    const rows = [
      { _id: "late", table: "review_comments", disposition: "deferred", due_at: now - DAY, resolved: false },
      { _id: "ontime", table: "review_comments", disposition: "deferred", due_at: now + DAY, resolved: false },
      { _id: "closed", table: "review_comments", disposition: "deferred", due_at: now - DAY, resolved: true },
      { _id: "fixed", table: "review_comments", disposition: "fixed", due_at: now - DAY, resolved: false },
    ];
    const db = fakeDb(rows);
    const first = await overduePromises(db, now);
    expect(first.map((r) => r._id)).toEqual(["late"]);
    // What sweepOverduePromises does before scheduling the signal.
    await db.patch("late", { promise_signaled_at: now });
    expect(await overduePromises(db, now + DAY)).toEqual([]);
  });
});

describe("health counts", () => {
  test("bugs introduced come from szz signals by role, promises from owned deferred findings", async () => {
    const now = Date.now();
    const rows = [
      { _id: "s1", table: "signals", workspace: "team:t1", created_at: now - DAY, fingerprint: "szz:abc", role_id: "r1" },
      { _id: "s2", table: "signals", workspace: "team:t1", created_at: now - DAY, fingerprint: "szz:def", role_id: "r1" },
      { _id: "s3", table: "signals", workspace: "team:t1", created_at: now - 40 * DAY, fingerprint: "szz:old", role_id: "r1" },
      { _id: "s4", table: "signals", workspace: "team:t1", created_at: now - DAY, fingerprint: "insight:x", role_id: "r1" },
      { _id: "s5", table: "signals", workspace: "team:t1", created_at: now - DAY, fingerprint: "szz:ghi", role_id: "r2" },
      { _id: "p1", table: "review_comments", owner_role_id: "r1", resolved: false, disposition: "deferred", due_at: now - DAY },
      { _id: "p2", table: "review_comments", owner_role_id: "r1", resolved: false, disposition: "deferred", due_at: now + DAY },
      { _id: "p3", table: "review_comments", owner_role_id: "r1", resolved: true, disposition: "deferred", due_at: now - DAY },
      { _id: "p4", table: "review_comments", owner_role_id: "r1", resolved: false, disposition: "rejected" },
    ];
    const inputs = await readFixLoopCounts({ db: fakeDb(rows) }, "u1" as any, "t1" as any, now, ["r1", "r2"] as any);
    expect(fixLoopCounts(inputs, "r1", 3)).toEqual({ bugs_introduced_30d: 2, promises_open: 2, promises_overdue: 1, done_with_concerns_7d: 3 });
    expect(fixLoopCounts(inputs, "r2", 0)).toEqual({ bugs_introduced_30d: 1, promises_open: 0, promises_overdue: 0, done_with_concerns_7d: 0 });
  });
});
