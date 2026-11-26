// The relative-rank backfill (priorityRankBackfill.ts): the order a list showed
// under the absolute rank is the order it shows after, the person's ranks
// become their places, a dry run writes nothing, and a second run finds
// nothing left to do, even after passes and moves made between the deploy and the backfill.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { api, internal } from "./_generated/api";
import { legacyOrder } from "./priorityRankBackfill";

setDefaultTimeout(60_000);

const NOW = Date.now();
const DAY = 86_400_000;
const backfill = (internal as any).priorityRankBackfill.run;

async function world() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const ada = await ctx.db.insert("users", { name: "Ada" } as any);
    const acme = await ctx.db.insert("teams", { name: "Acme", created_at: NOW, features: { priorities: true } } as any);
    await ctx.db.insert("team_memberships", { user_id: ada, team_id: acme, role: "member", joined_at: 1 } as any);
    const ws = `team:${acme}`;
    const insert = (short_id: string, fields: Record<string, unknown>) => ctx.db.insert("priorities", {
      user_id: ada, workspace: ws, short_id, title: short_id, summary: "", status: "active",
      steps: [], first_seen_at: 1, last_active_at: NOW - DAY, pass_at: 1, created_at: 1, updated_at: 1, ...fields,
    } as any);
    // The person pinned pri-3 at #1 and pri-5 at #3; the pass ranked the rest.
    await insert("pri-1", { rank: 1, rank_set_by: "pass" });
    await insert("pri-2", { rank: 2, rank_set_by: "pass" });
    await insert("pri-3", { rank: 1, rank_set_by: "person" });
    await insert("pri-4", { rank_set_by: "pass", last_active_at: NOW - 3 * DAY });
    await insert("pri-5", { rank: 3, rank_set_by: "person", updated_at: 2 });
    await insert("pri-6", { status: "done", rank_set_by: "pass" });
    await insert("pri-7", { workspace: `user:${ada}`, rank: 1, rank_set_by: "person" });
    return { ada, ws };
  });
  return { t, ...ids };
}

const positions = async (w: Awaited<ReturnType<typeof world>>, workspace = w.ws) =>
  (await w.t.withIdentity({ subject: `${w.ada}|session` }).query((api as any).priorities.list, { workspace, status: "active" })).priorities
    .map((p: any) => `${p.rank}:${p.short_id}:${p.rank_source}`);

/** Every page, as auto would schedule them, `numItems` at a time. */
async function drain(w: Awaited<ReturnType<typeof world>>, args: Record<string, unknown>) {
  const totals = { placed: 0, slotted: 0, appended: 0, cleared: 0 };
  let cursor: string | undefined;
  for (;;) {
    const out = await w.t.mutation(backfill, { ...args, numItems: 2, ...(cursor ? { cursor } : {}) });
    for (const k of Object.keys(totals) as Array<keyof typeof totals>) totals[k] += out[k];
    if (out.done) return totals;
    cursor = out.cursor;
  }
}

describe("priorityRankBackfill", () => {
  test("keeps the order the absolute rank showed: the person's ranks become their places, the pass's its slots", async () => {
    const w = await world();
    const legacy = await w.t.run(async (ctx) => legacyOrder((await ctx.db.query("priorities").collect()).filter((p) => p.workspace === w.ws && p.status === "active")).map((p) => p.short_id));
    expect(legacy).toEqual(["pri-3", "pri-1", "pri-5", "pri-2", "pri-4"]);

    expect(await drain(w, {})).toEqual({ placed: 3, slotted: 3, appended: 0, cleared: 1 });
    expect(await w.t.run(async (ctx) => (await ctx.db.query("priorities").collect()).filter((p) => p.person_pos !== undefined || p.ai_rank !== undefined))).toEqual([]);

    expect(await drain(w, { dryRun: false })).toEqual({ placed: 3, slotted: 3, appended: 0, cleared: 1 });
    expect(await positions(w)).toEqual(["1:pri-3:person", "2:pri-1:ai", "3:pri-5:person", "4:pri-2:ai", "5:pri-4:ai"]);
    const rows = await w.t.run(async (ctx) => ctx.db.query("priorities").collect());
    for (const p of rows) expect([p.rank, p.rank_set_by]).toEqual([undefined, undefined]);
    expect(rows.map((p) => [p.short_id, p.person_pos ?? null, p.ai_rank ?? null])).toEqual([
      ["pri-1", null, 2], ["pri-2", null, 4], ["pri-3", 1, null], ["pri-4", null, 5], ["pri-5", 3, null], ["pri-6", null, null], ["pri-7", 1, null],
    ]);

    // Idempotent: nothing is left to rewrite, and the order holds.
    expect(await drain(w, { dryRun: false })).toEqual({ placed: 0, slotted: 0, appended: 0, cleared: 0 });
    expect(await w.t.run(async (ctx) => ctx.db.query("priorities").collect())).toEqual(rows);
  });

  test("a move made after the deploy keeps its place, a priority the pass made since follows the old order, and a run after a pass writes nothing", async () => {
    const w = await world();
    await w.t.run(async (ctx) => {
      // Between the deploy and the backfill: the person moved pri-2 to the top, and a pass made pri-9 at its own #1.
      const two = (await ctx.db.query("priorities").collect()).find((p) => p.short_id === "pri-2")!;
      await ctx.db.patch(two._id, { person_pos: 0.5 });
      await ctx.db.insert("priorities", {
        user_id: w.ada, workspace: w.ws, short_id: "pri-9", title: "pri-9", summary: "", status: "active", ai_rank: 1,
        steps: [], first_seen_at: 1, last_active_at: NOW, pass_at: 1, created_at: 1, updated_at: 1,
      } as any);
    });
    expect(await drain(w, { dryRun: false })).toEqual({ placed: 4, slotted: 2, appended: 1, cleared: 1 });
    expect(await positions(w)).toEqual(["1:pri-2:person", "2:pri-3:person", "3:pri-1:ai", "4:pri-5:person", "5:pri-4:ai", "6:pri-9:ai"]);
    // A pass reslots one of its own; the backfill run again changes nothing.
    await w.t.run(async (ctx) => {
      const one = (await ctx.db.query("priorities").collect()).find((p) => p.short_id === "pri-1")!;
      await ctx.db.patch(one._id, { ai_rank: 5.5 });
    });
    const rows = await w.t.run(async (ctx) => ctx.db.query("priorities").collect());
    expect(await drain(w, { dryRun: false })).toEqual({ placed: 0, slotted: 0, appended: 0, cleared: 0 });
    expect(await w.t.run(async (ctx) => ctx.db.query("priorities").collect())).toEqual(rows);
  });
});
