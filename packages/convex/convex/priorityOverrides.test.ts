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

describe("past 500 sessions on one priority", () => {
  test("a drop, the pass's merge and the person's merge each reach every session", async () => {
    const w = await seeded();
    const p1 = await byShort(w, "pri-1");
    const make = (priority: Id<"priorities">, n: number, step?: string) => w.t.run(async (ctx) => {
      for (let i = 0; i < n; i++) {
        await ctx.db.insert("conversations", {
          user_id: w.ana, agent_type: "claude_code", session_id: `jx7m${priority}${i}`, team_id: w.acme, is_private: false, team_visibility: "full",
          started_at: 1, updated_at: 1, message_count: 1, status: "active", priority_id: priority, ...(step ? { priority_step_key: step } : {}),
        } as any);
      }
    });
    const on = (priority: Id<"priorities">, step?: string) => w.t.run(async (ctx) => (await ctx.db.query("conversations").withIndex("by_priority", (q) => q.eq("priority_id", priority)).collect()).filter((c) => step === undefined || c.priority_step_key === step).length);
    await make(p1._id, 510, "s3");
    await as(w, w.ana).mutation(pri.dropStep, { short_id: "pri-1", step_key: "s3" });
    expect(await on(p1._id, "s3")).toBe(0);
    const priority = (short_id: string) => w.t.run((ctx) => ctx.db.insert("priorities", {
      user_id: w.ana, workspace: w.team, short_id, title: short_id, summary: "", status: "active", ai_rank: 5, steps: [], first_seen_at: 1, last_active_at: 1, pass_at: 1, created_at: 1, updated_at: 1,
    } as any));
    const p8 = await priority("pri-8");
    await make(p8, 505);
    await w.t.mutation(pass.applyPlan, {
      user_id: w.ana, workspace: w.team, started_at: Date.now(), from_cursor: 1, cursor_at: 2, model: "m",
      plan: { creates: [], updates: [], merges: [{ short_id: "pri-8", merged_into: "pri-1", step_keys: {} }], sessions: [], unmap: [], notes: [], rewritten: [] },
    });
    expect(await on(p8)).toBe(0);
    const p9 = await priority("pri-9");
    await make(p9, 505);
    await as(w, w.ana).mutation(pri.merge, { short_id: "pri-9", into: "pri-1" });
    expect(await on(p9)).toBe(0);
  }, 120_000);
});

describe("milestone keys from before the mark", () => {
  test("a priority with no mark takes it from its milestones and its sessions' keys the first time it is written; a new key past a session's old one", async () => {
    const w = await seeded();
    const p1 = await byShort(w, "pri-1");
    // Written before the mark: a session still holds s5, from a milestone since removed.
    await w.t.run(async (ctx) => {
      await ctx.db.patch(p1._id, { step_key_max: undefined } as any);
      await ctx.db.patch(w.oldConv, { priority_id: p1._id, priority_step_key: "s5" } as any);
    });
    const fresh = { key: "s5", title: "Grader in CI", tier: "critical", tier_set_by: "pass", refs: [], done: false };
    await w.t.mutation(pass.applyPlan, {
      user_id: w.ana, workspace: w.team, started_at: Date.now(), from_cursor: 1, cursor_at: 2, model: "m",
      plan: { creates: [], updates: [{ short_id: "pri-1", seen_steps: p1.steps.map((s: any) => s.key), patch: { steps: [...p1.steps, fresh] } }], merges: [], sessions: [{ session: "jx7team", priority: "pri-1", step_key: "s5" }], unmap: [], notes: [], rewritten: [] },
    });
    const after = await byShort(w, "pri-1");
    expect(after.steps.find((s: any) => s.title === "Grader in CI")?.key).toBe("s6");
    expect(after.step_key_max).toBe(6);
    // The session the plan put on the new milestone follows its new key.
    expect((await w.conversation(w.teamConv))?.priority_step_key).toBe("s6");
  });

  test("a plan that removes a milestone clears it from every session on it, and a dangling key on a pass-mapped one", async () => {
    const w = await seeded();
    const p1 = await byShort(w, "pri-1");
    await w.t.run(async (ctx) => {
      await ctx.db.patch(w.teamConv, { priority_id: p1._id, priority_step_key: "s2", priority_set_by: undefined } as any);
      await ctx.db.patch(w.oldConv, { priority_id: p1._id, priority_step_key: "s9", priority_set_by: undefined } as any);
    });
    await w.t.mutation(pass.applyPlan, {
      user_id: w.ana, workspace: w.team, started_at: Date.now(), from_cursor: 1, cursor_at: 2, model: "m",
      plan: { creates: [], updates: [{ short_id: "pri-1", patch: { steps: p1.steps.filter((s: any) => s.key !== "s2") } }], merges: [], sessions: [], unmap: [], notes: [], rewritten: [] },
    });
    for (const id of [w.teamConv, w.oldConv]) {
      const conv = await w.conversation(id);
      expect(conv?.priority_id).toBe(p1._id);
      expect(conv?.priority_step_key).toBeUndefined();
    }
  });
});

describe("milestone keys are never reused", () => {
  test("the pass removes s3; its next new milestone is s4, not s3 again", async () => {
    const w = await seeded();
    await w.send(w.ana, w.teamConv, late(), "grader again");
    model.reply = () => JSON.stringify({ priorities: [proposal({ short_id: "pri-1", steps: steps.slice(0, 2) })], unassigned: [] });
    await run(w);
    const after = await byShort(w, "pri-1");
    expect([after.steps.map((s: any) => s.key), after.step_key_max]).toEqual([["s1", "s2"], 3]);
    await w.send(w.ana, w.teamConv, late(), "grader in CI");
    model.reply = () => JSON.stringify({ priorities: [proposal({ short_id: "pri-1", steps: [...steps.slice(0, 2), { title: "Grader in CI", tier: "critical", refs: [] }] })], unassigned: [] });
    await run(w);
    const latest = await byShort(w, "pri-1");
    expect(latest.steps.map((s: any) => [s.key, s.title])).toEqual([["s1", steps[0].title], ["s2", steps[1].title], ["s4", "Grader in CI"]]);
    expect(latest.step_key_max).toBe(4);
  });
});

describe("a pass merge keeps a placed session's milestone", () => {
  test("the person places a session on pri-2/s1 \"Ship the auth rewrite\"; the pass merges pri-2 into pri-1 without repeating it; the session lands on the survivor's carried milestone", async () => {
    const w = await seeded();
    await w.send(w.ana, w.oldConv, late(), "auth rewrite");
    model.reply = () => JSON.stringify({ priorities: [proposal({ title: "Auth", steps: [{ title: "Ship the auth rewrite", tier: "critical", refs: [] }], sessions: [] })], unassigned: [] });
    await run(w);
    await as(w, w.ana).mutation(pri.moveSession, { session: "jx7old", short_id: "pri-2", step_key: "s1" });

    await w.send(w.ana, w.teamConv, late(), "grader and auth together");
    model.reply = () => JSON.stringify({ priorities: [proposal({ short_id: "pri-1", steps, merges: ["pri-2"] })], unassigned: [] });
    await run(w);
    expect(await byShort(w, "pri-2")).toMatchObject({ status: "merged" });
    const survivor = await byShort(w, "pri-1");
    const carried = survivor.steps.find((s: any) => s.title === "Ship the auth rewrite" && !s.dropped);
    expect(carried).toBeDefined();
    expect(await w.conversation(w.oldConv)).toMatchObject({ priority_id: survivor._id, priority_step_key: carried.key, priority_set_by: "person" });
  });
});

describe("a pass merge carries the absorbed priority's drops as they are now", () => {
  test("a milestone the person drops after the plan's input was read is still a tombstone on the survivor", async () => {
    const w = await seeded();
    await w.t.run((ctx) => ctx.db.insert("priorities", {
      user_id: w.ana, workspace: w.team, short_id: "pri-2", title: "Auth", summary: "", status: "active", ai_rank: 2,
      steps: [{ key: "s1", title: "Auth rewrite", tier: "critical", tier_set_by: "pass", refs: [], done: false }],
      first_seen_at: 1, last_active_at: 1, pass_at: 1, created_at: 1, updated_at: 1, session_count: 0,
    } as any));
    // The plan was made while pri-2/s1 was live; the person drops it before it lands.
    await as(w, w.ana).mutation(pri.dropStep, { short_id: "pri-2", step_key: "s1" });
    await w.t.mutation(pass.applyPlan, {
      user_id: w.ana, workspace: w.team, started_at: Date.now(), from_cursor: 1, cursor_at: 2, model: "m",
      plan: { creates: [], updates: [], merges: [{ short_id: "pri-2", merged_into: "pri-1", step_keys: {} }], sessions: [], unmap: [], notes: [], rewritten: [] },
    });
    const survivor = await byShort(w, "pri-1");
    expect(survivor.steps.filter((s: any) => s.dropped).map((s: any) => [s.key, s.title])).toEqual([["s4", "Auth rewrite"]]);
    // Its key is spent like any other.
    expect(survivor.step_key_max).toBe(4);
  });
});

describe("a pass merge reads the absorbed priority's sessions itself", () => {
  test("a placed session older than the newest eight the plan saw keeps its milestone: the survivor gains it", async () => {
    const w = await seeded();
    const pri2 = await w.t.run(async (ctx) => {
      const id = await ctx.db.insert("priorities", {
        user_id: w.ana, workspace: w.team, short_id: "pri-2", title: "Auth", summary: "", status: "active", ai_rank: 2,
        steps: [{ key: "s1", title: "Auth rewrite", tier: "critical", tier_set_by: "pass", refs: [], done: false }],
        first_seen_at: 1, last_active_at: 1, pass_at: 1, created_at: 1, updated_at: 1, session_count: 10,
      } as any);
      for (let i = 0; i < 10; i++) {
        await ctx.db.insert("conversations", {
          user_id: w.ana, agent_type: "claude_code", session_id: `jx7a${i}`, short_id: `jx7a${i}`, title: `a${i}`, team_id: w.acme, is_private: false, team_visibility: "full",
          started_at: 1, updated_at: 1 + i, message_count: 3, status: "active", priority_id: id, ...(i === 0 ? { priority_step_key: "s1", priority_set_by: "person" } : {}),
        } as any);
      }
      return id;
    });
    // The plan saw the newest eight, none on s1: it maps no step.
    await w.t.mutation(pass.applyPlan, {
      user_id: w.ana, workspace: w.team, started_at: Date.now(), from_cursor: 1, cursor_at: 2, model: "m",
      plan: { creates: [], updates: [], merges: [{ short_id: "pri-2", merged_into: "pri-1", step_keys: {} }], sessions: [], unmap: [], notes: [], rewritten: [] },
    });
    const survivor = await byShort(w, "pri-1");
    const carried = survivor.steps.find((s: any) => s.title === "Auth rewrite");
    expect([carried?.key, !!carried?.dropped]).toEqual(["s4", false]);
    const placed = await w.t.run(async (ctx) => (await ctx.db.query("conversations").withIndex("by_short_id", (q) => q.eq("short_id", "jx7a0")).first())!);
    expect(placed).toMatchObject({ priority_id: survivor._id, priority_step_key: "s4", priority_set_by: "person" });
    void pri2;
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
      // The person's done keeps its refs too: the plan's would hand its state back to them.
      { ...pass_step("s1", "Grader faults under 10%"), refs: before.steps[0].refs, done: true, done_at: before.steps[0].done_at, done_set_by: "person" },
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
    expect([read.corrections.length, read.superseded.length]).toEqual([PRIORITY_PASS_CAPS.corrections, 5]);
    model.reply = () => JSON.stringify({ priorities: [], unassigned: [] });
    await run(w);
    const rows = await w.t.run(async (ctx) => (await ctx.db.query("priority_corrections").collect()).sort((a, b) => a.created_at - b.created_at));
    expect(rows.filter((c) => c.status !== "applied")).toEqual([]);
    // The five no prompt held are marked superseded, and only the ones a pass read are eval cases.
    expect(rows.map((c) => !!c.superseded)).toEqual(rows.map((_, i) => i < 5));
    const cases = (await w.t.query((internal as any).priorities.exportCases, {})).cases;
    expect(cases.map((c: any) => c.text).sort()).toEqual(rows.slice(5).map((c) => c.text).sort());
    expect(await w.t.query(pass.sweepCandidates, { team_id: w.acme })).not.toContainEqual({ user_id: w.ana, workspace: w.team });
  });

  test("a delete sent before the server acknowledged the correction finds it by its client key and wins; another person's key finds nothing", async () => {
    const w = await seeded();
    const me = as(w, w.ana);
    // The outbox sends the create, then the delete with the id the web painted.
    await me.mutation(pri.correct, { short_id: "pri-1", text: "Wrong milestone", client_key: "ck-1" });
    await expect(as(w, w.ben).mutation(pri.deleteCorrection, { correction_id: "local-correction-ck-1" })).rejects.toThrow("no correction local-correction-ck-1 of yours");
    await me.mutation(pri.deleteCorrection, { correction_id: "local-correction-ck-1" });
    expect((await w.t.run((ctx) => ctx.db.query("priority_corrections").collect())).map((c) => !!c.deleted_at)).toEqual([true]);
    expect((await me.query(pri.show, { short_id: "pri-1" })).corrections).toEqual([]);
  });

  test("a deleted correction is gone from the page, the pending mark, the sweep, the pass and the eval export, applied or not", async () => {
    const w = await seeded();
    const me = as(w, w.ana);
    const exportCases = (internal as any).priorities.exportCases;
    const applied = await me.mutation(pri.correct, { short_id: "pri-1", text: "Two priorities in one" });
    model.reply = () => JSON.stringify({ priorities: [], unassigned: [] });
    await run(w);
    const waiting = await me.mutation(pri.correct, { short_id: "pri-1", step_key: "s2", text: "Not the grader" });
    for (const c of [applied, waiting]) await me.mutation(pri.deleteCorrection, { correction_id: c._id });
    const shown = await me.query(pri.show, { short_id: "pri-1" });
    expect([shown.corrections, shown.correction_pending]).toEqual([[], false]);
    expect((await me.query(pri.list, { workspace: w.team })).priorities[0].correction_pending).toBe(false);
    expect(await w.t.query(pass.sweepCandidates, { team_id: w.acme })).not.toContainEqual({ user_id: w.ana, workspace: w.team });
    const read = await w.t.query(pass.passInputs, { user_id: w.ana, workspace: w.team });
    expect([read.input.corrections, read.corrections]).toEqual([[], []]);
    expect((await w.t.query(exportCases, {})).cases).toEqual([]);
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
