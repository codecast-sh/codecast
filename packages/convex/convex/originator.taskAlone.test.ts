// A run started from a plain shell on a task alone (`cast flow run change --task ct-N`, its working sessions ended)
// carries no session of its change: the intent read and check (flows.md FL11) both walk up from the sessions tied to
// the task, which the server reads off the task itself, never off a session the caller names. A project lead's
// standing session given to the run as a stand-in spawner is never one of them.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { ANA_TOKEN, EVE_TOKEN, api, finishBackends, seed } from "./originator.testkit";

setDefaultTimeout(60_000);
afterEach(finishBackends);

describe("a run on a task alone", () => {
  async function seedTaskRun(opts: { starter?: "ana" | "eve"; tie?: "bound" | "handoff" | "none"; spawnedBy?: boolean; projectLead?: "stand-in" | "lead-ran" } = {}) {
    const s = await seed();
    const { t, ana, eve, conv, echo, post } = s;
    const starter = opts.starter === "eve" ? eve : ana;
    const token = opts.starter === "eve" ? EVE_TOKEN : ANA_TOKEN;
    // Eve co-owns both, so a run of hers reads them; their terminal lines are Ana's, the sessions' user.
    const lead = await conv({ title: "Fix the deploys page", owner_user_id: eve });
    await echo(lead, "look at the deploys page");
    await echo(lead, "Yes, ship this once the tests pass.");
    // The implementer, killed after it handed off: the run has no live session to take as its subject.
    const worker = await conv({ spawned_by_conversation_id: lead, owner_user_id: eve, inbox_killed_at: Date.now() });
    await echo(worker, "on it");
    const reviewer = await conv({ title: "Review ct-7", owner_user_id: eve });
    await echo(reviewer, "ship it");
    // A triage session whose "ship it" was about other work; it touched ct-7 in passing (a `cast task update`), which
    // links it on the task without binding it.
    const elsewhere = await conv({ title: "Triage", owner_user_id: eve });
    await echo(elsewhere, "ship it");
    // The project lead's standing session, where Ana told the lead to ship other work.
    const standing = await conv({ title: "Deploys lead", owner_user_id: eve });
    await echo(standing, "ship the billing fix");
    const tie = opts.tie ?? "bound";
    const ids = await t.run(async (ctx: any) => {
      const now = Date.now();
      // A project led by a role: a run on its task that names no spawner gets the lead's standing session as one.
      const project = opts.projectLead ? await (async () => {
        const team = await ctx.db.insert("teams", { name: "Acme", created_at: now, invite_code: "acme" } as any);
        const projectId = await ctx.db.insert("projects", { user_id: ana, team_id: team, title: "Deploys", status: "active", created_at: now, updated_at: now } as any);
        const anchor = await ctx.db.insert("anchors", { scope_type: "team", team_id: team, bot_user_id: ana, host_user_id: ana, name: "Deploys lead", status: "active", conversation_id: standing, created_at: now } as any);
        const role = await ctx.db.insert("org_roles", {
          short_id: "or-1", scope_type: "team", team_id: team, host_user_id: ana, name: "Deploys lead", handle: "deploys",
          scope: { project_ids: [projectId], plan_ids: [] }, reports_to: { kind: "user", user_id: ana }, status: "active",
          anchor_id: anchor, created_by: ana, created_at: now, updated_at: now,
        } as any);
        await ctx.db.patch(projectId, { owner_role_id: role });
        return projectId;
      })() : null;
      const task = await ctx.db.insert("tasks", {
        user_id: starter, workspace: `user:${starter}`, short_id: "ct-7", title: "Fix the deploys page", status: "in_review", source: "agent",
        conversation_ids: tie === "none" ? [elsewhere] : [worker, reviewer, elsewhere], created_at: now, updated_at: now,
        ...(project ? { project_id: project } : {}),
      } as any);
      await ctx.db.patch(reviewer, { review_of_task_id: task, active_task_id: task });
      if (tie === "bound") await ctx.db.patch(worker, { active_task_id: task });
      if (tie === "handoff") {
        await ctx.db.insert("task_comments", { task_id: task, author: "agent", text: "Handoff: done\n\nran the tests", conversation_id: worker, comment_type: "review", created_at: now } as any);
      }
      // Notes from sessions that only commented name no anchor.
      await ctx.db.insert("task_comments", { task_id: task, author: "agent", text: "looked at it", conversation_id: elsewhere, comment_type: "progress", created_at: now } as any);
      const run = opts.projectLead ? null : await ctx.db.insert("workflow_runs", {
        user_id: starter, task_id: task, status: "running", current_node_id: "intent__clear",
        node_statuses: [{ node_id: "intent__clear", status: "running" }], created_at: now, updated_at: now,
        ...(opts.spawnedBy ? { spawner_conversation_id: elsewhere } : {}),
      } as any);
      return { task, run };
    });
    // On a led project the run is made as `cast flow run` makes it: from a plain shell it names no spawner and gets
    // the lead's standing session as a stand-in; run from the lead's own session it names that session.
    if (opts.projectLead) {
      ids.run = (await t.mutation(api.workflow_runs.createFromCli, {
        api_token: token, workflow_name: "change", task_id: "ct-7", ...(opts.projectLead === "lead-ran" ? { spawner_session: String(standing) } : {}),
      })).run_id;
    }
    const sid = async (c: unknown) => (await t.run((ctx: any) => ctx.db.get(c))).short_id;
    const read = (task = "ct-7") => post("/cli/sessions/originator", { api_token: token, task, run_id: String(ids.run) });
    const verify = (cite: { conversation_short_id: string; line: number }, quote: string) =>
      post("/cli/intent/verify", { api_token: token, run_id: String(ids.run), cite, quote, head: "a".repeat(40) });
    return { ...s, lead, worker, reviewer, elsewhere, standing, sid, read, verify, ...ids };
  }

  test("a run whose spawner is only its project lead's stand-in reads the task's sessions, never the lead's transcript", async () => {
    const { ana, lead, worker, standing, sid, read, verify, t, run, task, conv } = await seedTaskRun({ projectLead: "stand-in", tie: "handoff" });
    expect(await t.run((ctx: any) => ctx.db.get(run))).toMatchObject({ spawner_conversation_id: standing, spawner_stand_in: true });
    // The run's hands, built as /cli/spawn builds them: no run of their own, spawned by the run's spawner (the
    // stand-in) and nested under the run's session. One is bound to the task; the other ran a Workflow tool run of its
    // own (which gives it that run's id, workflow_runs.ingestSnapshot) and handed the task off. Neither chain climbs
    // to the stand-in.
    const primary = (await t.run((ctx: any) => ctx.db.get(run))).primary_conversation_id;
    expect(primary).toBeTruthy();
    const owner_user_id = await t.run(async (ctx: any) => (await ctx.db.get(worker)).owner_user_id);
    const hand = await conv({ spawned_by_conversation_id: standing, parent_conversation_id: primary, is_subagent: true, active_task_id: task, owner_user_id });
    const ownRun = await t.run((ctx: any) => ctx.db.insert("workflow_runs", { user_id: ana, status: "completed", node_statuses: [], created_at: Date.now(), updated_at: Date.now() } as any));
    const builder = await conv({ spawned_by_conversation_id: standing, parent_conversation_id: primary, is_subagent: true, workflow_run_id: ownRun, owner_user_id });
    await t.run((ctx: any) => ctx.db.insert("task_comments", { task_id: task, author: "agent", text: "Handoff: done", conversation_id: builder, comment_type: "review", created_at: Date.now() } as any));
    const r = await read();
    expect(r.chain).toEqual([]);
    const tied = r.task.chain.map((h: any) => h.conversation_id);
    expect(tied).toEqual(expect.arrayContaining([String(worker), String(lead), String(hand), String(builder), String(primary)]));
    expect(tied).not.toContain(String(standing));
    expect(r.typed.some((l: any) => l.conversation_id === String(standing))).toBe(false);
    expect(await verify({ conversation_short_id: await sid(lead), line: 2 }, "Yes, ship this")).toMatchObject({ starter_id: String(ana) });
    // The lead's "ship" was about other work, and nothing reads or clears it.
    expect((await verify({ conversation_short_id: await sid(standing), line: 1 }, "ship the billing fix")).error).toMatch(/not a session this change came through/);
  });

  test("a run the lead's own session started keeps the lead's chain, as any session-started run does", async () => {
    const { ana, standing, sid, read, verify, t, run } = await seedTaskRun({ projectLead: "lead-ran" });
    expect((await t.run((ctx: any) => ctx.db.get(run))).spawner_stand_in).toBeUndefined();
    const r = await read();
    expect(r.chain.map((h: any) => h.conversation_id)).toEqual([String(standing)]);
    expect(r.task.chain).toEqual([]);
    expect(await verify({ conversation_short_id: await sid(standing), line: 1 }, "ship the billing fix")).toMatchObject({ starter_id: String(ana) });
  });

  test("reads the starter's word up the chain of the session bound to the task, and the server clears it", async () => {
    const { ana, lead, worker, reviewer, elsewhere, sid, read, verify } = await seedTaskRun();
    const r = await read();
    expect(r.error).toBeUndefined();
    expect(r.chain).toEqual([]);
    expect(r.originator).toBeUndefined();
    expect(r).toMatchObject({ starter_id: String(ana), starter_name: "Ana" });
    // The worker and the lead it was spawned by; not the task's reviewer, nor a session that only touched or commented on it.
    expect(r.task.chain.map((h: any) => h.conversation_id)).toEqual([String(worker), String(lead)]);
    expect(r.typed.map((l: any) => l.text)).toContain("Yes, ship this once the tests pass.");
    expect(r.typed.some((l: any) => [String(reviewer), String(elsewhere)].includes(l.conversation_id))).toBe(false);

    const at = await sid(lead);
    expect(await verify({ conversation_short_id: at, line: 2 }, "Yes, ship this")).toMatchObject({ starter_id: String(ana), cite: `${at}:2` });
    // A session the client might name, off every chain the server walks, never clears.
    expect((await verify({ conversation_short_id: await sid(elsewhere), line: 1 }, "ship it")).error).toMatch(/not a session this change came through/);
    expect((await verify({ conversation_short_id: await sid(reviewer), line: 1 }, "ship it")).error).toMatch(/not a session this change came through/);
  });

  test("a run a session started keeps its own chain: the task's working sessions do not widen what clears it", async () => {
    const { lead, elsewhere, sid, read, verify } = await seedTaskRun({ spawnedBy: true });
    // Read with the task alone, it shows what verify walks: the spawner's chain, not the task's working sessions.
    const r = await read();
    expect(r.chain.map((h: any) => h.conversation_id)).toEqual([String(elsewhere)]);
    expect(r.task.chain).toEqual([]);
    expect(r.typed.map((l: any) => l.conversation_id)).toEqual([String(elsewhere)]);
    expect((await verify({ conversation_short_id: await sid(lead), line: 2 }, "Yes, ship this")).error).toMatch(/not a session this change came through/);
    expect(await verify({ conversation_short_id: await sid(elsewhere), line: 1 }, "ship it")).toMatchObject({ cite: `${await sid(elsewhere)}:1` });
  });

  test("a run whose starting session has since been deleted still had one: the task's working sessions do not stand in", async () => {
    const { lead, elsewhere, sid, read, verify, t } = await seedTaskRun({ spawnedBy: true });
    const leadSid = await sid(lead);
    await t.run((ctx: any) => ctx.db.delete(elsewhere));
    expect((await read()).error).toMatch(/No session you can read is tied to ct-7/);
    expect((await verify({ conversation_short_id: leadSid, line: 2 }, "Yes, ship this")).error).toMatch(/not a session this change came through/);
  });

  test("a session that handed the task off is tied to it by its handoff comment alone", async () => {
    const { ana, lead, worker, sid, read, verify } = await seedTaskRun({ tie: "handoff" });
    expect((await read()).task.chain.map((h: any) => h.conversation_id)).toEqual([String(worker), String(lead)]);
    expect(await verify({ conversation_short_id: await sid(lead), line: 2 }, "Yes, ship this")).toMatchObject({ starter_id: String(ana) });
  });

  test("refuses a ship that someone other than the run's starter typed", async () => {
    const { lead, sid, read, verify } = await seedTaskRun({ starter: "eve" });
    const r = await read();
    expect(r.starter_name).toBe("Eve");
    // Eve reads Ana's "ship", and it is not hers to give.
    expect(r.typed.find((l: any) => l.text === "Yes, ship this once the tests pass.")?.user_name).toBe("Ana");
    expect((await verify({ conversation_short_id: await sid(lead), line: 2 }, "Yes, ship this")).error).toMatch(/was typed by Ana, not by Eve who started the run/);
  });

  test("a task no session is tied to has no read, and nothing clears it", async () => {
    const { lead, elsewhere, sid, read, verify } = await seedTaskRun({ tie: "none" });
    expect((await read()).error).toMatch(/No session you can read is tied to ct-7/);
    expect((await read("ct-999")).error).toMatch(/not found/);
    expect((await verify({ conversation_short_id: await sid(lead), line: 2 }, "Yes, ship this")).error).toMatch(/not a session this change came through/);
    expect((await verify({ conversation_short_id: await sid(elsewhere), line: 1 }, "ship it")).error).toMatch(/not a session this change came through/);
  });
});
