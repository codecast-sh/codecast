import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { allModules } from "./testModules.testkit";
import { hashToken } from "./apiTokens";
import { worktreeNameFor } from "./lib/taskLaunch";

const TOKEN = "e".repeat(64);
const T0 = 1_790_000_000_000;
const CHECKOUT = "/home/steven/src/widgets";

async function setup() {
  const t = convexTest(schema, allModules);
  const seeded = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Owner" } as any);
    const team = await ctx.db.insert("teams", { name: "Widgets", created_at: T0 } as any);
    await ctx.db.patch(owner, { team_id: team, active_team_id: team } as any);
    await ctx.db.insert("team_memberships", { user_id: owner, team_id: team, role: "admin", joined_at: T0 } as any);
    await ctx.db.insert("api_tokens", { user_id: owner, token_hash: await hashToken(TOKEN), name: "cli", created_at: T0, last_used_at: T0 } as any);
    await ctx.db.insert("directory_team_mappings", { user_id: owner, path_prefix: CHECKOUT, team_id: team, created_at: T0 } as any);
    await ctx.db.insert("devices", { user_id: owner, device_id: "dev_linux", label: "Linux - box", platform: "linux", last_seen: T0 } as any);
    await ctx.db.insert("devices", { user_id: owner, device_id: "dev_mac", label: "macOS - mbp", platform: "darwin", last_seen: T0 } as any);
    const bot = await ctx.db.insert("users", { name: "Team box", is_bot: true, team_id: team } as any);
    await ctx.db.insert("devices", { user_id: bot, device_id: "dev_team_box", label: "Linux - shared", platform: "linux", last_seen: T0 } as any);
    await ctx.db.insert("agent_definitions", {
      user_id: owner, workspace: `user:${owner}`, short_id: "ad-1", name: "reviewer", description: "Reviews",
      system_prompt: "Review carefully.", model: "opus", created_at: T0, updated_at: T0,
    } as any);
    const project = await ctx.db.insert("projects", { user_id: owner, team_id: team, title: "Widgets", status: "active", project_path: CHECKOUT } as any);
    const task = await ctx.db.insert("tasks", {
      user_id: owner, team_id: team, workspace: `team:${team}`, project_id: project, short_id: "ct-1", title: "Add widgets",
      status: "open", task_type: "task", priority: "medium", source: "human", created_at: T0, updated_at: T0,
      external: { provider: "linear", id: "iss_1", identifier: "ENG-123", url: "https://linear.app/x/issue/ENG-123", remote_updated_at: T0, synced_at: T0 },
    } as any);
    const source = await ctx.db.insert("issue_sync_sources", {
      provider: "linear", kind: "linear_team", external_id: "team_abc", name: "Eng", project_id: project, user_id: owner,
      team_id: team, workspace: `team:${team}`, status: "active", auto_spawn: true, push_new_tasks: false, created_at: T0, updated_at: T0,
    } as any);
    return { owner, task, source };
  });
  return { t, ...seeded };
}

const startRows = (t: any) => t.run(async (ctx: any) => {
  const rows = await ctx.db.query("daemon_commands").collect();
  return rows.filter((r: any) => r.command === "start_session").map((r: any) => ({ ...r, args: JSON.parse(r.args) }));
});
const commentsOn = (t: any, task: any) => t.run(async (ctx: any) =>
  ctx.db.query("task_comments").withIndex("by_task_id", (q: any) => q.eq("task_id", task)).collect());

describe("worktreeNameFor", () => {
  test("lowercases a Linear identifier", () => expect(worktreeNameFor("ENG-123")).toBe("eng-123"));
  test("flattens a GitHub identifier", () => expect(worktreeNameFor("owner/repo#12")).toBe("owner-repo-12"));
  test("two long identifiers that differ only in the number stay distinct and valid", () => {
    const long = (n: number) => worktreeNameFor(`some-organisation/a-very-long-repository-name-that-overflows-the-limit#${n}`);
    const [a, b] = [long(101), long(202)];
    expect(a).not.toBe(b);
    for (const name of [a, b]) expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
  });
  test("collapses dot runs so the branch name stays valid", () => expect(worktreeNameFor("acme/foo..bar#1")).toBe("acme-foo.bar-1"));
  test("stays inside the daemon's cloud pattern", () => {
    const name = worktreeNameFor(`A${"b".repeat(100)}`);
    expect(name).toHaveLength(64);
    expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
  });
});

describe("spawnSessionForTaskInternal", () => {
  test("isolation, device and definition ride the start_session row", async () => {
    const { t, task, owner } = await setup();
    await t.mutation(internal.tasks.spawnSessionForTaskInternal, {
      task_id: task, user_id: owner, isolated: true, target_device_id: "dev_mac", definition: "reviewer",
    });
    const [row] = await startRows(t);
    expect(row.target_device_id).toBe("dev_mac");
    expect(row.args.isolated).toBe(true);
    expect(row.args.worktree_name).toBe("eng-123");
    expect(row.args.definition.name).toBe("reviewer");
    expect(row.args.model).toBe("opus");
  });

  test("with no options the row carries none, as before", async () => {
    const { t, task, owner } = await setup();
    await t.mutation(internal.tasks.spawnSessionForTaskInternal, { task_id: task, user_id: owner });
    const [row] = await startRows(t);
    expect(row.args.isolated).toBeUndefined();
    expect(row.args.worktree_name).toBeUndefined();
    expect(row.args.definition).toBeUndefined();
  });

  test("an explicit worktree name wins over the identifier", async () => {
    const { t, task, owner } = await setup();
    await t.mutation(internal.tasks.spawnSessionForTaskInternal, { task_id: task, user_id: owner, isolated: true, worktree_name: "mine" });
    expect((await startRows(t))[0].args.worktree_name).toBe("mine");
  });

  test("an unknown definition starts nothing and leaves one note, however often it is retried", async () => {
    const { t, task, owner } = await setup();
    const run = () => t.mutation(internal.tasks.spawnSessionForTaskInternal, { task_id: task, user_id: owner, isolated: true, definition: "gone" });
    expect(await run()).toBeNull();
    expect(await run()).toBeNull();
    expect(await startRows(t)).toEqual([]);
    const notes = await commentsOn(t, task);
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toContain('"gone"');
    expect(notes[0].external).toBeUndefined();
    const sessions = await t.run(async (ctx) => (await ctx.db.query("conversations").collect()).length);
    expect(sessions).toBe(0);
  });
});

describe("spawnForTask", () => {
  test("--device resolves a name of the caller's own devices", async () => {
    const { t } = await setup();
    await t.mutation(api.tasks.spawnForTask, { api_token: TOKEN, short_id: "ct-1", device: "Linux - box", isolated: true, definition: "reviewer" });
    const [row] = await startRows(t);
    expect(row.target_device_id).toBe("dev_linux");
    expect(row.args.isolated).toBe(true);
    expect(row.args.definition.name).toBe("reviewer");
  });

  test("--device naming the caller's own cloud host parks the session for placement", async () => {
    const { t } = await setup();
    await t.run(async (ctx) => {
      const mac = await ctx.db.query("devices").filter((q) => q.eq(q.field("device_id"), "dev_mac")).first();
      await ctx.db.patch(mac!._id, { local_project_roots: [CHECKOUT] } as any);
      const owner = mac!.user_id;
      await ctx.db.insert("devices", {
        user_id: owner, device_id: "dev_cloud", label: "Cloud Linux", platform: "linux", is_remote: true, last_seen: 0,
        local_project_roots: ["/home/ubuntu/work"], cloud_host: { managed_by: "laptop", state: "stopped", at: T0 },
      } as any);
    });
    await t.mutation(api.tasks.spawnForTask, { api_token: TOKEN, short_id: "ct-1", device: "Cloud Linux" });
    expect(await startRows(t)).toEqual([]);
    expect(await conversationsOf(t)).toMatchObject([{ cloud_placement: "pending", owner_device_id: "dev_cloud" }]);
  });

  test("a team machine is refused, naming it", async () => {
    const { t } = await setup();
    await expect(t.mutation(api.tasks.spawnForTask, { api_token: TOKEN, short_id: "ct-1", device: "dev_team_box" })).rejects.toThrow(/dev_team_box.*team machine/);
    expect(await startRows(t)).toEqual([]);
  });

  test("an unknown device is refused", async () => {
    const { t } = await setup();
    await expect(t.mutation(api.tasks.spawnForTask, { api_token: TOKEN, short_id: "ct-1", device: "nowhere" })).rejects.toThrow(/Unknown device/);
  });

  test("an unknown definition is refused", async () => {
    const { t } = await setup();
    await expect(t.mutation(api.tasks.spawnForTask, { api_token: TOKEN, short_id: "ct-1", definition: "gone" })).rejects.toThrow(/No agent definition named "gone"/);
    expect(await startRows(t)).toEqual([]);
  });
});

const addDefinition = (t: any, owner: any, name: string, fields: Record<string, unknown>) => t.run((ctx: any) =>
  ctx.db.insert("agent_definitions", {
    user_id: owner, workspace: `user:${owner}`, short_id: `ad-${name}`, name, description: name,
    created_at: T0, updated_at: T0, ...fields,
  }));
const conversationsOf = (t: any) => t.run((ctx: any) => ctx.db.query("conversations").collect());

describe("launch precedence", () => {
  test("the task's model and effort beat the definition's", async () => {
    const { t, task, owner } = await setup();
    await addDefinition(t, owner, "pinned", { model: "opus", effort: "low" });
    await t.run((ctx) => ctx.db.patch(task, { model: "sonnet", effort: "high" } as any));
    await t.mutation(api.tasks.spawnForTask, { api_token: TOKEN, short_id: "ct-1", definition: "pinned" });
    const [row] = await startRows(t);
    expect(row.args.model).toBe("sonnet");
    expect(row.args.effort).toBe("high");
  });

  test("an explicit agent type beats the definition's agent", async () => {
    const { t, owner } = await setup();
    await addDefinition(t, owner, "claudey", { agent: "claude", model: "opus" });
    await t.mutation(api.tasks.spawnForTask, { api_token: TOKEN, short_id: "ct-1", definition: "claudey", agent_type: "codex" });
    const [row] = await startRows(t);
    expect(row.args.agent_type).toBe("codex");
    expect((await conversationsOf(t))[0].agent_type).toBe("codex");
  });

  test("a definition with isolated true isolates the spawn and names the worktree", async () => {
    const { t, owner } = await setup();
    await addDefinition(t, owner, "iso", { isolated: true });
    await t.mutation(api.tasks.spawnForTask, { api_token: TOKEN, short_id: "ct-1", definition: "iso" });
    const [row] = await startRows(t);
    expect(row.args.isolated).toBe(true);
    expect(row.args.worktree_name).toBe("eng-123");
  });
});

describe("cliUpdateSource spawn defaults", () => {
  test("a device name is stored as the owner's device id, and an empty value clears it with the definition", async () => {
    const { t, source } = await setup();
    await t.mutation(api.issueSync.cliUpdateSource, { api_token: TOKEN, id: source, device: "macOS - mbp", definition: " reviewer ", spawn_isolated: false });
    const stored = await t.run((ctx) => ctx.db.get(source));
    expect(stored).toMatchObject({ spawn_device: "dev_mac", spawn_definition: "reviewer", spawn_isolated: false });
    await t.mutation(api.issueSync.cliUpdateSource, { api_token: TOKEN, id: source, device: "", definition: "" });
    const cleared = await t.run((ctx) => ctx.db.get(source));
    expect(cleared?.spawn_device).toBeUndefined();
    expect(cleared?.spawn_definition).toBeUndefined();
    expect(cleared?.spawn_isolated).toBe(false);
  });

  test("a team machine is refused", async () => {
    const { t, source } = await setup();
    await expect(t.mutation(api.issueSync.cliUpdateSource, { api_token: TOKEN, id: source, device: "dev_team_box" })).rejects.toThrow(/team machine/);
  });

  test("an unknown device is refused and nothing is stored", async () => {
    const { t, source } = await setup();
    await expect(t.mutation(api.issueSync.cliUpdateSource, { api_token: TOKEN, id: source, device: "nowhere" })).rejects.toThrow(/Unknown device/);
    expect((await t.run((ctx) => ctx.db.get(source)))?.spawn_device).toBeUndefined();
  });

  describe("a team member who is not the source's owner", () => {
    const MEMBER_TOKEN = "f".repeat(64);
    const addMember = async (t: any, source: any) => t.run(async (ctx: any) => {
      const row = await ctx.db.get(source);
      const member = await ctx.db.insert("users", { name: "Member", team_id: row.team_id, active_team_id: row.team_id } as any);
      await ctx.db.insert("team_memberships", { user_id: member, team_id: row.team_id, role: "member", joined_at: T0 } as any);
      await ctx.db.insert("api_tokens", { user_id: member, token_hash: await hashToken(MEMBER_TOKEN), name: "cli", created_at: T0, last_used_at: T0 } as any);
      await ctx.db.insert("devices", { user_id: member, device_id: "dev_member", label: "Member laptop", platform: "linux", last_seen: T0 } as any);
    });

    test("cannot set the definition, and nothing is stored", async () => {
      const { t, source } = await setup();
      await addMember(t, source);
      await expect(t.mutation(api.issueSync.cliUpdateSource, { api_token: MEMBER_TOKEN, id: source, definition: "reviewer", auto_spawn: false })).rejects.toThrow(/only the source's owner/);
      const stored = await t.run((ctx) => ctx.db.get(source));
      expect(stored?.spawn_definition).toBeUndefined();
      expect(stored?.auto_spawn).toBe(true);
    });

    test("setting the device to the owner's label stores the owner's device id", async () => {
      const { t, source } = await setup();
      await addMember(t, source);
      await t.mutation(api.issueSync.cliUpdateSource, { api_token: MEMBER_TOKEN, id: source, device: "macOS - mbp" });
      expect((await t.run((ctx) => ctx.db.get(source)))?.spawn_device).toBe("dev_mac");
    });

    test("setting the device to their own label is refused as unknown", async () => {
      const { t, source } = await setup();
      await addMember(t, source);
      await expect(t.mutation(api.issueSync.cliUpdateSource, { api_token: MEMBER_TOKEN, id: source, device: "Member laptop" })).rejects.toThrow(/Unknown device/);
      expect((await t.run((ctx) => ctx.db.get(source)))?.spawn_device).toBeUndefined();
    });
  });
});
