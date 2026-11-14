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

// A line, and the trigger match it schedules (runAfter 0).
async function say(as: any, channel: any, content: string, extra: Record<string, unknown> = {}) {
  await as.mutation(api.chat.sendMessage, { channel_id: channel, content, ...extra });
  await new Promise((r) => setTimeout(r, 5));
  await as.finishInProgressScheduledFunctions();
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
});
