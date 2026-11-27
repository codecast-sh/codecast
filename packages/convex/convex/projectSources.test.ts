import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { allModules } from "./testModules.testkit";
import { CHAT_COALESCE_MS } from "./agentTasks";

afterEach(() => setSystemTime());

async function seed(opts: { mainSession?: boolean } = {}) {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const user = await ctx.db.insert("users", { name: "Ada", email: "ada@example.com" } as any);
    const outsider = await ctx.db.insert("users", { name: "Eve", email: "eve@example.com" } as any);
    const team = await ctx.db.insert("teams", { name: "Main", invite_code: "MAIN", created_at: 1, features: { chat: true } } as any);
    await ctx.db.insert("team_memberships", { user_id: user, team_id: team, role: "admin", joined_at: now } as any);
    const channel = await ctx.db.insert("chat_channels", { team_id: team, name: "intake", created_by: user, created_at: now } as any);
    const other = await ctx.db.insert("chat_channels", { team_id: team, name: "random", created_by: user, created_at: now } as any);
    const project = await ctx.db.insert("projects", { user_id: user, workspace: `user:${user}`, title: "Sources test", status: "active", project_path: "/tmp/sources-test", created_at: now, updated_at: now } as any);
    let main: any = null;
    if (opts.mainSession !== false) {
      main = await ctx.db.insert("conversations", { user_id: user, session_id: "main-session", agent_type: "claude_code", started_at: now, updated_at: now, message_count: 0, status: "active", is_private: true, project_id: project } as any);
      await ctx.db.patch(main, { short_id: String(main).slice(0, 7) });
      await ctx.db.patch(project, { default_session_id: main });
    }
    return { user, outsider, team, channel, other, project, main };
  });
  const as = t.withIdentity({ subject: ids.user });
  return { t, as, ...ids };
}

const pendingIn = (t: any, conversation: any) =>
  t.run(async (ctx: any) => (await ctx.db.query("pending_messages").collect()).filter((m: any) => String(m.conversation_id) === String(conversation)));

// A line, and the trigger match it schedules (runAfter 0). That job runs on
// convex-test's real timers, and on a loaded machine it had not started 5 ms
// later, so the line's run was missing when the test looked: wait until no
// job scheduled to run at once is still waiting.
async function say(as: any, channel: any, content: string, extra: Record<string, unknown> = {}) {
  await as.mutation(api.chat.sendMessage, { channel_id: channel, content, ...extra });
  for (let i = 0; i < 1000; i++) {
    await new Promise((r) => setTimeout(r, 5));
    await as.finishInProgressScheduledFunctions();
    const waiting = await as.run(async (ctx: any) => (await ctx.db.system.query("_scheduled_functions").collect())
      .some((j: any) => j.state.kind === "pending" && j.scheduledTime - j._creationTime < 1000));
    if (!waiting) return;
  }
}

/** Past the coalescing window, the firing the first line scheduled. */
async function fire(t: any, task: any) {
  setSystemTime(new Date(Date.now() + CHAT_COALESCE_MS + 1000));
  return await t.mutation(internal.projectSources.fireProjectTrigger, { task_id: task });
}

describe("project sources", () => {
  test("two lines in a burst are one run in the project's main session, carrying both", async () => {
    const { t, as, channel, other, project, main } = await seed();
    const { id } = await as.mutation(api.projectSources.webAddSource, { project_id: project, channel_id: String(channel) });
    await say(as, channel, "first line");
    await say(as, channel, "second line");
    await say(as, other, "elsewhere");
    expect(await pendingIn(t, main)).toHaveLength(0);
    expect(await fire(t, id)).toBe(main);
    const pending = await pendingIn(t, main);
    expect(pending).toHaveLength(1);
    expect(pending[0].content).toContain("first line");
    expect(pending[0].content).toContain("second line");
    expect(pending[0].content).not.toContain("elsewhere");
    const task = await t.run((ctx) => ctx.db.get(id));
    expect(task!.run_count).toBe(1);
    expect(task!.pending_events).toBeUndefined();
    expect(task!.originating_conversation_id).toBeUndefined();
  });

  test("a line the main session wrote itself wakes nothing", async () => {
    const { t, as, channel, project, main } = await seed();
    const { id } = await as.mutation(api.projectSources.webAddSource, { project_id: project, channel_id: String(channel) });
    await say(as, channel, "my own report", { origin: "agent", origin_session_id: String(main) });
    expect(await fire(t, id)).toBeNull();
    expect(await pendingIn(t, main)).toHaveLength(0);
  });

  test("a line another project's agent session posts wakes no source, so two projects never wake each other", async () => {
    const { t, as, user, channel, project, main } = await seed();
    const otherMain = await t.run((ctx) => ctx.db.insert("conversations", { user_id: user, session_id: "other-main", agent_type: "claude_code", started_at: Date.now(), updated_at: Date.now(), message_count: 0, status: "active", is_private: true } as any));
    await as.mutation(api.projectSources.webAddSource, { project_id: project, channel_id: String(channel) });
    await as.mutation(api.chat.sendMessage, { channel_id: channel, content: "the other agent's report", origin: "agent", origin_session_id: String(otherMain) });
    const scheduled = await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((f: any) => f.name.includes("matchTaskTriggers")).length);
    expect(scheduled).toBe(0);
    expect(await pendingIn(t, main)).toHaveLength(0);
  });

  test("a line in a channel no source watches schedules no match", async () => {
    const { t, as, channel, other, project } = await seed();
    await as.mutation(api.projectSources.webAddSource, { project_id: project, channel_id: String(channel) });
    await as.mutation(api.chat.sendMessage, { channel_id: other, content: "elsewhere" });
    const matches = async () => t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((f: any) => f.name.includes("matchTaskTriggers")).length);
    expect(await matches()).toBe(0);
    await as.mutation(api.chat.sendMessage, { channel_id: channel, content: "watched" });
    expect(await matches()).toBe(1);
  });

  test("the panel lists a teammate's source of the project, read only; a stranger reads none", async () => {
    const { t, as, user, outsider, project, channel } = await seed();
    await as.mutation(api.projectSources.webAddSource, { project_id: project, channel_id: String(channel) });
    await t.run((ctx) => ctx.db.insert("agent_tasks", { user_id: outsider, title: "PR opened", prompt: "x", schedule_type: "event", status: "scheduled", run_count: 2, project_id: project, event_filter: { event_type: "pr_opened" }, created_at: 0, updated_at: 0 } as any));
    const rows = await as.query(api.projectSources.teammateSources, { project_id: project });
    expect(rows.map((r: any) => [r.event_filter.event_type, r.owner_name, r.run_count])).toEqual([["pr_opened", "Eve", 2]]);
    expect(await t.withIdentity({ subject: outsider }).query(api.projectSources.teammateSources, { project_id: project })).toEqual([]);
    void user;
  });

  test("a teammate's live source shows past a pile of finished one-shot triggers, and one on a channel the viewer cannot open does not", async () => {
    const { t, as, outsider, project, team } = await seed();
    await t.run(async (ctx) => {
      const row = (extra: Record<string, unknown>) => ctx.db.insert("agent_tasks", { user_id: outsider, title: "x", prompt: "x", schedule_type: "event", run_count: 0, project_id: project, created_at: 0, updated_at: 0, ...extra } as any);
      await row({ status: "scheduled", title: "live", event_filter: { event_type: "pr_opened" } });
      for (let i = 0; i < 120; i++) await row({ status: "completed", event_filter: { event_type: "pr_opened" } });
      const secret = await ctx.db.insert("chat_channels", { team_id: team, name: "exec", kind: "private", created_by: outsider, created_at: 0 } as any);
      await row({ status: "scheduled", title: "#exec", event_filter: { event_type: "chat_message", channel_id: String(secret) } });
    });
    const rows = await as.query(api.projectSources.teammateSources, { project_id: project });
    expect(rows.map((r: any) => r.title)).toEqual(["live"]);
  });

  test("a person's line in a watched channel still schedules a match", async () => {
    const { t, as, channel, project } = await seed();
    await as.mutation(api.projectSources.webAddSource, { project_id: project, channel_id: String(channel) });
    await as.mutation(api.chat.sendMessage, { channel_id: channel, content: "from a person" });
    const n = await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((f: any) => f.name.includes("matchTaskTriggers")).length);
    expect(n).toBe(1);
  });

  test("pausing the project quiets its sources; resuming wakes only those it paused", async () => {
    const { t, as, channel, project, main } = await seed();
    const { id } = await as.mutation(api.projectSources.webAddSource, { project_id: project, channel_id: String(channel) });
    const { id: byHand } = await as.mutation(api.projectSources.webAddSource, { project_id: project, event: "pr_opened" });
    await as.mutation(api.agentTasks.webPause, { task_id: byHand });

    await as.mutation(api.projects.webUpdate, { id: project, status: "paused" });
    let task = await t.run((ctx) => ctx.db.get(id));
    expect(task!.status).toBe("paused");
    expect(String(task!.paused_by_project_id)).toBe(String(project));
    await say(as, channel, "while paused");
    expect(await fire(t, id)).toBeNull();
    expect(await pendingIn(t, main)).toHaveLength(0);

    await as.mutation(api.projects.webUpdate, { id: project, status: "active" });
    task = await t.run((ctx) => ctx.db.get(id));
    expect(task!.status).toBe("scheduled");
    expect(task!.paused_by_project_id).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(byHand)))!.status).toBe("paused");

    await say(as, channel, "after resume");
    expect(await fire(t, id)).toBe(main);
    const pending = await pendingIn(t, main);
    expect(pending).toHaveLength(1);
    expect(pending[0].content).toContain("after resume");
    expect(pending[0].content).not.toContain("while paused");
  });

  test("with no main session yet, the first run starts one as the project's default", async () => {
    const { t, as, channel, project } = await seed({ mainSession: false });
    const { id } = await as.mutation(api.projectSources.webAddSource, { project_id: project, channel_id: String(channel) });
    await say(as, channel, "hello project");
    const started = await fire(t, id);
    expect(started).toBeTruthy();
    const p = await t.run((ctx) => ctx.db.get(project));
    expect(String(p!.default_session_id)).toBe(String(started));
    const conv = await t.run((ctx) => ctx.db.get(started));
    expect(String(conv!.project_id)).toBe(String(project));
    expect((await pendingIn(t, started))[0].content).toContain("hello project");
  });

  test("a channel the owner cannot read is refused at save", async () => {
    const { t, channel, project, outsider } = await seed();
    await t.run((ctx) => ctx.db.patch(project, { workspace: `user:${outsider}`, user_id: outsider }));
    const eve = t.withIdentity({ subject: outsider });
    await expect(eve.mutation(api.projectSources.webAddSource, { project_id: project, channel_id: String(channel) })).rejects.toThrow(/No channel you can read/);
  });
  test("a trigger resumed by hand in a paused project does not fire into it", async () => {
    const { t, as, channel, project, main } = await seed();
    const { id } = await as.mutation(api.projectSources.webAddSource, { project_id: project, channel_id: String(channel) });
    await as.mutation(api.projects.webUpdate, { id: project, status: "paused" });
    await as.mutation(api.agentTasks.webResume, { task_id: id });
    await say(as, channel, "sneaks past the pause");
    expect(await fire(t, id)).toBeNull();
    expect(await pendingIn(t, main)).toHaveLength(0);
    const task = await t.run((ctx) => ctx.db.get(id));
    expect(task!.status).toBe("paused");
    expect(String(task!.paused_by_project_id)).toBe(String(project));
  });

  test("a line landing after the window's end but before its late firing joins that run", async () => {
    const { t, as, channel, project, main } = await seed();
    const { id } = await as.mutation(api.projectSources.webAddSource, { project_id: project, channel_id: String(channel) });
    await say(as, channel, "before the end");
    const due = (await t.run((ctx) => ctx.db.get(id)))!.run_at!;
    setSystemTime(new Date(due + 5_000));
    // The window's firing never ran, so this line joins it and wakes it.
    await say(as, channel, "after the end");
    const runs = await pendingIn(t, main);
    expect(runs).toHaveLength(1);
    const [run] = runs;
    expect(run.content).toContain("before the end");
    expect(run.content).toContain("after the end");
  });

  test("a project whose main session a teammate runs refuses an inline source", async () => {
    const { t, as, channel, project, main, outsider } = await seed();
    await t.run((ctx) => ctx.db.patch(main, { user_id: outsider }));
    await expect(as.mutation(api.projectSources.webAddSource, { project_id: project, channel_id: String(channel) })).rejects.toThrow(/not run by this trigger's owner/);
  });

  test("a channel named by #name is resolved and the source is titled after it", async () => {
    const { t, as, project } = await seed();
    const { id } = await as.mutation(api.projectSources.webAddSource, { project_id: project, channel_id: "#intake" });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row!.title).toBe("#intake");
  });

  test("a firing that never took its events is woken again by the next line", async () => {
    const { t, as, channel, project, main } = await seed();
    const { id } = await as.mutation(api.projectSources.webAddSource, { project_id: project, channel_id: String(channel) });
    await say(as, channel, "stranded line");
    // The firing threw and rolled back: run_at passed, the events stayed.
    const due = (await t.run((ctx) => ctx.db.get(id)))!.run_at!;
    setSystemTime(new Date(due + 60_000));
    const before = await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((f: any) => f.name.includes("fireProjectTrigger") && f.state.kind === "pending").length);
    await as.mutation(api.chat.sendMessage, { channel_id: channel, content: "next line" });
    await new Promise((r) => setTimeout(r, 5));
    await as.finishInProgressScheduledFunctions();
    const after = await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((f: any) => f.name.includes("fireProjectTrigger")).length);
    expect(after).toBeGreaterThan(before);
    await t.mutation(internal.projectSources.fireProjectTrigger, { task_id: id });
    const runs = await pendingIn(t, main);
    expect(runs.map((r: any) => r.content).join("\n")).toContain("stranded line");
    expect(runs.map((r: any) => r.content).join("\n")).toContain("next line");
  });

  test("a team project watches only its own team's public channels; nobody watches a community room", async () => {
    const { t, as, user, team, channel, project } = await seed();
    const ids = await t.run(async (ctx) => {
      const now = Date.now();
      const secret = await ctx.db.insert("chat_channels", { team_id: team, name: "exec", kind: "private", created_by: user, created_at: now } as any);
      await ctx.db.insert("chat_channel_members", { channel_id: secret, user_id: user, joined_at: now } as any);
      const otherTeam = await ctx.db.insert("teams", { name: "Other", invite_code: "OTHER", created_at: 1, features: { chat: true } } as any);
      await ctx.db.insert("team_memberships", { user_id: user, team_id: otherTeam, role: "admin", joined_at: now } as any);
      const foreign = await ctx.db.insert("chat_channels", { team_id: otherTeam, name: "theirs", created_by: user, created_at: now } as any);
      await ctx.db.patch(project, { workspace: `team:${team}`, team_id: team });
      return { secret, foreign };
    });
    await expect(as.mutation(api.projectSources.webAddSource, { project_id: project, channel_id: String(ids.secret) })).rejects.toThrow(/private channel/);
    await expect(as.mutation(api.projectSources.webAddSource, { project_id: project, channel_id: String(ids.foreign) })).rejects.toThrow(/own team's channels/);
    await as.mutation(api.projectSources.webAddSource, { project_id: project, channel_id: String(channel) });
  });
});
