// A priority's sessions moved and cleared in bounded pages
// (priorityPassSessions.ts): no transaction reads every session of a
// priority, every page converges, and a placed session's milestone, the
// person's drops and moved keys hold on every page.
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { H, pass, proposal, stubModel, world } from "./priorityPassRun.testkit";
import * as passRun from "./priorityPassRun";
import * as passSessions from "./priorityPassSessions";
import * as prioritiesModule from "./priorities";
import * as stepKeyBackfill from "./priorityStepKeyBackfill";

setDefaultTimeout(60_000);

const model = stubModel();
const pri = (api as any).priorities;

type World = Awaited<ReturnType<typeof world>>;
const as = (w: World, user: Id<"users">) => w.t.withIdentity({ subject: `${user}|session` });
const run = async (w: World) => {
  const r = await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
  expect(r.status).toBe("ok");
  return r;
};
/** Lands after the last pass, just under its cursor: the overlap reads it (LATE_MARGIN_MS, OVERLAP_MS). */
const late = () => Date.now() - 7 * 60_000;
const byShort = async (w: World, short_id: string) => (await w.priorities()).find((p: any) => p.short_id === short_id)!;

const steps = [
  { key: "s1", title: "Grader faults under 10%", tier: "critical", refs: [{ kind: "session", id: "jx7team" }] },
  { key: "s2", title: "Ship the grader", tier: "critical", refs: [] },
  { key: "s3", title: "Docs", tier: "polish", refs: [] },
];

/** Ana's first pass: pri-1 with three milestones, holding jx7team. */
async function seeded() {
  const w = await world();
  await w.send(w.ana, w.teamConv, w.now - 3 * H, "get grader faults under ten percent");
  model.reply = () => JSON.stringify({ priorities: [proposal({ steps })], unassigned: [] });
  await run(w);
  return w;
}

describe("past 1,500 sessions on one priority", () => {
  const MANY = 1500;
  /** Each watched transaction's session reads (the limit each asked for; Infinity for a read of all) and the sessions it wrote. */
  type Tx = { fn: string; limits: number[]; read: number; patched: number; wrote: number };
  const watched: Array<[any, string]> = [
    [passRun.applyPlan, "applyPlan"], [passSessions.moveMergedSessions, "moveMergedSessions"], [passSessions.clearDeadStepKeys, "clearDeadStepKeys"],
    [prioritiesModule.dropStep, "dropStep"], [prioritiesModule.merge, "merge"], [stepKeyBackfill.run, "backfill"],
  ];
  let txs: Tx[] = [];
  const originals = new Map<any, any>();
  const countedQuery = (q: any, tx: Tx): any => new Proxy(q, {
    get(target, prop) {
      if (prop === Symbol.asyncIterator) {
        tx.limits.push(Infinity);
        return () => {
          const it = target[Symbol.asyncIterator]();
          return { next: async () => { const r = await it.next(); if (!r.done) tx.read++; return r; } };
        };
      }
      const val = target[prop];
      if (typeof val !== "function") return val;
      return (...a: any[]) => {
        const out = val.apply(target, a);
        if (prop === "take") { tx.limits.push(a[0]); return out.then((rows: any[]) => { tx.read += rows.length; return rows; }); }
        if (prop === "collect" || prop === "paginate") { tx.limits.push(prop === "paginate" ? a[0].numItems : Infinity); return out.then((r: any) => { tx.read += (r.page ?? r).length; return r; }); }
        if (prop === "first" || prop === "unique") { tx.limits.push(1); return out.then((r: any) => { if (r) tx.read++; return r; }); }
        return countedQuery(out, tx);
      };
    },
  });
  const countingCtx = (ctx: any, tx: Tx) => {
    const db = new Proxy(ctx.db, {
      get(target, prop) {
        if (prop === "query") return (table: string) => (table === "conversations" ? countedQuery(target.query(table), tx) : target.query(table));
        if (prop === "patch") return (id: any, ...rest: any[]) => { tx.wrote++; if (target.normalizeId("conversations", id)) tx.patched++; return target.patch(id, ...rest); };
        const val = target[prop];
        return typeof val === "function" ? val.bind(target) : val;
      },
    });
    return new Proxy(ctx, { get: (target, prop) => (prop === "db" ? db : target[prop]) });
  };
  beforeAll(() => {
    for (const [fn, name] of watched) {
      const orig = fn._handler;
      originals.set(fn, orig);
      fn._handler = (ctx: any, args: any) => {
        const tx: Tx = { fn: name, limits: [], read: 0, patched: 0, wrote: 0 };
        txs.push(tx);
        return orig(countingCtx(ctx, tx), args);
      };
    }
  });
  afterAll(() => { for (const [fn] of watched) fn._handler = originals.get(fn); });

  /** Every scheduled run, until none is left. */
  const drain = async (w: World) => {
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 5));
      await w.t.finishInProgressScheduledFunctions();
      const pending = (await w.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter((j: any) => j.state.kind === "pending" || j.state.kind === "inProgress");
      if (!pending.length) return;
    }
    throw new Error("scheduled runs never settled");
  };
  const make = (w: World, priority: Id<"priorities">, n: number, step?: string, fields: Record<string, unknown> = {}) => w.t.run(async (ctx) => {
    for (let i = 0; i < n; i++) {
      await ctx.db.insert("conversations", {
        user_id: w.ana, agent_type: "claude_code", session_id: `jx7m${priority}${i}`, team_id: w.acme, is_private: false, team_visibility: "full",
        started_at: 1, updated_at: 1, message_count: 1, status: "active", priority_id: priority, ...(step ? { priority_step_key: step } : {}), ...fields,
      } as any);
    }
  });
  const on = (w: World, priority: Id<"priorities">, step?: string) => w.t.run(async (ctx) => (await ctx.db.query("conversations").withIndex("by_priority", (q) => q.eq("priority_id", priority)).collect()).filter((c) => step === undefined || c.priority_step_key === step).length);
  const priority = (w: World, short_id: string, fields: Record<string, unknown> = {}) => w.t.run((ctx) => ctx.db.insert("priorities", {
    user_id: w.ana, workspace: w.team, short_id, title: short_id, summary: "", status: "active", ai_rank: 5, steps: [], first_seen_at: 1, last_active_at: 1, pass_at: 1, created_at: 1, updated_at: 1, ...fields,
  } as any));
  const applyPlan = (w: World, plan: Record<string, unknown>) => w.t.mutation(pass.applyPlan, {
    user_id: w.ana, workspace: w.team, started_at: Date.now(), from_cursor: 1, cursor_at: 2, model: "m",
    plan: { creates: [], updates: [], merges: [], sessions: [], unmap: [], notes: [], rewritten: [], ...plan },
  });
  /** No transaction read every session of a priority: each read asked for a page, at most the count's own cap; none wrote more than a page of sessions. */
  const bounded = () => {
    expect(txs.length).toBeGreaterThan(1);
    for (const tx of txs) {
      expect({ fn: tx.fn, over: tx.limits.filter((n) => n > passSessions.SESSION_COUNT_CAP + 1) }).toEqual({ fn: tx.fn, over: [] });
      expect(tx.patched).toBeLessThanOrEqual(passSessions.SESSION_PAGE);
    }
  };
  beforeEach(() => { txs = []; });

  test("a person's drop clears a page now and the rest in scheduled runs", async () => {
    const w = await seeded();
    const p1 = await byShort(w, "pri-1");
    await make(w, p1._id, MANY, "s3");
    const total = await on(w, p1._id);
    txs = [];
    await as(w, w.ana).mutation(pri.dropStep, { short_id: "pri-1", step_key: "s3" });
    // The first page, oldest first, holds the seeded session too.
    expect(await on(w, p1._id, "s3")).toBe(total - passSessions.SESSION_PAGE);
    await drain(w);
    expect([await on(w, p1._id, "s3"), await on(w, p1._id)]).toEqual([0, total]);
    expect(txs.filter((t) => t.fn === "clearDeadStepKeys").length).toBe(Math.ceil(MANY / passSessions.SESSION_PAGE) - 1);
    bounded();
  }, 180_000);

  test("a plan that removes a milestone clears its sessions a page at a time", async () => {
    const w = await seeded();
    const p1 = await byShort(w, "pri-1");
    await make(w, p1._id, MANY, "s2");
    const total = await on(w, p1._id);
    txs = [];
    await applyPlan(w, { updates: [{ short_id: "pri-1", patch: { steps: p1.steps.filter((s: any) => s.key !== "s2") } }] });
    // Past one page, every page is read for a placed session that would put the milestone back before any key is cleared.
    expect(await on(w, p1._id, "s2")).toBe(MANY);
    await drain(w);
    expect([await on(w, p1._id, "s2"), await on(w, p1._id)]).toEqual([0, total]);
    bounded();
  }, 180_000);

  test("the pass's merge moves a page now and the rest in scheduled runs, onto the carried milestone", async () => {
    const w = await seeded();
    const p1 = await byShort(w, "pri-1");
    const p8 = await priority(w, "pri-8", { steps: [{ key: "s1", title: "Grader faults under 10%", tier: "critical", refs: [] }] });
    await make(w, p8, MANY, "s1");
    const before = await on(w, p1._id, "s1");
    txs = [];
    await applyPlan(w, { merges: [{ short_id: "pri-8", merged_into: "pri-1", step_keys: { s1: "s1" } }] });
    expect(await on(w, p8)).toBe(MANY - passSessions.SESSION_PAGE);
    await drain(w);
    expect([await on(w, p8), await on(w, p1._id, "s1")]).toEqual([0, before + MANY]);
    const survivor = await byShort(w, "pri-1");
    expect([survivor.session_count, survivor.session_count_capped]).toEqual([MANY + (p1.session_count ?? 0), true]);
    bounded();
  }, 180_000);

  test("the person's merge moves a page now and the rest in scheduled runs, each onto its milestone's new key", async () => {
    const w = await seeded();
    const p1 = await byShort(w, "pri-1");
    const p9 = await priority(w, "pri-9", { steps: [{ key: "s1", title: "Auth", tier: "critical", refs: [] }] });
    await make(w, p9, MANY, "s1");
    txs = [];
    await as(w, w.ana).mutation(pri.merge, { short_id: "pri-9", into: "pri-1" });
    expect(await on(w, p9)).toBe(MANY - passSessions.SESSION_PAGE);
    await drain(w);
    const carried = (await byShort(w, "pri-1")).steps.find((s: any) => s.title === "Auth").key;
    expect([await on(w, p9), await on(w, p1._id, carried)]).toEqual([0, MANY]);
    bounded();
  }, 180_000);

  test("the backfill lifts a mark from every session, a budget of sessions a run; a second run lifts nothing", async () => {
    const w = await seeded();
    const p1 = await byShort(w, "pri-1");
    const p8 = await priority(w, "pri-8");
    // The oldest session holds s40, past the newest page a write reads: the mark a write takes misses it.
    await make(w, p8, 1, "s40");
    await make(w, p8, MANY - 1);
    await w.t.run((ctx) => ctx.db.patch(p1._id, { step_key_max: undefined } as any));
    const backfill = (internal as any).priorityStepKeyBackfill.run;
    txs = [];
    const dry = await w.t.mutation(backfill, {});
    expect(dry).toMatchObject({ dryRun: true, done: false });
    expect((await byShort(w, "pri-8")).step_key_max).toBeUndefined();
    await w.t.mutation(backfill, { dryRun: false, auto: true });
    await drain(w);
    expect([(await byShort(w, "pri-1")).step_key_max, (await byShort(w, "pri-8")).step_key_max]).toEqual([3, 40]);
    const runs = txs.filter((t) => t.fn === "backfill");
    for (const r of runs) expect(r.read).toBeLessThanOrEqual(stepKeyBackfill.SESSION_BUDGET);
    expect(runs.length).toBeGreaterThan(2);
    bounded();
    txs = [];
    await w.t.mutation(backfill, { dryRun: false, auto: true });
    await drain(w);
    const reruns = txs.filter((t) => t.fn === "backfill");
    expect(reruns.length).toBeGreaterThan(1);
    expect(reruns.every((t) => t.wrote === 0)).toBe(true);
  }, 180_000);

  /** One session the person placed, `older` sessions before it and 250 after: past the newest page the plan's own read of anchors sees. */
  const placedAmong = async (w: World, priority: Id<"priorities">, step: string, older: number, olderStep?: string) => {
    await make(w, priority, older, olderStep);
    await make(w, priority, 1, step, { priority_set_by: "person", session_id: "jx7placed" });
    await make(w, priority, 250);
    return w.t.run(async (ctx) => (await ctx.db.query("conversations").withIndex("by_priority", (q) => q.eq("priority_id", priority)).collect()).find((c) => c.session_id === "jx7placed")!._id);
  };

  for (const [where, older] of [["the first page", 0], ["the first page, after older sessions", 50], ["a scheduled page", 210]] as const) {
    test(`a pass merge carries the milestone an old placed session sits on, in ${where}`, async () => {
      const w = await seeded();
      const p8 = await priority(w, "pri-8", { steps: [{ key: "s1", title: "Auth", tier: "critical", refs: [] }], step_key_max: 1 });
      const placed = await placedAmong(w, p8, "s1", older);
      await applyPlan(w, { merges: [{ short_id: "pri-8", merged_into: "pri-1", step_keys: {} }] });
      await drain(w);
      const survivor = await byShort(w, "pri-1");
      const auth = survivor.steps.find((s: any) => s.title === "Auth" && !s.dropped);
      expect(auth?.key).toBe("s4");
      expect(survivor.step_key_max).toBe(4);
      expect(await w.conversation(placed)).toMatchObject({ priority_id: survivor._id, priority_step_key: "s4", priority_set_by: "person" });
      bounded();
    }, 120_000);

    test(`a plan that removes the milestone an old placed session sits on puts it back, in ${where}`, async () => {
      const w = await seeded();
      const p1 = await byShort(w, "pri-1");
      // The pass's sessions on it, older than the placed one (earlier in its page, or in earlier pages), and newer.
      const placed = await placedAmong(w, p1._id, "s2", older, "s2");
      await make(w, p1._id, 3, "s2");
      await applyPlan(w, { updates: [{ short_id: "pri-1", patch: { steps: p1.steps.filter((s: any) => s.key !== "s2") } }] });
      await drain(w);
      const after = await byShort(w, "pri-1");
      expect(after.steps.find((s: any) => s.key === "s2")).toMatchObject({ title: "Ship the grader" });
      expect((await w.conversation(placed))?.priority_step_key).toBe("s2");
      // The milestone is back, so the pass's sessions on it keep it too, whatever their place in the pages.
      expect(await on(w, p1._id, "s2")).toBe(older + 4);
      bounded();
    }, 120_000);
  }

  test("a merge's later pages follow its survivor when the person merged that away meanwhile, onto the milestone it carried", async () => {
    const w = await seeded();
    const p1 = await byShort(w, "pri-1");
    const p8 = await priority(w, "pri-8", { steps: [{ key: "s1", title: "Grader faults under 10%", tier: "critical", refs: [] }], step_key_max: 1, status: "merged", merged_into: p1._id });
    // pri-2 has a milestone of that title of its own: the pages follow the copy the merge carried, as pri-1's sessions do.
    const p2 = await priority(w, "pri-2", { steps: [{ key: "s1", title: "Grader faults under 10%", tier: "critical", refs: [] }], step_key_max: 1 });
    // The pass merged pri-8 into pri-1; its first page ran, these 250 wait for the next.
    await make(w, p8, 250, "s1");
    await as(w, w.ana).mutation(pri.merge, { short_id: "pri-1", into: "pri-2" });
    await drain(w);
    const carried = (await byShort(w, "pri-2")).steps.findLast((s: any) => s.title === "Grader faults under 10%").key;
    expect(carried).toBe("s2");
    await w.t.mutation((internal as any).priorityPassSessions.moveMergedSessions, { from: p8, into: p1._id, step_keys: { s1: "s1" }, after: 0 });
    await drain(w);
    expect([await on(w, p8), await on(w, p1._id), await on(w, p2, carried) >= 250, await on(w, p2, "s1")]).toEqual([0, 0, true, 0]);
  }, 120_000);

  /** pri-8 merged into pri-1 by the pass, whose first page carried pri-8/s1 Auth as pri-1/s4; the person then drops s4. The next page holds a placed session on pri-8/s1. */
  const droppedBetweenPages = async () => {
    const w = await seeded();
    const p1 = await byShort(w, "pri-1");
    const auth = { key: "s1", title: "Auth", tier: "critical", tier_set_by: "pass", refs: [], done: false };
    const p8 = await priority(w, "pri-8", { steps: [auth], step_key_max: 1, status: "merged", merged_into: p1._id });
    await w.t.run((ctx) => ctx.db.patch(p1._id, { steps: [...p1.steps, { ...auth, key: "s4" }], step_key_max: 4 } as any));
    const placed = await placedAmong(w, p8, "s1", 0);
    await as(w, w.ana).mutation(pri.dropStep, { short_id: "pri-1", step_key: "s4" });
    await drain(w);
    return { w, p1, p8, placed };
  };
  const liveAuth = (row: any) => row.steps.filter((s: any) => !s.dropped && s.title === "Auth");

  test("a later merge page never brings back a milestone the person dropped since the first page carried it", async () => {
    const { w, p1, p8, placed } = await droppedBetweenPages();
    await w.t.mutation((internal as any).priorityPassSessions.moveMergedSessions, { from: p8, into: p1._id, step_keys: { s1: "s4" }, after: 0 });
    await drain(w);
    expect(liveAuth(await byShort(w, "pri-1"))).toEqual([]);
    const conv = await w.conversation(placed);
    expect([conv?.priority_id, conv?.priority_step_key]).toEqual([p1._id, undefined]);
  }, 120_000);

  test("nor onto the survivor the person merged it into, which holds the drop", async () => {
    const { w, p1, p8, placed } = await droppedBetweenPages();
    const p2 = await priority(w, "pri-2", { steps: [], step_key_max: 0 });
    await as(w, w.ana).mutation(pri.merge, { short_id: "pri-1", into: "pri-2" });
    await drain(w);
    await w.t.mutation((internal as any).priorityPassSessions.moveMergedSessions, { from: p8, into: p1._id, step_keys: { s1: "s4" }, after: 0 });
    await drain(w);
    expect(liveAuth(await byShort(w, "pri-2"))).toEqual([]);
    const conv = await w.conversation(placed);
    expect([conv?.priority_id, conv?.priority_step_key]).toEqual([p2, undefined]);
  }, 120_000);

  test("a person's drop clears the milestone off a session they placed on it", async () => {
    const w = await seeded();
    const p1 = await byShort(w, "pri-1");
    const placed = await placedAmong(w, p1._id, "s3", 210);
    await as(w, w.ana).mutation(pri.dropStep, { short_id: "pri-1", step_key: "s3" });
    await drain(w);
    expect((await w.conversation(placed))?.priority_step_key).toBeUndefined();
    expect((await byShort(w, "pri-1")).steps.find((s: any) => s.key === "s3")?.dropped).toBe(true);
  }, 120_000);
});
describe("a pass merge onto a milestone key a person's merge took", () => {
  test("the pass carries pri-7/s1 Auth as s4; a person merges pri-9's Billing in first, taking s4; pri-7's placed session and correction land on Auth's new key", async () => {
    const w = await seeded();
    const p1 = await byShort(w, "pri-1");
    const insert = (short_id: string, title: string) => w.t.run((ctx) => ctx.db.insert("priorities", {
      user_id: w.ana, workspace: w.team, short_id, title: short_id, summary: "", status: "active", ai_rank: 5, step_key_max: 1,
      steps: [{ key: "s1", title, tier: "critical", refs: [] }], first_seen_at: 1, last_active_at: 1, pass_at: 1, created_at: 1, updated_at: 1,
    } as any));
    const p7 = await insert("pri-7", "Auth");
    await insert("pri-9", "Billing");
    await w.t.run((ctx) => ctx.db.patch(w.oldConv, { priority_id: p7, priority_step_key: "s1", priority_set_by: "person" } as any));
    const me = as(w, w.ana);
    await me.mutation(pri.correct, { short_id: "pri-7", step_key: "s1", text: "Auth waits on SSO" });
    // The person's merge lands after the pass read pri-1 as s1-s3.
    await me.mutation(pri.merge, { short_id: "pri-9", into: "pri-1" });
    expect((await byShort(w, "pri-1")).steps.find((s: any) => s.key === "s4")?.title).toBe("Billing");
    await w.t.mutation(pass.applyPlan, {
      user_id: w.ana, workspace: w.team, started_at: Date.now(), from_cursor: 1, cursor_at: 2, model: "m",
      plan: {
        creates: [], sessions: [], unmap: [], notes: [], rewritten: [],
        updates: [{ short_id: "pri-1", seen_steps: p1.steps.map((s: any) => s.key), patch: { steps: [...p1.steps, { key: "s4", title: "Auth", tier: "critical", tier_set_by: "pass", refs: [], done: false }] } }],
        merges: [{ short_id: "pri-7", merged_into: "pri-1", step_keys: { s1: "s4" } }],
      },
    });
    const after = await byShort(w, "pri-1");
    const auth = after.steps.find((s: any) => s.title === "Auth")!;
    expect(auth.key).toBe("s5");
    expect(after.steps.find((s: any) => s.key === "s4")?.title).toBe("Billing");
    expect(await w.conversation(w.oldConv)).toMatchObject({ priority_id: p1._id, priority_step_key: "s5" });
    const shown = await me.query(pri.show, { short_id: "pri-1" });
    expect(shown.corrections.map((c: any) => [c.step_key, c.text])).toContainEqual(["s5", "Auth waits on SSO"]);
  });
});
