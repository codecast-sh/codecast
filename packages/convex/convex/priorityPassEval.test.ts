// What the priorities pass tells the model about sessions and calls, and the
// calibration replay (priorityPassInputs.ts, priorityPassEval.ts).
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Id } from "./_generated/dataModel";
import { DAY, H, pass, proposal, stubModel, world } from "./priorityPassRun.testkit";
import { PRIORITY_PASS_SYSTEM } from "./lib/priorityPass";

setDefaultTimeout(60_000);

const model = stubModel();

describe("what the model is told about sessions and calls", () => {
  test("a standing role's seat reads as a role, a session another started as a worker of its parent; a fork and a session filed under a role are the person's own", async () => {
    const w = await world();
    await w.t.run(async (ctx) => {
      const orgRole = await ctx.db.insert("org_roles", {
        short_id: "or-1", scope_type: "user", scope_user_id: w.ana, host_user_id: w.ana, name: "Infrastructure", handle: "infra",
        scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: w.ana }, status: "active", trust: "direct",
        caps: { hands_per_day: 10, wakes_per_day: 10, tokens_per_day: 1_000_000, line_on: true }, created_by: w.ana, created_at: 1, updated_at: 1,
      } as any);
      const conv = (short_id: string, fields: Record<string, unknown>) => ctx.db.insert("conversations", {
        user_id: w.ana, team_id: w.acme, is_private: false, team_visibility: "full", agent_type: "claude_code", session_id: short_id, short_id,
        title: `Session ${short_id}`, started_at: 1, updated_at: 1, message_count: 1, status: "active", ...fields,
      } as any);
      for (const c of [
        await conv("jx7role", { standing_role_id: orgRole }),
        await conv("jx7work", { parent_conversation_id: w.teamConv }),
        await conv("jx7fork", { parent_conversation_id: w.teamConv, parent_message_uuid: "m-1" }),
        await conv("jx7file", { org_role_id: orgRole }),
      ]) {
        const message = await ctx.db.insert("messages", { conversation_id: c, role: "user", content: "x", timestamp: w.now - H } as any);
        await ctx.db.insert("user_sends", { user_id: w.ana, conversation_id: c, message_id: message, timestamp: w.now - H, words: 1, text: "work", clipped: false } as any);
      }
    });
    await w.send(w.ana, w.teamConv, w.now - H, "work");
    const { input } = await w.t.query(pass.passInputs, { user_id: w.ana, workspace: w.team });
    const kinds = Object.fromEntries(input.sessions.map((s: any) => [s.id, s.parent ? `${s.kind} of ${s.parent}` : s.kind]));
    expect(kinds).toEqual({ jx7role: "role", jx7work: "worker of jx7team", jx7fork: "session", jx7file: "session", jx7team: "session" });
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    expect(model.prompts[0]).toContain('## Session jx7role · "Session jx7role" · role ·');
    expect(model.prompts[0]).toContain('## Session jx7work · "Session jx7work" · worker of jx7team ·');
    expect(model.prompts[0]).toContain('## Session jx7fork · "Session jx7fork" · last active');
  });

  /** Calls in a room on Ana's team-visible session, which every teammate may read. */
  async function callWorld() {
    const w = await world();
    await w.t.run((ctx) => ctx.db.patch(w.acme, { features: { priorities: true, calls: true } } as any));
    const call = (short_id: string, speaker: Id<"users">, landed: number, fields: Record<string, unknown> = {}) => w.t.run((ctx) => ctx.db.insert("transcripts", {
      room_key: `session:${w.teamConv}`, team_id: w.acme, started_by: w.ben, status: "ended", started_at: landed - 30 * 60_000, ended_at: landed - 60_000, summary_at: landed,
      routes: [], last_seq: 0, short_id, title: `Call ${short_id}`, participants: [{ id: String(speaker), name: "someone" }],
      summary: `We agreed the grader ships (${short_id}).`, action_items: [`Ana ships the grader (${short_id})`], ...fields,
    } as any));
    return { w, call };
  }

  test("calls the person was in whose summary landed since the cursor come with their summary and action items; others' calls and older ones do not", async () => {
    const { w, call } = await callWorld();
    await call("cl-1", w.ana, w.now - 2 * H);
    await call("cl-2", w.ben, w.now - 2 * H);
    await call("cl-3", w.ana, w.now - 20 * DAY);
    await w.send(w.ana, w.teamConv, w.now - H, "work");
    const { input } = await w.t.query(pass.passInputs, { user_id: w.ana, workspace: w.team });
    expect(input.calls).toEqual([{ id: "cl-1", title: "Call cl-1", at: w.now - 2 * H, summary: "We agreed the grader ships (cl-1).", action_items: ["Ana ships the grader (cl-1)"] }]);
    expect((await w.t.query(pass.passInputs, { user_id: w.ana, workspace: `user:${w.ana}` })).input.calls).toEqual([]);
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    expect(model.prompts[0]).toContain("# Calls they were in since the last pass\n## Call cl-1 · \"Call cl-1\"");
    expect(model.prompts[0]).toContain("- Ana ships the grader (cl-1)");
    expect(model.prompts[0]).not.toContain("cl-2");
  });

  test("only calls the whole team may read: not a private huddle, not a people room, a recording only once shared", async () => {
    const { w, call } = await callWorld();
    const people = `dm:${[String(w.ana), String(w.ben)].sort().join(":")}`;
    const rec = (n: number) => `rec:9f8e7d6c-1234-4abc-9def-0123456789a${n}`;
    await call("cl-open", w.ana, w.now - 2 * H);
    await call("cl-priv", w.ana, w.now - 2 * H, { private: true });
    await call("cl-dm", w.ana, w.now - 2 * H, { room_key: people });
    await call("cl-rec", w.ana, w.now - 2 * H, { room_key: rec(1), started_by: w.ana });
    await call("cl-recsh", w.ana, w.now - 2 * H, { room_key: rec(2), started_by: w.ana, rec_shared: true });
    await w.send(w.ana, w.teamConv, w.now - H, "work");
    const { input } = await w.t.query(pass.passInputs, { user_id: w.ana, workspace: w.team });
    expect(input.calls.map((c: any) => c.id).sort()).toEqual(["cl-open", "cl-recsh"]);
  });

  test("a call alone is enough for a pass", async () => {
    const { w, call } = await callWorld();
    await call("cl-only", w.ana, w.now - 2 * H);
    expect((await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).status).toBe("ok");
    expect(model.prompts[0]).toContain("## Call cl-only ");
  });

  test("in a chunked first pass each call reaches exactly one prompt, the one whose window holds it", async () => {
    const { w, call } = await callWorld();
    const N = 70;
    const at = (i: number) => w.now - 10 * DAY + i * 60 * 60_000;
    await w.t.run(async (ctx) => {
      for (let i = 0; i < N; i++) {
        const short_id = `jx7c${String(i).padStart(3, "0")}`;
        const conv = await ctx.db.insert("conversations", {
          user_id: w.ana, team_id: w.acme, is_private: false, team_visibility: "full", agent_type: "claude_code", session_id: short_id, short_id,
          title: `Chunk ${short_id}`, first_prompt: "p".repeat(1_500), idle_summary: "s".repeat(600), started_at: 1, updated_at: 1, message_count: 3, status: "active",
        } as any);
        for (let j = 0; j < 7; j++) {
          const timestamp = at(i) - (7 - j) * 1_000;
          const message = await ctx.db.insert("messages", { conversation_id: conv, role: "user", content: "x", timestamp } as any);
          await ctx.db.insert("user_sends", { user_id: w.ana, conversation_id: conv, message_id: message, timestamp, words: 100, text: `${short_id} ${"t".repeat(590)}`, clipped: false } as any);
        }
      }
    });
    const calls = [5, 35, 65].map((i) => `cl-at${i}`);
    for (const [k, i] of [5, 35, 65].entries()) await call(calls[k], w.ana, at(i) + 30_000);
    let r = await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    for (let guard = 0; r.chained && guard < 6; guard++) {
      const jobs = (await w.t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter((j: any) => j.name.includes("runPass"));
      r = await w.t.action(pass.runPass, jobs[jobs.length - 1].args[0]);
    }
    expect(model.prompts.length).toBeGreaterThan(1);
    for (const id of calls) expect(model.prompts.filter((p) => p.includes(`## Call ${id} `))).toHaveLength(1);
  });

  test("a calibration replay shows each call once, in the chunk whose window holds it", async () => {
    const { w, call } = await callWorld();
    await w.send(w.ana, w.oldConv, w.now - 3 * DAY, "first");
    await w.send(w.ana, w.teamConv, w.now - 2 * DAY, "second");
    await call("cl-early", w.ana, w.now - 2.5 * DAY);
    await call("cl-late", w.ana, w.now - DAY);
    await w.t.action(pass.evalPass, { user_id: w.ana, workspace: w.team, window_start: w.now - 3.5 * DAY, window_end: w.now, chunk: 1 });
    expect(model.prompts).toHaveLength(2);
    expect(model.prompts.map((p) => ["cl-early", "cl-late"].filter((id) => p.includes(`## Call ${id} `)))).toEqual([["cl-early"], ["cl-late"]]);
  });
});


describe("evalPass", () => {
  test("runs from empty over the window and writes nothing: no priority, no mapping, no run row", async () => {
    const w = await world();
    // A priority the person already has is not part of a calibration pass.
    await w.t.run((ctx) => ctx.db.insert("priorities", { user_id: w.ana, workspace: w.team, short_id: "pri-60", title: "Already here", summary: "", status: "active", rank: 1, rank_set_by: "pass", steps: [], first_seen_at: 1, last_active_at: 1, pass_at: 1, created_at: 1, updated_at: 1 }));
    await w.send(w.ana, w.teamConv, w.now - 2 * H, "get grader faults under ten percent");
    await w.send(w.ana, w.oldConv, w.now - 30 * DAY, "before the window");
    model.reply = () => JSON.stringify({ priorities: [proposal()], unassigned: [] });

    const r = await w.t.action(pass.evalPass, { user_id: w.ana, workspace: w.team, window_start: w.now - 3 * DAY, window_end: w.now });
    expect(model.prompts).toHaveLength(1);
    expect(model.prompts[0]).toContain("(none yet)");
    expect(model.prompts[0]).not.toContain("before the window");
    expect(r.sessions_read).toEqual([{ id: "jx7team", title: "Session jx7team" }]);
    expect(r.cost_usd).toBeGreaterThan(0);
    expect(r.resume).toBeUndefined();
    expect(r.priorities).toHaveLength(1);
    expect(r.priorities[0]).toMatchObject({ short_id: "pri-1", title: "Trusted evals", status: "active", sessions: [{ id: "jx7team", step_key: "s1" }] });

    expect((await w.priorities()).map((p: any) => p.short_id)).toEqual(["pri-60"]);
    expect((await w.conversation(w.teamConv))?.priority_id).toBeUndefined();
    expect(await w.runs()).toEqual([]);
  });

  test("chunks chain oldest first: each chunk's priorities are the next chunk's existing ones", async () => {
    const w = await world();
    await w.send(w.ana, w.oldConv, w.now - 2 * DAY, "start the grader work");
    await w.send(w.ana, w.teamConv, w.now - H, "get grader faults under ten percent");
    model.reply = () => model.prompts.length === 1
      ? JSON.stringify({ priorities: [proposal({ steps: [{ key: "s1", title: "Grader faults under 10%", tier: "critical", refs: [] }], sessions: [{ session: "jx7old", step: "s1" }] })], unassigned: [] })
      : JSON.stringify({ priorities: [proposal({ short_id: "pri-1", steps: [{ key: "s1", title: "Grader faults under 10%", tier: "critical", refs: [] }], sessions: [{ session: "jx7team", step: "s1" }] })], unassigned: [] });

    const r = await w.t.action(pass.evalPass, { user_id: w.ana, workspace: w.team, window_start: w.now - 3 * DAY, window_end: w.now, chunk: 1 });
    expect(model.prompts).toHaveLength(2);
    expect(model.prompts[0]).toContain("start the grader work");
    expect(model.prompts[0]).not.toContain("get grader faults under ten percent");
    expect(model.prompts[1]).toContain('pri-1 · "Trusted evals"');
    expect(model.prompts[1]).toContain("get grader faults under ten percent");
    expect(model.prompts[1]).not.toContain("start the grader work");
    expect(r.outputs.map((o: any) => o.sessions)).toEqual([["jx7old"], ["jx7team"]]);
    expect(r.priorities).toHaveLength(1);
    expect(r.priorities[0].sessions.map((s: any) => s.id).sort()).toEqual(["jx7old", "jx7team"]);
    expect(await w.priorities()).toEqual([]);
    expect(await w.runs()).toEqual([]);
  });

  test("a given system prompt replaces the pass's for that replay alone; the user turn is unchanged", async () => {
    const w = await world();
    await w.send(w.ana, w.teamConv, w.now - 2 * H, "get grader faults under ten percent");
    const sent: Array<{ system: string; prompt: string }> = [];
    const stub = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body);
      sent.push({ system: body.system, prompt: body.messages[0].content });
      return stub(url as any, init as any);
    }) as unknown as typeof fetch;
    const args = { user_id: w.ana, workspace: w.team, window_start: w.now - 3 * DAY, window_end: w.now };
    await w.t.action(pass.evalPass, { ...args, system: "Candidate prompt v2." });
    await w.t.action(pass.evalPass, args);
    expect(sent.map((s) => s.system)).toEqual(["Candidate prompt v2.", PRIORITY_PASS_SYSTEM]);
    expect(sent[0]!.prompt).toBe(sent[1]!.prompt);
  });

  test("a replay sees each session's pin as it stood at the window's end: a later pin is withheld and the newest pin in the window stands in", async () => {
    const w = await world();
    const end = w.now - 2 * DAY;
    await w.send(w.ana, w.teamConv, end - 2 * H, "get grader faults under ten percent");
    await w.pin(w.ana, w.teamConv, end - H, "Grader faults at 20%");
    await w.send(w.ana, w.oldConv, end - 2 * H, "start the deploy work");
    // Both sessions were pinned again after the window; teamConv also has a pin event inside it.
    await w.t.run(async (ctx) => {
      await ctx.db.patch(w.teamConv, { thread_state: "Grader faults shipped, done", thread_state_at: w.now - H } as any);
      await ctx.db.patch(w.oldConv, { thread_state: "Deploys live", thread_state_at: w.now - H } as any);
    });
    model.reply = () => JSON.stringify({ priorities: [], unassigned: [] });
    await w.t.action(pass.evalPass, { user_id: w.ana, workspace: w.team, window_start: end - 3 * DAY, window_end: end });
    const prompt = model.prompts.at(-1)!;
    expect(prompt).toContain("Grader faults at 20%");
    expect(prompt).not.toContain("Grader faults shipped, done");
    expect(prompt).not.toContain("Deploys live");

    // A live pass sees the current pin.
    const { input } = await w.t.query(pass.passInputs, { user_id: w.ana, workspace: w.team, window_start: end - 3 * DAY });
    expect(input.sessions.find((s: any) => s.id === "jx7team")?.pin).toEqual({ text: "Grader faults shipped, done", status: "working" });
  });
});
