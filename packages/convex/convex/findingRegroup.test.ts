// Findings grouping could not compare when they came in (findingRegroup.ts):
// held for the sweep, and the pass that folds the problems they opened before.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { api, internal } from "./_generated/api";
import { JUDGE, T0, setup, stubs, vec } from "./moments.testkit";

describe("grouping refused", () => {
  const s = stubs();
  beforeEach(() => s.install());
  afterEach(() => s.restore());

  // Oct 26: Union's budget refused grouping for eight hours, and each finding filed in that time opened a problem of its own.
  test("a finding grouping could not compare waits held, and the sweep places it once it can", async () => {
    const { t, scope, post, due, claim, complete } = await setup();
    await t.mutation(api.moments.publish, { ...scope, source: "app", device_id: "host-1", root: "/repo", extractors: [{ kind: "conversation", path: ".codecast/moments/conversation.ts", version: "b".repeat(40), quiet_ms: 0, timeout_ms: 30_000 }], judges: [JUDGE] });
    await t.mutation(api.modelCalls.budgetForCli, { ...scope, set_usd: 5 });
    await post([{ type: "moment", kind: "conversation", subject: "t_1", at: T0 }]);
    await due();
    const [c] = await claim();
    s.state.judge = '{"deviations": [{"expectation": "ex-aq-1", "severity": 7, "what_happened": "A broker waited two days for a reply.", "quote": "Can we talk Tuesday?", "markers": []}]}';
    s.state.embedFail = 1;
    await complete(c.moment, "t_1");
    const finding = async () => (await t.run((ctx) => ctx.db.query("signals").collect()))[0]!;
    const held = await finding();
    expect(held).toMatchObject({ attach: "held" });
    expect(held.task_id).toBeUndefined();
    expect(held.awaiting_grouping?.text).toBeTruthy();
    expect(await t.run((ctx) => ctx.db.query("tasks").collect())).toHaveLength(0);

    // Nothing to compare against yet still waits; once an embedding comes back it opens its own problem, words kept.
    s.state.embedFail = 1;
    expect(await t.action(internal.findingRegroup.groupAwaiting, {})).toEqual({ placed: 0, waiting: true });
    s.state.vectors.push(vec(12));
    expect(await t.action(internal.findingRegroup.groupAwaiting, {})).toEqual({ placed: 1, waiting: false });
    const placed = await finding();
    expect(placed.awaiting_grouping).toBeUndefined();
    expect(placed.task_id).toBeDefined();
    expect((await t.run((ctx) => ctx.db.query("signal_vectors").collect())).map((r) => r.signal_id)).toEqual([placed._id]);
  }, 120_000);

  test("the re-group pass folds a problem a refused finding opened alone into the problem it reads like", async () => {
    const { t, ids, scope, post, due, claim, complete } = await setup();
    await t.mutation(api.moments.publish, { ...scope, source: "app", device_id: "host-1", root: "/repo", extractors: [{ kind: "conversation", path: ".codecast/moments/conversation.ts", version: "b".repeat(40), quiet_ms: 0, timeout_ms: 30_000 }], judges: [JUDGE] });
    await t.mutation(api.modelCalls.budgetForCli, { ...scope, set_usd: 5 });
    await post([{ type: "moment", kind: "conversation", subject: "t_1", at: T0 }]);
    await due();
    const [c] = await claim();
    s.state.judge = '{"deviations": [{"expectation": "ex-aq-1", "severity": 7, "what_happened": "A broker waited two days for a reply.", "quote": "Can we talk Tuesday?", "markers": []}]}';
    s.state.vectors.push(vec(12));
    await complete(c.moment, "t_1");
    // What filing did with a refused finding before: a problem of its own, and no words kept to compare.
    const made = await t.run(async (ctx) => {
      const a = (await ctx.db.query("signals").collect())[0]!;
      const { _id: _t, _creationTime: _tc, ...task } = (await ctx.db.get(a.task_id!)) as any;
      const alone = await ctx.db.insert("tasks", { ...task, short_id: "ct-900", title: "A broker waited again", created_at: a.created_at + 1 });
      const { _id: _s, _creationTime: _sc, ...row } = a as any;
      const b = await ctx.db.insert("signals", { ...row, short_id: "sg-900", fingerprint: "k-900", task_id: alone, created_at: a.created_at + 1 });
      return { a: a._id, home: a.task_id!, alone, b };
    });
    s.state.vectors.push(vec(12));
    const out = await t.action(internal.findingRegroup.regroupRefused, { workspace: ids.workspace, source: "judge:comms", since: 0, until: Date.now() + 1, dry_run: false });
    expect(out).toMatchObject({ compared: 1, folded: 1, kept: 0, already: 1 });
    const b = (await t.run((ctx) => ctx.db.get(made.b)))!;
    expect(String(b.task_id)).toBe(String(made.home));
    expect((await t.run((ctx) => ctx.db.get(made.alone)))!.status).not.toBe("open");
    expect((await t.run((ctx) => ctx.db.query("signal_vectors").collect())).map((r) => String(r.signal_id)).sort()).toEqual([String(made.a), String(made.b)].sort());
  }, 120_000);
});
