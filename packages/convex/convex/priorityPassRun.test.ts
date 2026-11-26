// The priorities pass, run end to end against the tables (priorityPassRun.ts,
// priorityPassInputs.ts): what it reads stays inside one person's workspace
// and after its cursor, it skips where the feature is off, a failed reply
// leaves the cursor where it was, what it writes is that person's alone, and
// the person's own places and tiers survive the next pass.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import type { MergePlan } from "./lib/priorityPass";
import { LATE_MARGIN_MS } from "./priorityPassInputs";
import { PRIORITY_PASS_DAILY_USD, PRIORITY_PASS_FIRST_USD, applyPlan, catchUpSpent, hasOkRun, runBlocker } from "./priorityPassRun";
import { DAY, H, pass, proposal, stubModel, world } from "./priorityPassRun.testkit";
import { api } from "./_generated/api";

const pri = (api as any).priorities;

setDefaultTimeout(60_000);

const model = stubModel();

describe("inputs", () => {
  test("only the person's own sessions in this workspace, touched after the cursor, with their tasks, pull requests, pins and goals", async () => {
    const w = await world();
    await w.t.run(async (ctx) => {
      // The last pass read up to two hours ago.
      await ctx.db.insert("priority_pass_runs", { user_id: w.ana, workspace: w.team, started_at: w.now - 2 * H, finished_at: w.now - 2 * H, status: "ok", cursor_at: w.now - 2 * H, model: "m", counts: { created: 0, updated: 0, merged: 0, mapped_sessions: 0 } });
      await ctx.db.insert("tasks", { user_id: w.ana, team_id: w.acme, workspace: w.team, short_id: "ct-1", title: "Fix the grader", task_type: "task", priority: "medium", source: "human", status: "in_progress", created_from_conversation: w.teamConv, created_at: 1, updated_at: 1 } as any);
      await ctx.db.insert("tasks", { user_id: w.ana, workspace: `user:${w.ana}`, short_id: "ct-2", title: "Personal errand", task_type: "task", priority: "medium", source: "human", status: "open", created_from_conversation: w.teamConv, created_at: 1, updated_at: 1 } as any);
      const pr = await ctx.db.insert("pull_requests", { team_id: w.acme, github_pr_id: 1, repository: "acme/app", number: 7, title: "Grader", body: "", state: "merged", author_github_username: "ana", linked_session_ids: [w.teamConv], created_at: 1, updated_at: 1 } as any);
      await ctx.db.insert("pull_request_sessions", { pull_request_id: pr, conversation_id: w.teamConv, tier: "committed", pr_number: 7, team_id: w.acme });
      for (const [n, status] of [[1, "active"], [2, "completed"]] as const) {
        await ctx.db.insert("initiatives", { user_id: w.ana, team_id: w.acme, workspace: w.team, short_id: `in-${n}`, title: `Goal ${n}`, project_ids: [], status, health: "none" } as any);
      }
    });
    await w.send(w.ana, w.oldConv, w.now - 3 * H, "before the cursor");
    await w.send(w.ana, w.teamConv, w.now - H, "get grader faults under ten percent");
    await w.pin(w.ana, w.teamConv, w.now - 30 * 60_000, "Grader faults at 12%");
    await w.send(w.ana, w.personalConv, w.now - H, "personal work");
    await w.send(w.ben, w.benConv, w.now - H, "ben's work");
    await w.send(w.ana, w.otherConv, w.now - H, "other team's work");

    const { input, cursor_at, more } = await w.t.query(pass.passInputs, { user_id: w.ana, workspace: w.team });
    expect(cursor_at).toBe(w.now - 2 * H);
    expect(more).toBe(false);
    expect(input).toMatchObject({ person: "Ana", workspace: "Acme", initiatives: [{ short_id: "in-1", title: "Goal 1" }], priorities: [] });
    expect(input.sessions).toHaveLength(1);
    expect(input.sessions[0]).toMatchObject({
      id: "jx7team",
      first_prompt: "make jx7team work",
      pin: { text: "Grader faults at 14%", status: "working" },
      last_active: w.now - 30 * 60_000,
      tasks: [{ short_id: "ct-1", title: "Fix the grader", status: "in_progress" }],
      prs: [{ ref: "acme/app#7", merged: true }],
      pin_events: [{ at: w.now - 30 * 60_000, text: "Grader faults at 12%" }],
      typed: [{ at: w.now - H, text: "get grader faults under ten percent" }],
    });

    const personal = await w.t.query(pass.passInputs, { user_id: w.ana, workspace: `user:${w.ana}` });
    expect(personal.input.sessions.map((s: any) => s.id)).toEqual(["jx7mine"]);
    expect(personal.cursor_at).toBeLessThan(w.now - 13 * DAY);
  });
});

describe("runPass", () => {
  test("with the feature off it records a skipped run and asks no model", async () => {
    const w = await world();
    await w.send(w.ana, w.otherConv, w.now - H, "other team's work");
    const r = await w.t.action(pass.runPass, { user_id: w.ana, workspace: `team:${w.other}` });
    expect(r).toEqual({ status: "skipped", reason: "feature_off" });
    expect(model.prompts).toHaveLength(0);
    expect((await w.runs(`team:${w.other}`)).map((x: any) => x.status)).toEqual(["skipped"]);
    expect(await w.priorities()).toEqual([]);
  });

  test("a team workspace the person is not a member of records a skipped run and asks no model, forced or not", async () => {
    const w = await world();
    // Carl is in Other, not Acme; Acme has the feature on.
    await w.send(w.carl, w.carlConv, w.now - H, "carl's work");
    expect(await w.t.action(pass.runPass, { user_id: w.carl, workspace: w.team })).toEqual({ status: "skipped", reason: "feature_off" });
    expect(await w.t.action(pass.runNow, { user_id: w.carl, workspace: w.team })).toEqual({ status: "skipped", reason: "feature_off" });
    expect(model.prompts).toHaveLength(0);
    expect((await w.runs(w.team, w.carl)).map((x: any) => x.status)).toEqual(["skipped", "skipped"]);
    expect(await w.priorities()).toEqual([]);
  });

  test("with nothing touched it skips unless forced", async () => {
    const w = await world();
    expect(await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).toEqual({ status: "skipped", reason: "nothing_new" });
    expect(model.prompts).toHaveLength(0);
    expect((await w.t.action(pass.runNow, { user_id: w.ana, workspace: w.team })).status).toBe("ok");
    expect(model.prompts).toHaveLength(1);
  });

  test("an unreadable reply records an error and keeps the cursor, so the next pass reads the same work", async () => {
    const w = await world();
    await w.send(w.ana, w.teamConv, w.now - H, "get grader faults under ten percent");
    for (const bad of ["I could not decide.", JSON.stringify({ groups: [] })]) {
      model.reply = () => bad;
      const r = await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
      expect(r.status).toBe("error");
    }
    const failed = await w.runs();
    expect(failed.map((x: any) => x.status)).toEqual(["error", "error"]);
    expect(failed.every((x: any) => x.cursor_at < w.now - 13 * DAY)).toBe(true);
    expect(await w.priorities()).toEqual([]);

    model.reply = () => JSON.stringify({ priorities: [proposal()], unassigned: [] });
    expect((await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).status).toBe("ok");
    expect(model.prompts.at(-1)).toContain("get grader faults under ten percent");
    const last = (await w.runs()).at(-1)!;
    expect(last).toMatchObject({ status: "ok", counts: { created: 1, mapped_sessions: 1 } });
    // Everything was read: the cursor moves to a few minutes ago, where late rows can still land.
    expect(last.cursor_at).toBeGreaterThan(w.now - LATE_MARGIN_MS - 60_000);
  });

  test("creates pri-N rows and maps the session; the person's tier survives the next pass", async () => {
    const w = await world();
    await w.send(w.ana, w.teamConv, w.now - 2 * H, "get grader faults under ten percent");
    model.reply = () => JSON.stringify({ priorities: [proposal()], unassigned: [] });
    expect((await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).status).toBe("ok");

    const [created] = await w.priorities();
    expect(created).toMatchObject({ short_id: "pri-1", user_id: w.ana, workspace: w.team, title: "Trusted evals", status: "active", ai_rank: 1 });
    expect(created.person_pos).toBeUndefined();
    expect(created.steps).toEqual([{ key: "s1", title: "Grader faults under 10%", tier: "critical", tier_set_by: "pass", refs: [{ kind: "session", id: "jx7team" }], done: false }]);
    expect(await w.conversation(w.teamConv)).toMatchObject({ priority_id: created._id, priority_step_key: "s1" });

    // The person moves its step to polish.
    await w.t.run((ctx) => ctx.db.patch(created._id, { steps: [{ ...created.steps[0], tier: "polish", tier_set_by: "person" }] }));
    // Stamped below the cursor but landing after the first pass: the overlap reads it.
    await w.send(w.ana, w.teamConv, w.now - 8 * 60_000, "grader faults at nine percent");
    model.reply = (prompt) => {
      expect(prompt).toContain("pri-1");
      return JSON.stringify({ priorities: [proposal({ short_id: "pri-1", rank: 1, summary: "Under ten percent" })], unassigned: [] });
    };
    expect((await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).status).toBe("ok");
    const [after] = await w.priorities();
    expect(after).toMatchObject({ short_id: "pri-1", summary: "Under ten percent" });
    expect(after.steps[0]).toMatchObject({ key: "s1", tier: "polish", tier_set_by: "person" });
  });
});

describe("relative rank across pass runs", () => {
  test("a pass run after the person's moves keeps what they placed in their order; a new priority slots in between them", async () => {
    const w = await world();
    await w.t.run(async (ctx) => {
      for (const n of [1, 2, 3, 4]) {
        await ctx.db.insert("priorities", {
          user_id: w.ana, workspace: w.team, short_id: `pri-7${n}`, title: `Priority 7${n}`, summary: "", status: "active", ai_rank: n,
          steps: [], first_seen_at: 1, last_active_at: w.now - DAY, pass_at: 1, created_at: 1, updated_at: 1,
        });
      }
    });
    const order = async () => (await w.t.withIdentity({ subject: `${w.ana}|session` }).query(pri.list, { workspace: w.team, status: "active" })).priorities
      .map((p: any) => `${p.rank}:${p.short_id}:${p.rank_source}`);
    const ana = w.t.withIdentity({ subject: `${w.ana}|session` });
    await ana.mutation(pri.moveTo, { short_id: "pri-74", to: 1 });
    await ana.mutation(pri.moveTo, { short_id: "pri-72", to: 3 });
    expect(await order()).toEqual(["1:pri-74:person", "2:pri-71:ai", "3:pri-72:person", "4:pri-73:ai"]);
    const placed = async () => (await w.priorities()).filter((p: any) => p.person_pos !== undefined).map((p: any) => [p.short_id, p.person_pos]);
    const before = await placed();

    // The reply ranks everything backwards, the placed ones included.
    await w.send(w.ana, w.teamConv, w.now - 2 * H, "grader work");
    model.reply = () => JSON.stringify({
      priorities: ["pri-73", "pri-72", "pri-71", "pri-74"].map((short_id, i) => proposal({ short_id, title: `Priority ${short_id.slice(4)}`, rank: i + 1, steps: [], sessions: [] })),
      unassigned: [],
    });
    expect((await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).status).toBe("ok");
    expect(await placed()).toEqual(before);
    expect(await order()).toEqual(["1:pri-73:ai", "2:pri-74:person", "3:pri-71:ai", "4:pri-72:person"]);

    // A new priority the pass proposes at #3 lands between the two placed ones; the rest keep their places.
    await w.send(w.ana, w.teamConv, w.now - 8 * 60_000, "new work");
    model.reply = () => JSON.stringify({ priorities: [proposal({ title: "Fresh", rank: 3 })], unassigned: [] });
    expect((await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).status).toBe("ok");
    expect(await placed()).toEqual(before);
    const fresh = (await w.priorities()).find((p: any) => p.title === "Fresh")!;
    expect(await order()).toEqual(["1:pri-73:ai", "2:pri-74:person", `3:${fresh.short_id}:ai`, "4:pri-71:ai", "5:pri-72:person"]);
  });
});

describe("runPass, harder cases", () => {
  test("a workspace with no model budget still gets its pass, on codecast's own key", async () => {
    const w = await world();
    await w.t.run(async (ctx) => {
      for (const b of await ctx.db.query("team_budgets").collect()) await ctx.db.delete(b._id);
    });
    await w.send(w.ana, w.teamConv, w.now - H, "get grader faults under ten percent");
    model.reply = () => JSON.stringify({ priorities: [proposal()], unassigned: [] });
    const r = await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    expect(r).toMatchObject({ status: "ok", counts: { created: 1 } });
    expect(r.cost_usd).toBeGreaterThan(0);
    expect(model.prompts).toHaveLength(1);
    // Nothing was charged to a budget: none was created or spent.
    expect(await w.t.run((ctx) => ctx.db.query("team_budgets").collect())).toEqual([]);
  });

  test("more sessions than one prompt holds are read oldest first in chained runs, and every one is read", async () => {
    const w = await world();
    const N = 70;
    const at = (i: number) => w.now - 10 * DAY + i * 60_000;
    const ids = await w.t.run(async (ctx) => {
      const out: string[] = [];
      for (let i = 0; i < N; i++) {
        const short_id = `jx7s${String(i).padStart(3, "0")}`;
        const conv = await ctx.db.insert("conversations", {
          user_id: w.ana, team_id: w.acme, is_private: false, team_visibility: "full", agent_type: "claude_code", session_id: short_id, short_id,
          title: `Chunk ${short_id}`, first_prompt: "p".repeat(1_500), idle_summary: "s".repeat(600), started_at: 1, updated_at: 1, message_count: 3, status: "active",
        } as any);
        // The last session types less, so its early ask fits its typed-text budget in the prompt.
        for (let j = 0; j < (i === N - 1 ? 5 : 7); j++) {
          const timestamp = at(i) - (7 - j) * 1_000;
          const message = await ctx.db.insert("messages", { conversation_id: conv, role: "user", content: "x", timestamp } as any);
          await ctx.db.insert("user_sends", { user_id: w.ana, conversation_id: conv, message_id: message, timestamp, words: 100, text: `${short_id} ${"t".repeat(590)}`, clipped: false } as any);
        }
        if (i === N - 1) {
          const message = await ctx.db.insert("messages", { conversation_id: conv, role: "user", content: "x", timestamp: at(0) - 30_000 } as any);
          await ctx.db.insert("user_sends", { user_id: w.ana, conversation_id: conv, message_id: message, timestamp: at(0) - 30_000, words: 3, text: "early ask of the last session", clipped: false } as any);
        }
        out.push(short_id);
      }
      return out;
    });
    const scheduledRuns = async () => (await w.t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter((j: any) => j.name.includes("runPass"));

    let r = await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    expect(r).toMatchObject({ status: "ok", chained: true });
    // The first chunk holds the sessions that started earliest: the last session's early ask is read there.
    expect(model.prompts[0]).toContain(`## Session ${ids[0]} `);
    expect(model.prompts[0]).toContain("early ask of the last session");
    expect(model.prompts[0]).not.toContain(`## Session ${ids[N - 2]} `);
    for (let guard = 0; r.chained && guard < 6; guard++) {
      const jobs = await scheduledRuns();
      const next = jobs[jobs.length - 1].args[0];
      expect(next.chain).toBe(guard + 1);
      r = await w.t.action(pass.runPass, next);
    }
    expect(r.status).toBe("ok");
    expect(r.chained).toBeUndefined();
    expect(model.prompts.length).toBeGreaterThan(1);
    for (const id of ids) expect(model.prompts.some((p) => p.includes(`## Session ${id} `))).toBe(true);
    const runs = await w.runs();
    expect(runs.every((x: any) => x.status === "ok")).toBe(true);
    expect(runs.at(-1)!.cursor_at).toBeGreaterThanOrEqual(at(N - 1) - 1_000);
    // The cursor moved forward chunk by chunk.
    for (let i = 1; i < runs.length; i++) expect(runs[i].cursor_at).toBeGreaterThan(runs[i - 1].cursor_at);
    expect(await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).toEqual({ status: "skipped", reason: "nothing_new" });
  });

  test("of two interleaved runs, the one that applies after the other finished writes nothing and keeps the newer cursor", async () => {
    const w = await world();
    const plan = (title: string): MergePlan => ({
      creates: [{ ref: "new-1", first_seen_at: 1, title, summary: "", status: "active", ai_rank: 1, serves: null, steps: [], last_active_at: 1, done_at: null, pass_at: 1 }],
      updates: [], merges: [], sessions: [{ session: "jx7team", priority: "new-1", step_key: null }], unmap: [], notes: [], rewritten: [],
    });
    const apply = (title: string, started_at: number, from_cursor: number, cursor_at: number) =>
      w.t.mutation(pass.applyPlan, { user_id: w.ana, workspace: w.team, started_at, from_cursor, cursor_at, model: "m", plan: plan(title) });

    // B starts, A starts and reads further, B finishes, then A tries to write.
    const bStarted = Date.now() - 1_000;
    const aStarted = Date.now() - 500;
    expect(await apply("B", bStarted, 50, 200)).toMatchObject({ created: 1 });
    expect(await apply("A", aStarted, 50, 400)).toBeNull();

    expect((await w.priorities()).map((p: any) => p.title)).toEqual(["B"]);
    const b = (await w.priorities())[0];
    expect((await w.conversation(w.teamConv))?.priority_id).toBe(b._id);
    const runs = await w.runs();
    // A records where it started, so nothing past B's cursor is skipped; the cursor is B's.
    expect(runs.map((x: any) => [x.status, x.error ?? null, x.cursor_at])).toEqual([["ok", null, 200], ["skipped", "superseded", 50]]);
    expect((await w.t.query(pass.passGate, { user_id: w.ana, workspace: w.team })).cursor_at).toBe(200);

    // A run that starts after B finished applies as usual.
    expect(await apply("C", Date.now() + 1, 200, 300)).toMatchObject({ created: 1 });
  });
});

describe("what a pass may read, and how far", () => {
  test("a session filed under a team whose data may not go to the model vendor is never read, in either workspace", async () => {
    const w = await world();
    const clinicConv = await w.t.run(async (ctx) => {
      const clinic = await ctx.db.insert("teams", { name: "Clinic", invite_code: "clinic", created_at: 1, policy: { regulated_data: true } } as any);
      return ctx.db.insert("conversations", {
        user_id: w.ana, team_id: clinic, is_private: true, agent_type: "claude_code", session_id: "jx7clin", short_id: "jx7clin", title: "Patient intake",
        started_at: 1, updated_at: 1, message_count: 1, status: "active",
      } as any);
    });
    await w.send(w.ana, clinicConv, w.now - H, "patient notes");
    await w.send(w.ana, w.personalConv, w.now - H, "personal work");
    const { input } = await w.t.query(pass.passInputs, { user_id: w.ana, workspace: `user:${w.ana}` });
    expect(input.sessions.map((s: any) => s.id)).toEqual(["jx7mine"]);
  });

  test("a message that lands late, below the cursor, is read by the next pass; one read already is not read again", async () => {
    const w = await world();
    await w.send(w.ana, w.teamConv, w.now - 8 * 60_000, "already read once");
    // Landed before the pass started, not in the same millisecond (which reads it again: a repeat, never a loss).
    await new Promise((r) => setTimeout(r, 5));
    expect((await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).status).toBe("ok");
    expect(model.prompts[0]).toContain("already read once");
    // A client that was offline syncs a message stamped before the pass.
    await w.send(w.ana, w.teamConv, w.now - 7 * 60_000, "synced late");
    expect((await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).status).toBe("ok");
    expect(model.prompts[1]).toContain("synced late");
    expect(model.prompts[1]).not.toContain("already read once");
  });

  test("a pair whose window is full of another workspace's activity is swept, and its pass moves the cursor past it", async () => {
    const w = await world();
    await w.t.run(async (ctx) => {
      for (let i = 0; i < 300; i++) {
        const timestamp = w.now - 2 * H + i * 1_000;
        const message = await ctx.db.insert("messages", { conversation_id: w.teamConv, role: "user", content: "x", timestamp } as any);
        await ctx.db.insert("user_sends", { user_id: w.ana, conversation_id: w.teamConv, message_id: message, timestamp, words: 1, text: `team ${i}`, clipped: false } as any);
      }
    });
    const personal = `user:${w.ana}`;
    expect(await w.t.query(pass.sweepCandidates, { team_id: w.acme })).toContainEqual({ user_id: w.ana, workspace: personal });
    expect(await w.t.action(pass.runPass, { user_id: w.ana, workspace: personal })).toEqual({ status: "skipped", reason: "nothing_new" });
    expect(model.prompts).toHaveLength(0);
    expect((await w.runs(personal)).at(-1)!.cursor_at).toBeGreaterThan(w.now - 2 * H + 299_000);
    expect(await w.t.query(pass.sweepCandidates, { team_id: w.acme })).not.toContainEqual({ user_id: w.ana, workspace: personal });
  });

  test("the third failure in a row on one cursor steps past what failed, and says so", async () => {
    const w = await world();
    await w.send(w.ana, w.teamConv, w.now - H, "work");
    model.reply = () => "no JSON here";
    for (let i = 0; i < 3; i++) expect((await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).status).toBe("error");
    const runs = await w.runs();
    expect(runs[0].cursor_at).toBe(runs[1].cursor_at);
    expect(runs[2].cursor_at).toBeGreaterThan(w.now - H);
    expect(runs[2].error).toContain("stepped past");
    expect(await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).toEqual({ status: "skipped", reason: "nothing_new" });
    expect(model.prompts).toHaveLength(3);
  });

  test("a plan that throws as it lands records the call's cost, and the third such failure steps past", async () => {
    const w = await world();
    await w.send(w.ana, w.teamConv, w.now - H, "work");
    model.reply = () => JSON.stringify({ priorities: [proposal()], unassigned: [] });
    const real = (applyPlan as any)._handler;
    (applyPlan as any)._handler = async () => { throw new Error("write limit reached"); };
    try {
      for (let i = 0; i < 3; i++) expect((await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).status).toBe("error");
    } finally {
      (applyPlan as any)._handler = real;
    }
    const runs = await w.runs();
    expect(runs.map((r: any) => [r.status, r.repeats, r.cost_usd > 0])).toEqual([["error", true, true], ["error", true, true], ["error", true, true]]);
    expect(runs[0].error).toContain("applying the plan failed: write limit reached");
    expect(runs[0].cursor_at).toBe(runs[1].cursor_at);
    expect(runs[2].cursor_at).toBeGreaterThan(runs[0].cursor_at);
    expect(runs[2].error).toContain("stepped past");
  });

  test("an overloaded model three times in a row loses no work: the cursor stays until a pass goes through", async () => {
    const w = await world();
    await w.send(w.ana, w.teamConv, w.now - H, "the work that must not be lost");
    model.status = 529;
    for (let i = 0; i < 3; i++) expect((await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).status).toBe("error");
    const failed = await w.runs();
    expect(failed.map((x: any) => [x.status, x.repeats ?? false])).toEqual([["error", false], ["error", false], ["error", false]]);
    expect(new Set(failed.map((x: any) => x.cursor_at)).size).toBe(1);
    expect(failed.every((x: any) => !x.error.includes("stepped past"))).toBe(true);
    model.status = 200;
    expect((await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).status).toBe("ok");
    expect(model.prompts.at(-1)).toContain("the work that must not be lost");
  });

  test("four runNow at once make one model call; the others are told a pass is running", async () => {
    const w = await world();
    await w.send(w.ana, w.teamConv, w.now - H, "work");
    const results = await Promise.all([0, 1, 2, 3].map(() => w.t.action(pass.runNow, { user_id: w.ana, workspace: w.team })));
    expect(model.prompts).toHaveLength(1);
    expect(results.filter((r: any) => r.status === "ok")).toHaveLength(1);
    expect(results.filter((r: any) => r.status === "skipped").map((r: any) => r.reason)).toEqual(Array(3).fill("A pass is already running here."));
    // One row, settled: no reservation is left running.
    expect((await w.runs()).map((x: any) => x.status)).toEqual(["ok"]);
  });

  test("a reservation older than its time to live is dead: the next run settles it as abandoned and goes ahead", async () => {
    const w = await world();
    await w.t.run((ctx) => ctx.db.insert("priority_pass_runs", { user_id: w.ana, workspace: w.team, started_at: w.now - 20 * 60_000, finished_at: w.now - 20 * 60_000, status: "running", cursor_at: w.now - 2 * DAY, model: "m", counts: { created: 0, updated: 0, merged: 0, mapped_sessions: 0 } }));
    await w.send(w.ana, w.teamConv, w.now - H, "work");
    expect((await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).status).toBe("ok");
    expect((await w.runs()).map((x: any) => [x.status, x.error ?? null])).toEqual([["error", "abandoned: the run stopped before it settled"], ["ok", null]]);
  });

  test("a pair that spent its daily ceiling skips without asking the model", async () => {
    const w = await world();
    await w.t.run((ctx) => ctx.db.insert("priority_pass_runs", { user_id: w.ana, workspace: w.team, started_at: w.now - 2 * H, finished_at: w.now - 2 * H, status: "ok", cursor_at: w.now - 2 * H, model: "m", cost_usd: PRIORITY_PASS_DAILY_USD, counts: { created: 0, updated: 0, merged: 0, mapped_sessions: 0 } }));
    await w.send(w.ana, w.teamConv, w.now - H, "work");
    expect(await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).toEqual({ status: "skipped", reason: `Passes here spent today's $${PRIORITY_PASS_DAILY_USD.toFixed(2)}; the next one can run tomorrow.` });
    expect(await w.t.action(pass.runNow, { user_id: w.ana, workspace: w.team })).toEqual({ status: "skipped", reason: `Passes here spent today's $${PRIORITY_PASS_DAILY_USD.toFixed(2)}; the next one can run tomorrow.` });
    expect(model.prompts).toHaveLength(0);
    expect((await w.runs()).at(-1)).toMatchObject({ status: "skipped", error: "daily ceiling" });
  });

  test("whether a pair has an ok run is one indexed read on its status, however many runs it has", async () => {
    const w = await world();
    const run = (i: number, status: string) => ({ user_id: w.ana, workspace: w.team, started_at: w.now - i * 60_000, finished_at: w.now - i * 60_000, status, cursor_at: 1, model: "m", counts: { created: 0, updated: 0, merged: 0, mapped_sessions: 0 } });
    await w.t.run(async (ctx) => { for (let i = 0; i < 600; i++) await ctx.db.insert("priority_pass_runs", run(i + 10, "skipped") as any); });
    const read = async () => {
      const used: string[] = [];
      let found = false;
      await w.t.run(async (ctx: any) => {
        const db = new Proxy(ctx.db, {
          get(target: any, prop: string) {
            if (prop === "query") return (table: string) => {
              const q = target.query(table);
              return new Proxy(q, { get(qt: any, p: string) { if (p === "withIndex") return (name: string, fn: any) => (used.push(name), qt.withIndex(name, fn)); if (p === "filter") return () => { throw new Error("hasOkRun scanned with filter"); }; const v = qt[p]; return typeof v === "function" ? v.bind(qt) : v; } });
            };
            const value = target[prop];
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        found = await hasOkRun({ db }, w.ana, w.team);
      });
      return { used, found };
    };
    expect(await read()).toEqual({ used: ["by_user_workspace_status"], found: false });
    await w.t.run((ctx) => ctx.db.insert("priority_pass_runs", run(5000, "ok") as any));
    expect((await read()).found).toBe(true);
  });

  test("the catch-up allowance counts the newest runs: hundreds of old cheap runs cannot hide the dear ones that spent it", async () => {
    const w = await world();
    const run = (ago: number, cost_usd: number) => ({ user_id: w.ana, workspace: w.team, started_at: w.now - ago, finished_at: w.now - ago, status: cost_usd ? "error" : "skipped", cursor_at: 1, model: "m", cost_usd, catch_up: true, counts: { created: 0, updated: 0, merged: 0, mapped_sessions: 0 } });
    await w.t.run(async (ctx) => {
      for (let i = 0; i < 250; i++) await ctx.db.insert("priority_pass_runs", run(10 * DAY - i * 60_000, 0) as any);
      for (let i = 0; i < 3; i++) await ctx.db.insert("priority_pass_runs", run(H - i * 60_000, 2) as any);
    });
    expect(await w.t.run((ctx) => catchUpSpent(ctx, w.ana, w.team))).toBeGreaterThanOrEqual(PRIORITY_PASS_FIRST_USD);
    // So the next run is no catch-up: the daily ceiling applies.
    const blocked = await w.t.run((ctx) => runBlocker(ctx, w.ana, w.team, w.now, false, true));
    expect((blocked as any)?.catch_up).toBeUndefined();
  });

  test("the first catch-up spends from its own allowance, outside the daily ceiling, and its chained runs too; after it the ceiling applies", async () => {
    const w = await world();
    // Earlier catch-up attempts already cost more than a day's ceiling.
    await w.t.run((ctx) => ctx.db.insert("priority_pass_runs", { user_id: w.ana, workspace: w.team, started_at: w.now - 2 * H, finished_at: w.now - 2 * H, status: "error", cursor_at: w.now - 14 * DAY, model: "m", cost_usd: 3, catch_up: true, counts: { created: 0, updated: 0, merged: 0, mapped_sessions: 0 } }));
    await w.send(w.ana, w.teamConv, w.now - H, "work");
    expect(await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).toMatchObject({ status: "ok" });
    expect(model.prompts).toHaveLength(1);
    const latest = () => w.latestRun();
    expect(await latest()).toMatchObject({ status: "ok", catch_up: true });
    // A chained run of the catch-up keeps its allowance.
    await w.send(w.ana, w.oldConv, w.now - 30 * 60_000, "more");
    expect(await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team, catch_up: true, force: true })).toMatchObject({ status: "ok" });
    expect(await latest()).toMatchObject({ catch_up: true });
    // After it, a pass is an ordinary one: the catch-up's spend never counts toward the day's ceiling.
    expect(await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team, force: true })).toMatchObject({ status: "ok" });
    expect((await latest()).catch_up).toBeUndefined();
    // And the ceiling applies to ordinary passes.
    await w.t.run((ctx) => ctx.db.insert("priority_pass_runs", { user_id: w.ana, workspace: w.team, started_at: w.now - 15 * 60_000, finished_at: w.now - 15 * 60_000, status: "ok", cursor_at: w.now - 15 * 60_000, model: "m", cost_usd: PRIORITY_PASS_DAILY_USD, counts: { created: 0, updated: 0, merged: 0, mapped_sessions: 0 } }));
    expect(await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team, force: true })).toMatchObject({ status: "skipped", reason: expect.stringContaining("spent today") });
  });

  test("a pass reads activity by session, not by row: many messages in one session are read whole, and a session keeps its newest eight pins", async () => {
    const w = await world();
    await w.t.run(async (ctx) => {
      const message = await ctx.db.insert("messages", { conversation_id: w.teamConv, role: "user", content: "x", timestamp: w.now - 2 * H } as any);
      for (let i = 0; i < 1_200; i++) {
        await ctx.db.insert("user_sends", { user_id: w.ana, conversation_id: w.teamConv, message_id: message, timestamp: w.now - 2 * H + i, words: 1, text: `m${i}`, clipped: false } as any);
      }
      for (let i = 0; i < 20; i++) await ctx.db.insert("thread_state_events", { conversation_id: w.teamConv, user_id: w.ana, at: w.now - H + i, text: `pin ${i}`, status: "working" });
    });
    const read = await w.t.query(pass.passInputs, { user_id: w.ana, workspace: w.team });
    expect(read.more).toBe(false);
    const session = read.input.sessions.find((s: any) => s.id === "jx7team");
    expect(session.typed).toHaveLength(1_200);
    expect(session.pin_events.map((p: any) => p.text)).toEqual(Array.from({ length: 8 }, (_, i) => `pin ${12 + i}`));
  });

  test("runNow runs once in ten minutes per pair and says when it can run again", async () => {
    const w = await world();
    expect((await w.t.action(pass.runNow, { user_id: w.ana, workspace: w.team })).status).toBe("ok");
    const again = await w.t.action(pass.runNow, { user_id: w.ana, workspace: w.team });
    expect(again.status).toBe("skipped");
    expect(again.reason).toMatch(/^A pass ran here \d+ minutes? ago; run it again in 10 minutes\.$/);
    expect(model.prompts).toHaveLength(1);
    // Another person's pass is their own.
    expect((await w.t.action(pass.runNow, { user_id: w.ana, workspace: `user:${w.ana}` })).status).toBe("ok");
  });
});


describe("applyPlan", () => {
  const write = { title: "Mine", summary: "s", status: "active" as const, ai_rank: 1, serves: null, steps: [], last_active_at: 1, done_at: null, pass_at: 1 };

  test("never maps a conversation of another person or another workspace, never touches another person's priority, and lets a place the person set meanwhile stand", async () => {
    const w = await world();
    const bens = await w.t.run((ctx) => ctx.db.insert("priorities", { user_id: w.ben, workspace: w.team, short_id: "pri-50", title: "Ben's", summary: "", status: "active", ai_rank: 1, steps: [], first_seen_at: 1, last_active_at: 1, pass_at: 1, created_at: 1, updated_at: 1 }));
    const ranked = await w.t.run((ctx) => ctx.db.insert("priorities", { user_id: w.ana, workspace: w.team, short_id: "pri-51", title: "Ranked", summary: "", status: "active", person_pos: 2, steps: [], first_seen_at: 1, last_active_at: 1, pass_at: 1, created_at: 1, updated_at: 1 }));
    const plan: MergePlan = {
      creates: [{ ref: "new-1", first_seen_at: 1, ...write }],
      updates: [
        { short_id: "pri-50", patch: { title: "Taken over" } },
        { short_id: "pri-51", patch: { ai_rank: 1, title: "Ranked still" } },
      ],
      merges: [{ short_id: "pri-50", merged_into: "new-1" }],
      sessions: ["jx7team", "jx7ben", "jx7mine", "jx7othr"].map((session) => ({ session, priority: "new-1", step_key: null })),
      unmap: [],
      notes: [],
      rewritten: [],
    };
    const counts = await w.t.mutation(pass.applyPlan, { user_id: w.ana, workspace: w.team, started_at: 1, from_cursor: 1, cursor_at: 5, model: "m", plan });
    expect(counts).toEqual({ created: 1, updated: 1, merged: 0, mapped_sessions: 1 });

    const created = (await w.priorities()).find((p: any) => p.title === "Mine")!;
    expect(created.short_id).toMatch(/^pri-\d+$/);
    expect(created).not.toHaveProperty("serves");
    expect(created).not.toHaveProperty("done_at");
    expect((await w.conversation(w.teamConv))?.priority_id).toBe(created._id);
    for (const other of [w.benConv, w.personalConv, w.otherConv]) expect((await w.conversation(other))?.priority_id).toBeUndefined();
    expect(await w.t.run((ctx) => ctx.db.get(bens))).toMatchObject({ title: "Ben's", status: "active" });
    expect(await w.t.run((ctx) => ctx.db.get(ranked))).toMatchObject({ title: "Ranked still", person_pos: 2 });
    expect((await w.runs()).at(-1)).toMatchObject({ status: "ok", cursor_at: 5 });
  });

  test("a merge survivor's carried place lands only on a row the person has not placed since", async () => {
    const w = await world();
    const insert = (short_id: string, extra: Record<string, unknown>) => w.t.run((ctx) => ctx.db.insert("priorities", {
      user_id: w.ana, workspace: w.team, short_id, title: short_id, summary: "", status: "active", steps: [], first_seen_at: 1, last_active_at: 1, pass_at: 1, created_at: 1, updated_at: 1, ...extra,
    }));
    const open = await insert("pri-60", { ai_rank: 3 });
    const placed = await insert("pri-61", { person_pos: 4 });
    const plan: MergePlan = {
      creates: [],
      updates: [{ short_id: "pri-60", patch: { person_pos: 1 }, seen_steps: [] }, { short_id: "pri-61", patch: { person_pos: 1 }, seen_steps: [] }],
      merges: [], sessions: [], unmap: [], notes: [], rewritten: [],
    };
    await w.t.mutation(pass.applyPlan, { user_id: w.ana, workspace: w.team, started_at: 1, from_cursor: 1, cursor_at: 5, model: "m", plan });
    expect((await w.t.run((ctx) => ctx.db.get(open)))!.person_pos).toBe(1);
    expect((await w.t.run((ctx) => ctx.db.get(placed)))!.person_pos).toBe(4);
  });
});
