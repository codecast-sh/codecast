// The person's overrides and corrections, end to end (priorities.ts writes
// them, priorityPassRun applyPlan holds them): each override is made, then a
// pass runs whose reply tries to undo it, and the override holds. A plan
// written straight to applyPlan shows the hold is in code, not in the prompt.
// A correction reaches the next pass's prompt and turns applied when it
// succeeds.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { H, pass, proposal, stubModel, world } from "./priorityPassRun.testkit";
import { PRIORITY_PASS_CAPS } from "./lib/priorityPass";

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

describe("milestone overrides survive the next pass", () => {
  test("done, rename, tier and drop hold against a reply that undoes each, and a dropped one is not recreated under a near name", async () => {
    const w = await seeded();
    const me = as(w, w.ana);
    await me.mutation(pri.setStepDone, { short_id: "pri-1", step_key: "s1", done: true });
    await me.mutation(pri.renameStep, { short_id: "pri-1", step_key: "s2", title: "Grader live in prod" });
    await me.mutation(pri.setStepTier, { short_id: "pri-1", step_key: "s2", tier: "polish" });
    await me.mutation(pri.dropStep, { short_id: "pri-1", step_key: "s3" });

    await w.send(w.ana, w.teamConv, late(), "grader still flaky");
    model.reply = (prompt) => {
      expect(prompt).toContain("pri-1/s1 [critical] Grader faults under 10% · done (set by the person)");
      expect(prompt).toContain("pri-1/s2 [polish, set by the person] Grader live in prod (title set by the person)");
      expect(prompt).toContain('Dropped by the person (never propose again, under any name): pri-1/s3 "Docs"');
      return JSON.stringify({
        priorities: [proposal({
          short_id: "pri-1",
          steps: [
            { key: "s1", title: "Grader faults under 10%", tier: "critical", refs: [{ kind: "session", id: "jx7team" }], done_judged: false },
            { key: "s2", title: "Ship the grader", tier: "critical", refs: [] },
            { key: "s3", title: "Docs", tier: "polish", refs: [] },
            { title: "Update docs", tier: "polish", refs: [] },
          ],
        })],
        unassigned: [],
      });
    };
    await run(w);

    const after = await byShort(w, "pri-1");
    const s = (key: string) => after.steps.find((x: any) => x.key === key);
    expect(s("s1")).toMatchObject({ done: true, done_set_by: "person" });
    expect(s("s2")).toMatchObject({ title: "Grader live in prod", title_set_by: "person", tier: "polish", tier_set_by: "person" });
    expect(s("s3")).toMatchObject({ title: "Docs", dropped: true });
    expect(after.steps.filter((x: any) => /docs/i.test(x.title))).toHaveLength(1);

    // Reads never show the tombstone; the counts leave it out.
    const shown = await me.query(pri.show, { short_id: "pri-1" });
    expect(shown.steps.map((x: any) => x.key)).toEqual(["s1", "s2"]);
    expect(shown.counts).toEqual({ critical_done: 1, critical_total: 1 });
    await expect(me.mutation(pri.renameStep, { short_id: "pri-1", step_key: "s3", title: "Back" })).rejects.toThrow("pri-1 has no milestone s3; its milestones: s1, s2");
    // A session on the dropped milestone shows the priority's line, not the tombstone's title.
    await w.t.run((ctx) => ctx.db.patch(w.teamConv, { priority_step_key: "s3" }));
    expect(await me.query(pri.pinLine, { conversation_id: w.teamConv })).not.toHaveProperty("step_title");
  });

  test("not done, set by the person, holds even when the step's task closes", async () => {
    const w = await seeded();
    await w.t.run(async (ctx) => {
      await ctx.db.insert("tasks", { user_id: w.ana, team_id: w.acme, workspace: w.team, short_id: "ct-9", title: "Grader", task_type: "task", priority: "medium", source: "human", status: "done", created_from_conversation: w.teamConv, created_at: 1, updated_at: 1 } as any);
      const p = (await ctx.db.query("priorities").collect())[0];
      await ctx.db.patch(p._id, { steps: p.steps.map((s) => (s.key === "s2" ? { ...s, refs: [{ kind: "task" as const, id: "ct-9" }] } : s)) });
    });
    await as(w, w.ana).mutation(pri.setStepDone, { short_id: "pri-1", step_key: "s2", done: false });
    await w.send(w.ana, w.teamConv, late(), "more");
    model.reply = () => JSON.stringify({ priorities: [], unassigned: [] });
    await run(w);
    expect((await byShort(w, "pri-1")).steps.find((x: any) => x.key === "s2")).toMatchObject({ done: false, done_set_by: "person" });
  });
});

describe("priority overrides survive the next pass", () => {
  test("done by the person stays done when the reply says active, and is never merged away", async () => {
    const w = await seeded();
    model.reply = () => JSON.stringify({ priorities: [proposal({ title: "Second", steps: [{ title: "Other", tier: "critical", refs: [] }], sessions: [{ session: "jx7old" }] })], unassigned: [] });
    await w.send(w.ana, w.oldConv, late(), "other work");
    await run(w);
    const row = await as(w, w.ana).mutation(pri.markDone, { short_id: "pri-1" });
    expect(row).toMatchObject({ status: "done", status_set_by: "person", rank: null, person_pos: null, ai_rank: null });

    await w.send(w.ana, w.teamConv, late(), "more grader work");
    model.reply = () => JSON.stringify({ priorities: [proposal({ short_id: "pri-1", status: "active" }), proposal({ short_id: "pri-2", title: "Second", merges: ["pri-1"], steps: [], sessions: [] })], unassigned: [] });
    await run(w);
    expect(await byShort(w, "pri-1")).toMatchObject({ status: "done", status_set_by: "person" });

    // Restoring a done the person set hands the status back to the pass.
    expect(await as(w, w.ana).mutation(pri.restore, { short_id: "pri-1" })).toMatchObject({ status: "active", status_set_by: "pass" });
  });

  test("a merge by the person carries milestones, sessions and corrections, and the pass does not bring it back", async () => {
    const w = await seeded();
    await w.send(w.ana, w.oldConv, late(), "other work");
    model.reply = () => JSON.stringify({ priorities: [proposal({ title: "Second", steps: [{ title: "Other", tier: "critical", refs: [] }], sessions: [{ session: "jx7old", step: "Other" }] })], unassigned: [] });
    await run(w);
    const me = as(w, w.ana);
    await me.mutation(pri.correct, { short_id: "pri-2", step_key: "s1", text: "This is part of the grader work" });
    const into = await me.mutation(pri.merge, { short_id: "pri-2", into: "pri-1" });
    expect(into.steps.map((s: any) => [s.key, s.title])).toEqual([["s1", "Grader faults under 10%"], ["s2", "Ship the grader"], ["s3", "Docs"], ["s4", "Other"]]);
    expect(await w.conversation(w.oldConv)).toMatchObject({ priority_id: into._id, priority_step_key: "s4" });
    expect(await byShort(w, "pri-2")).toMatchObject({ status: "merged", status_set_by: "person", merged_into: into._id });
    const shown = await me.query(pri.show, { short_id: "pri-1" });
    expect(shown.corrections).toMatchObject([{ step_key: "s4", text: "This is part of the grader work", status: "pending" }]);
    expect(await me.query(pri.show, { short_id: "pri-2" })).toBeNull();

    // A pass that read before the merge and still names pri-2 writes nothing to it.
    const counts = await w.t.mutation(pass.applyPlan, {
      user_id: w.ana, workspace: w.team, started_at: Date.now(), from_cursor: 1, cursor_at: 2, model: "m",
      plan: { creates: [], updates: [{ short_id: "pri-2", patch: { status: "active", title: "Back" } }], merges: [], sessions: [{ session: "jx7old", priority: "pri-2", step_key: null }], unmap: [], notes: [], rewritten: [] },
    });
    expect(counts).toMatchObject({ updated: 0, mapped_sessions: 0 });
    expect(await byShort(w, "pri-2")).toMatchObject({ status: "merged", title: "Second" });
    expect((await w.conversation(w.oldConv))?.priority_id).toBe(into._id);
  });
});

describe("a person's merge while a pass reads", () => {
  test("the stale plan keeps the milestones the merge carried in, and its own new step takes the next key", async () => {
    const w = await seeded();
    await w.send(w.ana, w.oldConv, late(), "other work");
    model.reply = () => JSON.stringify({ priorities: [proposal({ title: "Second", steps: [{ title: "Judge rollout", tier: "critical", refs: [] }], sessions: [{ session: "jx7old", step: "Judge rollout" }] })], unassigned: [] });
    await run(w);
    // The pass reads pri-1 as s1..s3; meanwhile the person merges pri-2 into it, which carries its step in as s4.
    const before = await byShort(w, "pri-1");
    await as(w, w.ana).mutation(pri.merge, { short_id: "pri-2", into: "pri-1" });
    const passStep = (key: string, title: string) => ({ key, title, tier: "critical", tier_set_by: "pass", refs: [], done: false });
    await w.t.mutation(pass.applyPlan, {
      user_id: w.ana, workspace: w.team, started_at: Date.now(), from_cursor: 1, cursor_at: 2, model: "m",
      plan: {
        creates: [],
        updates: [{ short_id: "pri-1", seen_steps: before.steps.map((s: any) => s.key), patch: { steps: [...before.steps, passStep("s4", "Fresh work")] } }],
        merges: [], sessions: [{ session: "jx7team", priority: "pri-1", step_key: "s4" }], unmap: [], notes: [], rewritten: [],
      },
    });
    const after = await byShort(w, "pri-1");
    expect(after.steps.map((s: any) => [s.key, s.title])).toEqual([["s1", "Grader faults under 10%"], ["s2", "Ship the grader"], ["s3", "Docs"], ["s5", "Fresh work"], ["s4", "Judge rollout"]]);
    expect(await w.conversation(w.teamConv)).toMatchObject({ priority_step_key: "s5" });
    expect(await w.conversation(w.oldConv)).toMatchObject({ priority_id: after._id, priority_step_key: "s4" });
  });
});

describe("a milestone holding a session the person placed survives the pass", () => {
  test("the person moves a session onto s3; the next plan leaves s3 out; s3 stays with the session on it", async () => {
    const w = await seeded();
    await as(w, w.ana).mutation(pri.moveSession, { session: "jx7old", short_id: "pri-1", step_key: "s3" });
    await w.send(w.ana, w.teamConv, late(), "grader again");
    // The reply keeps s1 and s2 and says nothing of s3.
    model.reply = () => JSON.stringify({ priorities: [proposal({ short_id: "pri-1", steps: steps.slice(0, 2) })], unassigned: [] });
    await run(w);
    const p1 = await byShort(w, "pri-1");
    expect(p1.steps.filter((s: any) => !s.dropped).map((s: any) => s.key)).toEqual(["s1", "s2", "s3"]);
    expect(await w.conversation(w.oldConv)).toMatchObject({ priority_id: p1._id, priority_step_key: "s3", priority_set_by: "person" });

    // A stale plan written straight to applyPlan without s3 is held the same way.
    await w.t.mutation(pass.applyPlan, {
      user_id: w.ana, workspace: w.team, started_at: Date.now(), from_cursor: 1, cursor_at: 2, model: "m",
      plan: { creates: [], updates: [{ short_id: "pri-1", patch: { steps: p1.steps.filter((s: any) => s.key !== "s3") } }], merges: [], sessions: [], unmap: [], notes: [], rewritten: [] },
    });
    expect((await byShort(w, "pri-1")).steps.map((s: any) => s.key)).toContain("s3");
    expect((await w.conversation(w.oldConv))?.priority_step_key).toBe("s3");
  });
});

describe("session overrides survive the next pass", () => {
  test("a session the person moved stays; one they said is not this never goes back there", async () => {
    const w = await seeded();
    await w.send(w.ana, w.oldConv, late(), "other work");
    model.reply = () => JSON.stringify({ priorities: [proposal({ title: "Second", steps: [{ title: "Other", tier: "critical", refs: [] }], sessions: [{ session: "jx7old" }] })], unassigned: [] });
    await run(w);
    const me = as(w, w.ana);
    const p1 = await byShort(w, "pri-1");
    const p2 = await byShort(w, "pri-2");

    // jx7team moves from pri-1 to pri-2's s1; jx7old is "not this" for pri-2.
    await me.mutation(pri.moveSession, { session: "jx7team", short_id: "pri-2", step_key: "s1" });
    await me.mutation(pri.sessionNotThis, { session: "jx7old" });
    expect(await w.conversation(w.teamConv)).toMatchObject({ priority_id: p2._id, priority_step_key: "s1", priority_set_by: "person" });
    const old = await w.conversation(w.oldConv);
    expect(old?.priority_id).toBeUndefined();
    expect(old?.priority_not).toEqual([p2._id]);
    expect(await byShort(w, "pri-1")).toMatchObject({ session_count: 0 });

    await w.send(w.ana, w.teamConv, late(), "grader again");
    await w.send(w.ana, w.oldConv, late(), "other again");
    model.reply = (prompt) => {
      expect(prompt).toContain("Placed by the person on pri-2/s1: it stays there.");
      expect(prompt).toContain("Not part of pri-2 (the person said).");
      return JSON.stringify({
        priorities: [
          proposal({ short_id: "pri-1", sessions: [{ session: "jx7team", step: "s1" }] }),
          proposal({ short_id: "pri-2", title: "Second", steps: [{ key: "s1", title: "Other", tier: "critical", refs: [] }], sessions: [{ session: "jx7old", step: "s1" }] }),
        ],
        unassigned: [],
      });
    };
    await run(w);
    expect(await w.conversation(w.teamConv)).toMatchObject({ priority_id: p2._id, priority_step_key: "s1", priority_set_by: "person" });
    expect((await w.conversation(w.oldConv))?.priority_id).toBeUndefined();

    // Another priority may still take the not-this session.
    model.reply = () => JSON.stringify({ priorities: [proposal({ short_id: "pri-1", sessions: [{ session: "jx7old", step: "s1" }] })], unassigned: [{ session: "jx7team", kind: "one_off" }] });
    await w.send(w.ana, w.oldConv, late(), "now it is grader work");
    await run(w);
    expect((await w.conversation(w.oldConv))?.priority_id).toBe(p1._id);
    expect((await w.conversation(w.teamConv))?.priority_id).toBe(p2._id);

    // Someone else's session is refused.
    await expect(me.mutation(pri.moveSession, { session: "jx7ben", short_id: "pri-1" })).rejects.toThrow("no session jx7ben of yours");
  });

  test("applyPlan refuses every change to what the person set, whatever the plan says", async () => {
    const w = await seeded();
    const me = as(w, w.ana);
    await me.mutation(pri.setStepDone, { short_id: "pri-1", step_key: "s1", done: true });
    await me.mutation(pri.renameStep, { short_id: "pri-1", step_key: "s2", title: "Mine" });
    await me.mutation(pri.dropStep, { short_id: "pri-1", step_key: "s3" });
    await me.mutation(pri.moveSession, { session: "jx7team", short_id: "pri-1", step_key: "s2" });
    await me.mutation(pri.markDone, { short_id: "pri-1" });
    const before = await byShort(w, "pri-1");

    const pass_step = (key: string, title: string) => ({ key, title, tier: "critical", tier_set_by: "pass", refs: [], done: false });
    await w.t.mutation(pass.applyPlan, {
      user_id: w.ana, workspace: w.team, started_at: Date.now(), from_cursor: 1, cursor_at: 2, model: "m",
      plan: {
        creates: [],
        updates: [{ short_id: "pri-1", patch: { status: "active", ai_rank: 1, steps: [pass_step("s1", "Grader faults under 10%"), pass_step("s2", "Theirs"), pass_step("s3", "Docs"), pass_step("s4", "Docs") ] } }],
        merges: [], sessions: [{ session: "jx7team", priority: "pri-1", step_key: "s1" }], unmap: ["jx7team"], notes: [], rewritten: [],
      },
    });
    const after = await byShort(w, "pri-1");
    expect(after.status).toBe("done");
    expect(after.ai_rank).toBeUndefined();
    expect(after.steps).toEqual([
      { ...pass_step("s1", "Grader faults under 10%"), done: true, done_at: before.steps[0].done_at, done_set_by: "person" },
      { ...pass_step("s2", "Mine"), title_set_by: "person" },
      before.steps[2],
    ]);
    expect(await w.conversation(w.teamConv)).toMatchObject({ priority_step_key: "s2", priority_set_by: "person" });
  });
});

describe("corrections", () => {
  test("a correction shows pending, reaches the next pass's prompt, turns applied when it succeeds, and stays in every later prompt until deleted", async () => {
    const w = await seeded();
    const me = as(w, w.ana);
    const c = await me.mutation(pri.correct, { short_id: "pri-1", step_key: "s2", text: "The grader shipped last week; this is about the judge" });
    expect(c).toMatchObject({ step_key: "s2", status: "pending" });
    const list = await me.query(pri.list, { workspace: w.team });
    expect(list.priorities[0].correction_pending).toBe(true);
    // A teammate never sees the owner's corrections.
    expect((await as(w, w.ben).query(pri.show, { short_id: "pri-1" }))?.corrections ?? []).toEqual([]);

    // Nothing touched since the last pass: the pending correction is work enough.
    const read = await w.t.query(pass.passInputs, { user_id: w.ana, workspace: w.team });
    expect(read.input.corrections).toMatchObject([{ priority: "pri-1", step_key: "s2", text: "The grader shipped last week; this is about the judge" }]);
    expect(read.corrections).toHaveLength(1);
    model.reply = () => JSON.stringify({ priorities: [], unassigned: [] });
    await run(w);
    expect(model.prompts.at(-1)).toContain("# Corrections the person wrote (follow every one)");
    expect(model.prompts.at(-1)).toContain("on pri-1/s2: The grader shipped last week; this is about the judge");

    const shown = await me.query(pri.show, { short_id: "pri-1" });
    expect(shown.corrections).toMatchObject([{ _id: c._id, status: "applied" }]);
    expect(shown.correction_pending).toBe(false);
    // Applied, it no longer makes work on its own…
    expect((await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).status).toBe("skipped");
    // …but every later pass still reads it.
    await w.send(w.ana, w.teamConv, late(), "judge work");
    await run(w);
    expect(model.prompts.at(-1)).toContain("this is about the judge");

    await me.mutation(pri.deleteCorrection, { correction_id: c._id });
    await w.send(w.ana, w.teamConv, late(), "judge work again");
    await run(w);
    expect(model.prompts.at(-1)).not.toContain("this is about the judge");
  });

  test("a correction is frozen with the priority as the person saw it, and exported as an eval case once a pass applied it, with that pass's window", async () => {
    const w = await seeded();
    const exportCases = (internal as any).priorities.exportCases;
    const c = await as(w, w.ana).mutation(pri.correct, { short_id: "pri-1", text: "Two priorities in one" });
    expect((await w.t.query(exportCases, {})).cases).toEqual([]);
    const cursor = (await w.latestRun())!.cursor_at;
    model.reply = () => JSON.stringify({ priorities: [proposal({ short_id: "pri-1", title: "Grader evals", steps })], unassigned: [] });
    await run(w);
    const { cases } = await w.t.query(exportCases, {});
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ id: c._id, text: "Two priorities in one", window: { from: cursor }, before: { short_id: "pri-1", title: "Trusted evals" }, after: { title: "Grader evals" } });
    expect(cases[0].window.to).toBeGreaterThanOrEqual(cursor);
    expect((await w.t.query(exportCases, { since: cases[0].applied_at })).cases).toEqual([]);
  });

  test("corrections past the newest the prompt holds turn applied too, superseded, and stop putting the pair in the sweep", async () => {
    const w = await seeded();
    const n = PRIORITY_PASS_CAPS.corrections + 5;
    const pri1 = (await w.priorities()).find((p: any) => p.short_id === "pri-1")!;
    await w.t.run(async (ctx) => {
      for (let i = 0; i < n; i++) {
        await ctx.db.insert("priority_corrections", {
          user_id: w.ana, workspace: w.team, priority_id: pri1._id, text: `fix ${i}`, status: "pending", created_at: Date.now() - (n - i) * 1000,
          snapshot: { short_id: "pri-1", title: "Trusted evals", summary: "", status: "active", steps: [] },
        } as any);
      }
    });
    const read = await w.t.query(pass.passInputs, { user_id: w.ana, workspace: w.team });
    expect(read.input.corrections).toHaveLength(PRIORITY_PASS_CAPS.corrections);
    expect(read.input.corrections[0].text).toBe("fix 5");
    expect(read.corrections).toHaveLength(n);
    model.reply = () => JSON.stringify({ priorities: [], unassigned: [] });
    await run(w);
    const statuses = await w.t.run(async (ctx) => (await ctx.db.query("priority_corrections").collect()).map((c) => c.status));
    expect(statuses.filter((s) => s !== "applied")).toEqual([]);
    expect(await w.t.query(pass.sweepCandidates, { team_id: w.acme })).not.toContainEqual({ user_id: w.ana, workspace: w.team });
  });

  test("a delete sent before the server acknowledged the correction finds it by its client key and wins; another person's key finds nothing", async () => {
    const w = await seeded();
    const me = as(w, w.ana);
    // The outbox sends the create, then the delete with the id the web painted.
    await me.mutation(pri.correct, { short_id: "pri-1", text: "Wrong milestone", client_key: "ck-1" });
    await expect(as(w, w.ben).mutation(pri.deleteCorrection, { correction_id: "local-correction-ck-1" })).rejects.toThrow("no correction local-correction-ck-1 of yours");
    await me.mutation(pri.deleteCorrection, { correction_id: "local-correction-ck-1" });
    expect(await w.t.run((ctx) => ctx.db.query("priority_corrections").collect())).toEqual([]);
  });

  test("a pending correction alone puts the pair in the sweep", async () => {
    const w = await seeded();
    expect(await w.t.query(pass.sweepCandidates, { team_id: w.acme })).not.toContainEqual({ user_id: w.ana, workspace: w.team });
    await as(w, w.ana).mutation(pri.correct, { short_id: "pri-1", text: "x" });
    expect(await w.t.query(pass.sweepCandidates, { team_id: w.acme })).toContainEqual({ user_id: w.ana, workspace: w.team });
  });

  test("a merge by the pass takes the absorbed priority's corrections to the survivor, onto the step their step became", async () => {
    const w = await seeded();
    await w.send(w.ana, w.oldConv, late(), "other work");
    model.reply = () => JSON.stringify({ priorities: [proposal({ title: "Second", steps: [{ title: "Judge rollout", tier: "critical", refs: [] }], sessions: [{ session: "jx7old", step: "Judge rollout" }] })], unassigned: [] });
    await run(w);
    const me = as(w, w.ana);
    await me.mutation(pri.correct, { short_id: "pri-2", step_key: "s1", text: "Rollout waits on the grader" });
    await me.mutation(pri.correct, { short_id: "pri-2", text: "Same thing as the grader work" });

    await w.send(w.ana, w.oldConv, late(), "one priority after all");
    model.reply = () => JSON.stringify({ priorities: [proposal({ short_id: "pri-1", merges: ["pri-2"], steps: [...steps, { key: "pri-2/s1", title: "Judge rollout", tier: "critical", refs: [] }] })], unassigned: [] });
    await run(w);
    expect(await byShort(w, "pri-2")).toMatchObject({ status: "merged" });
    const shown = await me.query(pri.show, { short_id: "pri-1" });
    expect(shown.steps.map((s: any) => [s.key, s.title])).toContainEqual(["s4", "Judge rollout"]);
    expect(shown.corrections.map((c: any) => [c.step_key, c.text]).sort()).toEqual([[null, "Same thing as the grader work"], ["s4", "Rollout waits on the grader"]]);
  });

  test("calibration never reads the person's corrections or placements", async () => {
    const w = await seeded();
    await as(w, w.ana).mutation(pri.correct, { short_id: "pri-1", text: "a real correction" });
    await as(w, w.ana).mutation(pri.moveSession, { session: "jx7team", short_id: "pri-1", step_key: "s2" });
    model.prompts.length = 0;
    await w.t.action(pass.evalPass, { user_id: w.ana, workspace: w.team, window_start: w.now - 4 * H, window_end: w.now });
    expect(model.prompts).toHaveLength(1);
    expect(model.prompts[0]).not.toContain("a real correction");
    expect(model.prompts[0]).not.toContain("Placed by the person");
  });

  test("only the owner corrects their priority or deletes a correction", async () => {
    const w = await seeded();
    const c = await as(w, w.ana).mutation(pri.correct, { short_id: "pri-1", text: "x" });
    await expect(as(w, w.ben).mutation(pri.correct, { short_id: "pri-1", text: "y" })).rejects.toThrow();
    await expect(as(w, w.ben).mutation(pri.deleteCorrection, { correction_id: c._id })).rejects.toThrow(`no correction ${c._id} of yours`);
    await expect(as(w, w.ana).mutation(pri.correct, { short_id: "pri-1", text: "  " })).rejects.toThrow("a correction is 1 to 2000 characters");
  });
});
