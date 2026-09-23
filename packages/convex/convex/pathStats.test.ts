// Exact folder totals at any size: the rebuild pages through every index range
// a folder spans with no cap, and the summary answers "before date X" from the
// histogram. The fake db here honors range bounds (gte/lt) and creation order,
// because the folder match lives in exactly those bounds.
import { describe, expect, test } from "bun:test";
import { bucketOf, emptyAcc, foldConversation, recomputePathStats, requestPathStats, startedBefore } from "./pathStats";

const U = "u1" as any;
const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-24T12:00:00Z");

function makeDb(conversations: any[]) {
  const tables: Record<string, any[]> = { conversations: conversations.map((c, i) => ({ _creationTime: i, ...c })), path_session_stats: [] };
  let n = 0;
  const query = (table: string) => {
    let rows = () => tables[table];
    let desc = false;
    const b: any = {
      withIndex(_name: string, fn: (q: any) => any) {
        const conds: Array<(r: any) => boolean> = [];
        const q: any = {
          eq: (f: string, val: any) => { conds.push((r) => r[f] === val); return q; },
          gte: (f: string, val: any) => { conds.push((r) => r[f] != null && r[f] >= val); return q; },
          lt: (f: string, val: any) => { conds.push((r) => r[f] != null && r[f] < val); return q; },
        };
        fn(q);
        const base = rows;
        rows = () => base().filter((r) => conds.every((c) => c(r)));
        return b;
      },
      order(dir: string) { desc = dir === "desc"; return b; },
      async first() { return b.snapshot()[0] ?? null; },
      async take(k: number) { return b.snapshot().slice(0, k); },
      async paginate({ numItems, cursor }: any) {
        const all = b.snapshot();
        const start = cursor ? Number(cursor) : 0;
        return { page: all.slice(start, start + numItems), isDone: start + numItems >= all.length, continueCursor: String(start + numItems) };
      },
      snapshot() { const r = [...rows()].sort((a, c) => a._creationTime - c._creationTime); return desc ? r.reverse() : r; },
    };
    return b;
  };
  const db = {
    query,
    async insert(table: string, doc: any) { const _id = `${table}_${++n}`; tables[table].push({ _id, ...doc }); return _id; },
    async patch(id: any, patch: any) { for (const rows of Object.values(tables)) { const r = rows.find((x) => x._id === id); if (r) Object.assign(r, patch); } },
  };
  const queue: any[] = [];
  const ctx = { db, scheduler: { runAfter: async (_ms: number, _fn: any, args: any) => { queue.push(args); } } };
  const drain = async () => {
    const run = (recomputePathStats as any)._handler ?? (recomputePathStats as any).handler;
    let steps = 0;
    while (queue.length) { await run(ctx, queue.shift()); steps++; }
    return steps;
  };
  return { ctx, tables, drain };
}

describe("folder totals", () => {
  test("a folder past the old 1,024 cap counts exactly, nested roots and plain subfolders included", async () => {
    const convs: any[] = [];
    for (let i = 0; i < 1500; i++) convs.push({ user_id: U, git_root: "/src/app", started_at: NOW - i * HOUR });
    convs.push({ user_id: U, git_root: "/src/app/tools", started_at: NOW - 3 * HOUR });
    convs.push({ user_id: U, project_path: "/src/app-other", started_at: NOW });
    convs.push({ user_id: U, project_path: "/src/app/scratch", started_at: NOW, team_visibility: "private" });
    // A subfolder session filed under the checkout is counted once, by its root.
    convs.push({ user_id: U, git_root: "/src/app", project_path: "/src/app/web", started_at: NOW, is_private: false, team_id: "t" });
    convs.push({ user_id: "u2", git_root: "/src/app", started_at: NOW });
    const { ctx, tables, drain } = makeDb(convs);
    const queued = await requestPathStats(ctx, U, ["/src/app"]);
    expect(queued).toBe(1);
    expect(await drain()).toBeGreaterThan(7);
    const row = tables.path_session_stats[0];
    expect(row).toMatchObject({ path: "/src/app", count: 1503, hidden: 1, manually_shared: 1 });
    expect(row.refresh_started_at).toBeUndefined();
    expect(row.computed_at).toBeGreaterThan(0);
    // Before a local midnight 24 hours ago: every session older than a day.
    const cutoff = NOW - 24 * HOUR;
    expect(startedBefore(row.buckets, row.bucket_counts, cutoff)).toBe(1500 - 25);
  });

  test("a fresh row is not rebuilt, a forced one is, and a rebuild in flight is never doubled", async () => {
    const { ctx, tables, drain } = makeDb([{ user_id: U, git_root: "/a", started_at: NOW }]);
    await requestPathStats(ctx, U, ["/a"]);
    expect(await requestPathStats(ctx, U, ["/a"], true)).toBe(0);
    await drain();
    expect(await requestPathStats(ctx, U, ["/a"])).toBe(0);
    expect(await requestPathStats(ctx, U, ["/a"], true)).toBe(1);
    await drain();
    expect(tables.path_session_stats).toHaveLength(1);
    expect(tables.path_session_stats[0].count).toBe(1);
  });

  test("buckets: hours for the last 180 days, days before", () => {
    expect(bucketOf(NOW - 90 * 60_000, NOW)).toBe(Math.floor((NOW - 90 * 60_000) / HOUR) * HOUR);
    const old = NOW - 400 * 24 * HOUR - 5 * HOUR;
    expect(bucketOf(old, NOW) % (24 * HOUR)).toBe(0);
    const acc = emptyAcc();
    foldConversation(acc, { started_at: Number.NaN, updated_at: NOW }, NOW);
    expect(acc.count).toBe(1);
    expect(acc.first).toBeNull();
  });
});
