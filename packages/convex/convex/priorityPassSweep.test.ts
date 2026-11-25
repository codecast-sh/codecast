// The priorities sweep and what a pass keeps true about the sessions a
// priority holds (priorityPassSweep.ts, priorityPassRun.ts): session counts,
// sessions that leave the workspace, and which pairs a team's sweep runs.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Id } from "./_generated/dataModel";
import { api, internal } from "./_generated/api";
import type { MergePlan } from "./lib/priorityPass";
import { SWEEP_EVERY_MS, SWEEP_STRAY_BUDGET, SWEEP_TEAMS_PAGE } from "./priorityPassSweep";
import { DAY, H, pass, proposal, stubModel, world } from "./priorityPassRun.testkit";

setDefaultTimeout(60_000);

const model = stubModel();

describe("session counts", () => {
  test("a pass keeps each priority's session count, a merge moves the loser's unlisted sessions to the survivor, and a priority with no count is counted once", async () => {
    const w = await world();
    await w.send(w.ana, w.teamConv, w.now - H, "work");
    model.reply = () => JSON.stringify({ priorities: [proposal()], unassigned: [] });
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    const [a] = await w.priorities();
    expect(a.session_count).toBe(1);

    // A second priority from before counts were kept, holding the old session.
    const b = await w.t.run(async (ctx) => {
      const id = await ctx.db.insert("priorities", { user_id: w.ana, workspace: w.team, short_id: "pri-90", title: "Old", summary: "", status: "active", rank: 2, rank_set_by: "pass", steps: [], first_seen_at: 1, last_active_at: 1, pass_at: 1, created_at: 1, updated_at: 1 });
      await ctx.db.patch(w.oldConv, { priority_id: id, priority_step_key: "s1" });
      return id;
    });
    const plan: MergePlan = { creates: [], updates: [], merges: [{ short_id: "pri-90", merged_into: a.short_id }], sessions: [], unmap: [], notes: [], rewritten: [] };
    await w.t.mutation(pass.applyPlan, { user_id: w.ana, workspace: w.team, started_at: Date.now(), from_cursor: 1, cursor_at: 1, model: "m", plan });
    const after = await w.t.run(async (ctx) => ({ a: await ctx.db.get(a._id), b: await ctx.db.get(b), old: await ctx.db.get(w.oldConv) }));
    expect(after.old).toMatchObject({ priority_id: a._id });
    expect(after.old?.priority_step_key).toBeUndefined();
    expect(after.a?.session_count).toBe(2);
    expect(after.b).toMatchObject({ status: "merged", session_count: 0 });

    // Unmapping a session counts down.
    await w.t.mutation(pass.applyPlan, { user_id: w.ana, workspace: w.team, started_at: Date.now() + 1, from_cursor: 1, cursor_at: 1, model: "m", plan: { creates: [], updates: [], merges: [], sessions: [], unmap: ["jx7old"], notes: [], rewritten: [] } });
    expect((await w.t.run((ctx) => ctx.db.get(a._id)))?.session_count).toBe(1);
  });

  test("a session made private lets go of its team priority: the team pass unmaps it and the team count drops", async () => {
    const w = await world();
    await w.send(w.ana, w.teamConv, w.now - 2 * H, "work");
    model.reply = () => JSON.stringify({ priorities: [proposal()], unassigned: [] });
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    const [p] = await w.priorities();
    expect(p.session_count).toBe(1);
    await w.t.run((ctx) => ctx.db.patch(w.teamConv, { is_private: true, team_visibility: "private" }));
    // The next team pass, for other team work, finds the session gone from the team.
    await w.send(w.ana, w.oldConv, w.now - 8 * 60_000, "other team work");
    model.reply = () => JSON.stringify({ priorities: [], unassigned: [] });
    expect((await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).status).toBe("ok");
    expect((await w.conversation(w.teamConv))?.priority_id).toBeUndefined();
    expect((await w.t.run((ctx) => ctx.db.get(p._id)))?.session_count).toBe(0);
  });

  test("an auto-shared session later locked private leaves the team pass and reads as personal work", async () => {
    const w = await world();
    await w.t.run((ctx) => ctx.db.patch(w.teamConv, { auto_shared: true }));
    await w.send(w.ana, w.teamConv, w.now - 2 * H, "work");
    model.reply = () => JSON.stringify({ priorities: [proposal()], unassigned: [] });
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    const [p] = await w.priorities();
    expect((await w.conversation(w.teamConv))?.priority_id).toBe(p._id);
    // Locked private: the policy team (auto_shared) still names Acme, but the team may not read it.
    await w.t.run((ctx) => ctx.db.patch(w.teamConv, { is_private: true, team_visibility: "private" }));
    await w.send(w.ana, w.teamConv, w.now - 9 * 60_000, "now private work");
    const ids = async (workspace: string) => (await w.t.query(pass.passInputs, { user_id: w.ana, workspace, window_start: w.now - 3 * H })).input.sessions.map((s: any) => s.id);
    expect(await ids(w.team)).not.toContain("jx7team");
    expect(await ids(`user:${w.ana}`)).toContain("jx7team");
    await w.send(w.ana, w.oldConv, w.now - 8 * 60_000, "other team work");
    model.reply = () => JSON.stringify({ priorities: [], unassigned: [] });
    expect((await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).status).toBe("ok");
    expect((await w.conversation(w.teamConv))?.priority_id).toBeUndefined();
  });

  test("a session that left the workspace with nothing new: the sweep picks the pair, and its pass lets it go and has the priority written again", async () => {
    const w = await world();
    await w.send(w.ana, w.teamConv, w.now - 2 * H, "work");
    model.reply = () => JSON.stringify({ priorities: [proposal()], unassigned: [] });
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    const [p] = await w.priorities();
    await w.t.run((ctx) => ctx.db.patch(w.teamConv, { is_private: true, team_visibility: "private" }));
    // The team pair has nothing new but a stray; the personal pair has the now-private session's work.
    expect(await w.t.query(pass.sweepCandidates, { team_id: w.acme })).toContainEqual({ user_id: w.ana, workspace: w.team });
    // The model is told the priority needs a rewrite, shown without the session that left or its old words.
    model.reply = () => JSON.stringify({ priorities: [proposal({ short_id: p.short_id, title: "Evals, still going", summary: "Waiting on the next run", steps: [{ key: "s1", title: "Grader faults under 10%", tier: "critical", refs: [] }], sessions: [] })], unassigned: [] });
    const asked = model.prompts.length;
    expect(await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).toMatchObject({ status: "ok" });
    expect(model.prompts.length).toBe(asked + 1);
    expect(model.prompts.at(-1)).toContain(`${p.short_id} · (title withheld: write it again) · active · rank 1 · last active`);
    expect(model.prompts.at(-1)).not.toContain("Trusted evals");
    expect(model.prompts.at(-1)).toMatch(/ · rewrite\n/);
    expect(model.prompts.at(-1)).not.toContain("Sessions: jx7team");
    expect((await w.conversation(w.teamConv))?.priority_id).toBeUndefined();
    const after = await w.t.run((ctx) => ctx.db.get(p._id));
    expect(after).toMatchObject({ title: "Evals, still going", session_count: 0 });
    expect(after?.needs_rewrite).toBeUndefined();
    // Nothing left to let go or rewrite: the next sweep leaves the team pair alone.
    expect(await w.t.query(pass.sweepCandidates, { team_id: w.acme })).not.toContainEqual({ user_id: w.ana, workspace: w.team });
  });

  test("a priority the reply does not write again keeps needing a rewrite, and the sweep keeps picking its pair", async () => {
    const w = await world();
    await w.send(w.ana, w.teamConv, w.now - 2 * H, "work");
    model.reply = () => JSON.stringify({ priorities: [proposal()], unassigned: [] });
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    const [p] = await w.priorities();
    await w.t.run((ctx) => ctx.db.patch(w.teamConv, { is_private: true, team_visibility: "private" }));
    model.reply = () => JSON.stringify({ priorities: [], unassigned: [] });
    expect(await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).toMatchObject({ status: "ok" });
    expect(await w.t.run((ctx) => ctx.db.get(p._id))).toMatchObject({ title: "Trusted evals", needs_rewrite: true });
    expect(await w.t.query(pass.sweepCandidates, { team_id: w.acme })).toContainEqual({ user_id: w.ana, workspace: w.team });
  });

  test("a pair past its daily ceiling still lets go of sessions that left: that asks no model", async () => {
    const w = await world();
    await w.send(w.ana, w.teamConv, w.now - 2 * H, "work");
    model.reply = () => JSON.stringify({ priorities: [proposal()], unassigned: [] });
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    await w.t.run(async (ctx) => {
      await ctx.db.patch(w.teamConv, { is_private: true, team_visibility: "private" });
      await ctx.db.insert("priority_pass_runs", { user_id: w.ana, workspace: w.team, started_at: w.now - 2 * H, finished_at: w.now - 2 * H, status: "ok", cursor_at: w.now - 2 * H, model: "m", cost_usd: 5, counts: { created: 0, updated: 0, merged: 0, mapped_sessions: 0 } });
    });
    const asked = model.prompts.length;
    expect(await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).toMatchObject({ status: "skipped", reason: expect.stringContaining("spent today") });
    expect(model.prompts.length).toBe(asked);
    expect((await w.conversation(w.teamConv))?.priority_id).toBeUndefined();
    // Its title may tell of the session that left: it waits, hidden from teammates, for a pass to write it again.
    expect((await w.priorities())[0].needs_rewrite).toBe(true);
  });

  test("a workflow's run log is never a pass input, nor a stray of the team priority holding it", async () => {
    const w = await world();
    const log = await w.t.run(async (ctx) => {
      const run = await ctx.db.insert("workflow_runs", { user_id: w.ana, workflow_name: "w", status: "completed", node_statuses: [], created_at: 1, updated_at: 1 } as any);
      return ctx.db.patch(w.oldConv, { is_workflow_primary: true, workflow_run_id: run }).then(() => w.oldConv);
    });
    await w.send(w.ana, log, w.now - 2 * H, "machine output");
    for (const workspace of [w.team, `user:${w.ana}`]) {
      const { input } = await w.t.query(pass.passInputs, { user_id: w.ana, workspace });
      expect(input.sessions.map((s: any) => s.id)).not.toContain("jx7old");
    }
    // Mapped earlier, it stays: it counts in the team's workspace, so it is no stray.
    await w.send(w.ana, w.teamConv, w.now - 2 * H, "work");
    model.reply = () => JSON.stringify({ priorities: [proposal()], unassigned: [] });
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    const [p] = await w.priorities();
    await w.t.run((ctx) => ctx.db.patch(log, { priority_id: p._id }));
    expect((await w.t.query(pass.passInputs, { user_id: w.ana, workspace: w.team })).strays).toEqual([]);
  });

  test("pairs with many quiet priorities cannot use up the sweep's stray probe before a later pair is looked at", async () => {
    const w = await world();
    await w.t.run(async (ctx) => {
      // Seven dormant pairs, thirty recently finished priorities each, waiting longest.
      const dormant: Array<[Id<"users">, string]> = [];
      for (let u = 0; u < 4; u++) {
        const user = await ctx.db.insert("users", { name: `D${u}` } as any);
        await ctx.db.insert("team_memberships", { user_id: user, team_id: w.acme, role: "member", joined_at: 1 } as any);
        dormant.push([user, w.team], [user, `user:${user}`]);
      }
      let n = 0;
      for (const [user, workspace] of dormant.slice(0, 7)) {
        for (let i = 0; i < 30; i++) {
          await ctx.db.insert("priorities", {
            user_id: user, workspace, short_id: `pri-${++n}`, title: "quiet", summary: "", status: "done", rank_set_by: "pass", steps: [],
            first_seen_at: 1, last_active_at: w.now - 2 * DAY, pass_at: 1, created_at: 1, updated_at: 1,
          } as any);
        }
      }
      // Ana's team pair, swept last, holds a session since locked private.
      const p = await ctx.db.insert("priorities", {
        user_id: w.ana, workspace: w.team, short_id: "pri-999", title: "held", summary: "", status: "active", rank_set_by: "pass", steps: [],
        first_seen_at: 1, last_active_at: w.now - H, pass_at: 1, created_at: 1, updated_at: 1,
      } as any);
      await ctx.db.patch(w.teamConv, { priority_id: p, is_private: true, team_visibility: "private" });
      await ctx.db.insert("priority_pass_runs", { user_id: w.ana, workspace: w.team, started_at: w.now, finished_at: w.now, status: "ok", cursor_at: w.now, model: "m", counts: { created: 0, updated: 0, merged: 0, mapped_sessions: 0 } });
    });
    expect(7 * 30).toBeGreaterThan(SWEEP_STRAY_BUDGET);
    expect(await w.t.query(pass.sweepCandidates, { team_id: w.acme })).toContainEqual({ user_id: w.ana, workspace: w.team });
  });

  test("the sweep's stray probe reads a pair's newest active priorities first too", async () => {
    const w = await world();
    await w.t.run(async (ctx) => {
      const priority = (short_id: string, last_active_at: number) => ctx.db.insert("priorities", {
        user_id: w.ana, workspace: w.team, short_id, title: short_id, summary: "", status: "active", rank_set_by: "pass", steps: [],
        first_seen_at: 1, last_active_at, pass_at: 1, created_at: 1, updated_at: 1,
      } as any);
      for (let i = 0; i < 31; i++) await priority(`pri-${i + 1}`, w.now - 60 * DAY);
      const recent = await priority("pri-99", w.now - H);
      await ctx.db.patch(w.teamConv, { priority_id: recent, is_private: true, team_visibility: "private" });
      for (const workspace of [w.team, `user:${w.ana}`]) {
        await ctx.db.insert("priority_pass_runs", { user_id: w.ana, workspace, started_at: w.now, finished_at: w.now, status: "ok", cursor_at: w.now, model: "m", counts: { created: 0, updated: 0, merged: 0, mapped_sessions: 0 } });
      }
    });
    expect(await w.t.query(pass.sweepCandidates, { team_id: w.acme })).toEqual([{ user_id: w.ana, workspace: w.team }]);
  });

  test("the stray probe starts from a different quiet pair each sweep, so one sweep's budget skips a pair another reaches", async () => {
    const w = await world();
    await w.t.run(async (ctx) => {
      let n = 0;
      for (let u = 0; u < 5; u++) {
        const user = await ctx.db.insert("users", { name: `D${u}` } as any);
        await ctx.db.insert("team_memberships", { user_id: user, team_id: w.acme, role: "member", joined_at: 1 } as any);
        for (const workspace of [w.team, `user:${user}`]) {
          if (++n > 9) continue;
          for (let i = 0; i < 25; i++) {
            await ctx.db.insert("priorities", {
              user_id: user, workspace, short_id: `pri-${n}-${i}`, title: "quiet", summary: "", status: "done", rank_set_by: "pass", steps: [],
              first_seen_at: 1, last_active_at: w.now - 2 * DAY, pass_at: 1, created_at: 1, updated_at: 1,
            } as any);
          }
        }
      }
      const p = await ctx.db.insert("priorities", {
        user_id: w.ana, workspace: w.team, short_id: "pri-999", title: "held", summary: "", status: "active", rank_set_by: "pass", steps: [],
        first_seen_at: 1, last_active_at: w.now - H, pass_at: 1, created_at: 1, updated_at: 1,
      } as any);
      await ctx.db.patch(w.teamConv, { priority_id: p, is_private: true, team_visibility: "private" });
      await ctx.db.insert("priority_pass_runs", { user_id: w.ana, workspace: w.team, started_at: w.now, finished_at: w.now, status: "ok", cursor_at: w.now, model: "m", counts: { created: 0, updated: 0, merged: 0, mapped_sessions: 0 } });
    });
    const found: boolean[] = [];
    const base = Math.floor(w.now / SWEEP_EVERY_MS) * SWEEP_EVERY_MS;
    for (let k = 0; k < 16; k++) {
      const pairs = await w.t.query(pass.sweepCandidates, { team_id: w.acme, now: base + k * SWEEP_EVERY_MS + 60_000 });
      found.push(pairs.some((p: any) => String(p.user_id) === String(w.ana) && p.workspace === w.team));
    }
    expect(found).toContain(true);
    expect(found).toContain(false);
  });

  test("the sweep's stray probe reads a pair's newest priorities first", async () => {
    const w = await world();
    await w.t.run(async (ctx) => {
      const priority = (short_id: string, last_active_at: number) => ctx.db.insert("priorities", {
        user_id: w.ana, workspace: w.team, short_id, title: short_id, summary: "", status: "done", rank_set_by: "pass", steps: [],
        first_seen_at: 1, last_active_at, pass_at: 1, created_at: 1, updated_at: 1,
      } as any);
      // Thirty-one older ones first, then the one that moved an hour ago, holding a session since locked private.
      for (let i = 0; i < 31; i++) await priority(`pri-${i + 1}`, w.now - 10 * DAY);
      const recent = await priority("pri-99", w.now - H);
      await ctx.db.patch(w.teamConv, { priority_id: recent, is_private: true, team_visibility: "private" });
      for (const workspace of [w.team, `user:${w.ana}`]) {
        await ctx.db.insert("priority_pass_runs", { user_id: w.ana, workspace, started_at: w.now, finished_at: w.now, status: "ok", cursor_at: w.now, model: "m", counts: { created: 0, updated: 0, merged: 0, mapped_sessions: 0 } });
      }
    });
    expect(await w.t.query(pass.sweepCandidates, { team_id: w.acme })).toEqual([{ user_id: w.ana, workspace: w.team }]);
  });

  test("a session made private and mapped by the personal pass leaves the team priority's count true", async () => {
    const w = await world();
    await w.send(w.ana, w.teamConv, w.now - 2 * H, "work");
    model.reply = () => JSON.stringify({ priorities: [proposal()], unassigned: [] });
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    const [team] = await w.priorities();
    await w.t.run((ctx) => ctx.db.patch(w.teamConv, { is_private: true, team_visibility: "private" }));
    await w.send(w.ana, w.teamConv, w.now - 8 * 60_000, "now private work");
    model.reply = () => JSON.stringify({ priorities: [proposal({ title: "Private work" })], unassigned: [] });
    expect((await w.t.action(pass.runPass, { user_id: w.ana, workspace: `user:${w.ana}` })).status).toBe("ok");
    const personal = (await w.priorities()).find((x: any) => x.workspace === `user:${w.ana}`)!;
    expect((await w.conversation(w.teamConv))?.priority_id).toBe(personal._id);
    expect(personal.session_count).toBe(1);
    expect((await w.t.run((ctx) => ctx.db.get(team._id)))?.session_count).toBe(0);
  });

  test("a count that drifted is counted again when a pass touches the priority, and deleting a mapped session counts it down and asks for a rewrite", async () => {
    const w = await world();
    await w.send(w.ana, w.teamConv, w.now - H, "work");
    model.reply = () => JSON.stringify({ priorities: [proposal()], unassigned: [] });
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    const [a] = await w.priorities();
    await w.t.run((ctx) => ctx.db.patch(a._id, { session_count: 9 }));
    await w.t.run((ctx) => ctx.db.patch(w.oldConv, { priority_id: a._id }));
    // The pass moves one session off it: the count is read from the index, not 9 − 1.
    await w.t.mutation(pass.applyPlan, { user_id: w.ana, workspace: w.team, started_at: Date.now() + 1, from_cursor: 1, cursor_at: 1, model: "m", plan: { creates: [], updates: [], merges: [], sessions: [], unmap: ["jx7old"], notes: [], rewritten: [] } });
    expect(await w.t.run((ctx) => ctx.db.get(a._id))).toMatchObject({ session_count: 1 });

    await w.t.mutation(internal.sessionDelete.adminDeleteSession, { conversation_id: w.teamConv });
    // Its title may tell of the deleted session: it needs a rewrite before teammates see it again.
    expect(await w.t.run((ctx) => ctx.db.get(a._id))).toMatchObject({ session_count: 0, needs_rewrite: true });
  });
});


describe("a priority that lost a session", () => {
  test("a session made private: a teammate no longer reads the old title, until a pass writes it again", async () => {
    const w = await world();
    const titles = async (who: Id<"users">) =>
      ((await w.t.withIdentity({ subject: `${who}|session` }).query((api as any).priorities.list, { workspace: w.team }))?.priorities ?? []).map((r: any) => r.title);
    await w.send(w.ana, w.teamConv, w.now - 2 * H, "work");
    await w.send(w.ana, w.oldConv, w.now - 2 * H, "more work");
    model.reply = () => JSON.stringify({ priorities: [proposal({ sessions: [{ session: "jx7team", step: "s1" }, { session: "jx7old", step: "s1" }] })], unassigned: [] });
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    expect(await titles(w.ben)).toEqual(["Trusted evals"]);

    // The title was written from jx7team, now private. A pass whose reply leaves the priority out lets the session go and hides it.
    await w.t.run((ctx) => ctx.db.patch(w.teamConv, { is_private: true, team_visibility: "private" }));
    model.reply = () => JSON.stringify({ priorities: [], unassigned: [] });
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team, force: true });
    expect(await titles(w.ben)).toEqual([]);
    expect(await titles(w.ana)).toEqual(["Trusted evals"]);

    // The next pass writes it again from what is still listed: the teammate reads the new title.
    model.reply = () => JSON.stringify({ priorities: [proposal({ short_id: "pri-1", title: "Evals on the old run", sessions: [{ session: "jx7old", step: "s1" }], steps: [{ key: "s1", title: "Grader faults under 10%", tier: "critical", refs: [] }] })], unassigned: [] });
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team, force: true });
    expect(await titles(w.ben)).toEqual(["Evals on the old run"]);
  });
});

const jobs = (w: Awaited<ReturnType<typeof world>>, name: string) =>
  w.t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((j: any) => j.name.includes(name)));

describe("sweep", () => {
  test("fans out only pairs with the feature on and work since their cursor", async () => {
    const w = await world();
    await w.send(w.ana, w.teamConv, w.now - H, "team work");
    await w.send(w.ana, w.otherConv, w.now - H, "work in a team without the feature");
    await w.send(w.carl, w.carlConv, w.now - H, "carl's work");
    await w.pin(w.ben, w.benConv, w.now - 5 * H, "Ben's pin");
    // Ben's pin is older than his last pass.
    await w.t.run((ctx) => ctx.db.insert("priority_pass_runs", { user_id: w.ben, workspace: w.team, started_at: w.now - 2 * H, finished_at: w.now - 2 * H, status: "ok", cursor_at: w.now - 2 * H, model: "m", counts: { created: 0, updated: 0, merged: 0, mapped_sessions: 0 } }));

    expect(await w.t.query(pass.sweepCandidates, { team_id: w.acme })).toEqual([{ user_id: w.ana, workspace: w.team }]);
    expect(await w.t.query(pass.sweepCandidates, { team_id: w.other })).toEqual([]);
    // The cron fans out one sweep per flagged team; each team's sweep schedules its pairs' passes.
    expect(await w.t.action(pass.sweep, {})).toBe(1);
    expect((await jobs(w, "sweepTeam")).map((j: any) => j.args[0])).toEqual([{ team_id: w.acme }]);
    expect(await w.t.action(pass.sweepTeam, { team_id: w.acme })).toBe(1);
    expect((await jobs(w, "runPass")).map((j: any) => j.args[0])).toEqual([{ user_id: w.ana, workspace: w.team }]);
  });

  test("the cron reads the teams a page at a time and reaches flagged teams past the first page", async () => {
    const w = await world();
    const flagged = await w.t.run(async (ctx) => {
      const out = [w.acme];
      for (let i = 0; i < 2 * SWEEP_TEAMS_PAGE + 10; i++) {
        const on = i % 97 === 96;
        const id = await ctx.db.insert("teams", { name: `T${i}`, created_at: 1, invite_code: `t${i}`, ...(on ? { features: { priorities: true } } : {}) } as any);
        if (on) out.push(id);
      }
      return out;
    });
    expect(flagged.length).toBe(5);
    expect(await w.t.action(pass.sweep, {})).toBe(flagged.length);
    expect((await jobs(w, "sweepTeam")).map((j: any) => String(j.args[0].team_id)).sort()).toEqual(flagged.map(String).sort());
  });

  test("a person in two flagged teams has their personal pair swept by one of them", async () => {
    const w = await world();
    await w.t.run((ctx) => ctx.db.patch(w.other, { features: { priorities: true } } as any));
    await w.send(w.ana, w.personalConv, w.now - H, "personal work");
    const personal = { user_id: w.ana, workspace: `user:${w.ana}` };
    const byTeam = await Promise.all([w.acme, w.other].map(async (team_id) => (await w.t.query(pass.sweepCandidates, { team_id })).some((p: any) => p.workspace === personal.workspace)));
    expect(byTeam.filter(Boolean)).toHaveLength(1);
  });
});
