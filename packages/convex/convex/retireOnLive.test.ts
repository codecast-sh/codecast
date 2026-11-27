import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";
import { allModules } from "./testModules.testkit";
import { stampMainOrder } from "./deployTargetsCi";
import { recordDeployMarker } from "./deploys";
import { completeLiveRuns } from "./deployCarries";
import { liveRetireRefusal, repoPathOf } from "./retireOnLive";

setDefaultTimeout(60_000);

// A session whose own change is live on every target it touches is a candidate when the deploy that took it there
// goes live, however it shipped; its daemon is asked to confirm against the real checkout and retire it
// (retireOnLive.ts). Synthetic data only.

const REPO = "acme/app";
const ROOT = "/work/app";
const NOW = Date.now();
const DAY = 86_400_000;
const sha = (n: number) => `${n.toString(16).padStart(2, "0")}ab`.repeat(10);
const file = (filename: string) => ({ filename, status: "modified", additions: 1, deletions: 0, changes: 1 });

/** How a commit is the session's: its own commit row records the sha, its trailer names it, or only a branch guess linked it. */
type Own = "row" | "trailer" | "guess";

async function world(subject: Record<string, unknown> = {}) {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { name: "Ana" } as any);
    const team = await ctx.db.insert("teams", { name: "Acme", created_at: 1 } as any);
    await ctx.db.insert("team_memberships", { team_id: team, user_id: user, role: "member", joined_at: 1 } as any);
    const workspace = `team:${team}`;
    for (const name of ["web", "api"]) {
      await ctx.db.insert("deploy_targets", { workspace, team_id: team, repository: REPO, name, runs: "push", live: { kind: "marker" }, policy: "press", paths: [`${name}/**`], publisher_user_id: user, published_at: NOW - 100 * DAY } as any);
    }
    const conv = await ctx.db.insert("conversations", {
      user_id: user, team_id: team, agent_type: "claude_code", started_at: NOW - 100_000, updated_at: NOW - 50_000, status: "active", short_id: "jx7subj", session_id: "s-subj", owner_device_id: "dev-1", title: "Fix checkout", message_count: 12, git_root: ROOT,
      // It pinned done, as a session that shipped does.
      thread_state: "Shipped", thread_state_status: "done", thread_state_at: NOW - 40_000, thread_state_msg_count: 12,
      last_person_turn_at: NOW - 90_000, ...subject,
    } as any);
    return { user, team, workspace, conv };
  });
  const changeRow = (conv: any, path: string, at: number, extra: Record<string, unknown> = {}) => t.run(async (ctx) => {
    const message = await ctx.db.insert("messages", { conversation_id: conv, message_uuid: `m-${path}-${at}-${Math.random()}`, role: "assistant", content: "editing", timestamp: at } as any);
    await ctx.db.insert("file_changes", { conversation_id: conv, change_key: `${path}:${at}:${Math.random()}`, message_id: message, seq: 0, file_path: path, change_type: "edit", timestamp: at, ...extra } as any);
  });
  /** A commit the session made, on main at `n`, at `at`. */
  const commit = (n: number, files: string[], opts: { at?: number; onMain?: boolean; own?: Own; conv?: any } = {}) => t.run(async (ctx) => {
    const { at = NOW - 60_000, onMain = true, own = "row" } = opts;
    const conv = "conv" in opts ? opts.conv ?? undefined : ids.conv;
    const message = own === "trailer" ? `change ${n}\n\nCodecast-Session: https://codecast.sh/conversation/${conv}` : `change ${n}`;
    const id = await ctx.db.insert("commits", { conversation_id: conv, sha: sha(n), message, author_name: "Ana", author_email: "a@x", timestamp: at, files_changed: files.length, insertions: 1, deletions: 0, repository: REPO, team_id: ids.team, branch: onMain ? "main" : "fix", files: files.map(file) } as any);
    if (onMain) await stampMainOrder(ctx, [id], NOW - 50_000 + n);
    return id;
  }).then(async (id) => {
    if ((opts.own ?? "row") === "row") await changeRow(opts.conv ?? ids.conv, ROOT, opts.at ?? NOW - 60_000, { change_type: "commit", commit_hash: sha(n).slice(0, 9) });
    return id;
  });
  const edit = (path: string, at = NOW - 70_000) => changeRow(ids.conv, path.startsWith("/") ? path : `${ROOT}/${path}`, at);
  /** A live deploy of `target` at main commit `n`; returns its id. */
  const deploy = (target: string, n: number, at = NOW) => t.run(async (ctx) => {
    const short = await recordDeployMarker(ctx, { workspace: ids.workspace, team_id: ids.team, target, sha: sha(n), repository: REPO, source: "m", status: "live", at });
    return (await ctx.db.query("deploys").withIndex("by_workspace_created", (q: any) => q.eq("workspace", ids.workspace)).collect()).find((d: any) => d.short_id === short)!._id;
  });
  const retireOn = async (deployId: any) => {
    const { sessions } = await t.mutation(internal.retireOnLive.retireSessionsOnLive, { deploy: deployId });
    return Promise.all(sessions.map((id: string) => t.mutation(internal.retireOnLive.retireSessionOnLive, { conversation: id as any, workspace: ids.workspace })));
  };
  const asks = () => t.run(async (ctx) => (await ctx.db.query("daemon_commands").collect()).filter((c: any) => c.command === "retire_on_live").map((c: any) => ({ ...c, parsed: JSON.parse(c.args) })));
  const row = () => t.run(async (ctx) => (await ctx.db.get(ids.conv)) as any);
  const refusal = (workspace?: string) => t.run(async (ctx) => liveRetireRefusal(ctx, (await ctx.db.get(ids.conv))!, Date.now(), { workspace }));
  return { t, ids, commit, edit, changeRow, deploy, retireOn, asks, row, refusal };
}

describe("a deploy going live asks the daemon of each session whose own change it takes live everywhere to retire it", () => {
  test("a pull request merged by hand: its session's commit is live on the one target it touches, so its daemon is asked, once", async () => {
    const w = await world();
    await w.edit("web/a.tsx");
    await w.commit(1, ["web/a.tsx"]);
    expect(await w.refusal()).toBe("its change is not live yet on web");
    const d = await w.deploy("web", 1);
    expect(await w.retireOn(d)).toEqual([{ asked: true }]);
    // Asked, never killed here: the daemon decides.
    expect((await w.row()).inbox_killed_at).toBeUndefined();
    const [ask] = await w.asks();
    expect(ask.target_device_id).toBe("dev-1");
    expect(ask.parsed).toEqual({ conversation_id: String(w.ids.conv), session_id: "s-subj", root: ROOT, since: NOW - 60_000, commits: [{ sha: sha(1), main_at: expect.any(Number) }] });
    // A second pass while the ask is pending asks nothing more.
    expect(await w.retireOn(d)).toEqual([{ asked: true }]);
    expect(await w.asks()).toHaveLength(1);
  });

  test("the deploy's own live write schedules the pass", async () => {
    const w = await world();
    await w.commit(1, ["web/a.tsx"]);
    await w.deploy("web", 1);
    for (let i = 0; i < 100 && !(await w.asks()).length; i++) {
      await new Promise((r) => setTimeout(r, 20));
      await w.t.finishInProgressScheduledFunctions();
    }
    expect(await w.asks()).toHaveLength(1);
  });

  test("a target's first live deploy reads only its own commit's session, not all of main before it", async () => {
    const w = await world();
    await w.commit(1, ["web/a.tsx"]);
    const other = await w.t.run(async (ctx) => ctx.db.insert("conversations", { user_id: w.ids.user, agent_type: "claude_code", started_at: NOW - 100_000, updated_at: NOW - 50_000, status: "active", title: "Other", message_count: 2 } as any));
    await w.commit(2, ["web/b.tsx"], { conv: other });
    const { sessions } = await w.t.mutation(internal.retireOnLive.retireSessionsOnLive, { deploy: await w.deploy("web", 2) });
    expect(sessions).toEqual([String(other)]);
  });

  test("only done counts: a session asking, or dormant on a wake of its own, is kept", async () => {
    const asking = await world({ thread_state_status: undefined, thread_state: undefined });
    await asking.commit(1, ["web/a.tsx"]);
    expect(await asking.retireOn(await asking.deploy("web", 1))).toEqual([{ asked: false, reason: "it is not done (needs_input)" }]);

    // A snoozed session waits on its own wake: dormant.
    const dormant = await world({ inbox_snoozed_until: NOW + DAY });
    await dormant.commit(1, ["web/a.tsx"]);
    expect(await dormant.retireOn(await dormant.deploy("web", 1))).toEqual([{ asked: false, reason: "it is not done (dormant)" }]);
    expect(await dormant.asks()).toHaveLength(0);
  });

  test("one target its change touches is not live yet: kept, then asked once it is", async () => {
    const w = await world();
    await w.commit(1, ["web/a.tsx"]);
    await w.commit(2, ["api/b.ts"]);
    expect(await w.retireOn(await w.deploy("web", 2))).toEqual([{ asked: false, reason: "its change is not live yet on api" }]);
    expect(await w.retireOn(await w.deploy("api", 2))).toEqual([{ asked: true }]);
  });

  test("a dormant target does not count as live: the change has not shipped there", async () => {
    const w = await world();
    // api shipped last nine days ago, at a commit of someone else's.
    await w.commit(0, ["api/old.ts"], { own: "guess", conv: null });
    await w.deploy("api", 0, NOW - 9 * DAY);
    await w.commit(1, ["web/a.tsx", "api/b.ts"]);
    expect(await w.retireOn(await w.deploy("web", 1))).toEqual([{ asked: false, reason: "its change is not live yet on api" }]);
  });

  test("a person wrote to it after its own last edit or commit, though main's squash is stamped later: kept", async () => {
    const w = await world({ last_person_turn_at: NOW - 10_000 });
    await w.edit("web/a.tsx", NOW - 70_000);
    // The squash on main names it by trailer and carries landing time, after the person's message.
    await w.commit(1, ["web/a.tsx"], { own: "trailer", at: NOW - 5_000 });
    expect(await w.retireOn(await w.deploy("web", 1))).toEqual([{ asked: false, reason: "a person wrote to it after its own work" }]);
  });

  test("a commit only guessed onto it (the session sat on the branch) is not its work", async () => {
    const w = await world();
    await w.commit(1, ["web/a.tsx"], { own: "guess" });
    expect(await w.retireOn(await w.deploy("web", 1))).toEqual([{ asked: false, reason: "none of its own commits is on main" }]);
    // Named by its trailer, the same commit is.
    const named = await world();
    await named.edit("web/a.tsx");
    await named.commit(1, ["web/a.tsx"], { own: "trailer" });
    expect(await named.retireOn(await named.deploy("web", 1))).toEqual([{ asked: true }]);
  });

  test("an edit no commit of its own on main holds keeps it: one made after the commit, or committed only on a branch", async () => {
    const after = await world();
    await after.commit(1, ["web/a.tsx"]);
    await after.edit("web/a.tsx", NOW - 30_000);
    await after.edit("api/new.ts", NOW - 30_000);
    expect(await after.retireOn(await after.deploy("web", 1))).toEqual([{ asked: false, reason: "it has changes not on main: web/a.tsx, api/new.ts" }]);

    const branch = await world();
    await branch.edit("web/b.tsx");
    await branch.commit(1, ["web/a.tsx"]);
    await branch.commit(2, ["web/b.tsx"], { onMain: false });
    expect(await branch.retireOn(await branch.deploy("web", 1))).toEqual([{ asked: false, reason: "it has changes not on main: web/b.tsx" }]);
  });

  test("paths match exactly from the repository root: a nested file is not the root file of the same name", async () => {
    const w = await world();
    await w.edit("web/a.tsx");
    await w.commit(1, ["a.tsx"]);
    expect(await w.retireOn(await w.deploy("web", 1))).toEqual([{ asked: false, reason: "it has changes not on main: web/a.tsx" }]);
    // An edit in a worktree under the checkout names the repository path below it.
    expect(repoPathOf(`${ROOT}/.codecast/worktrees/fix/web/a.tsx`, ROOT)).toBe("web/a.tsx");
    expect(repoPathOf(`${ROOT}-other/web/a.tsx`, ROOT)).toBeNull();
  });

  test("a file it wrote outside its checkout is no part of the change", async () => {
    const w = await world();
    await w.commit(1, ["web/a.tsx"]);
    await w.edit("/tmp/notes.md", NOW - 70_000);
    expect(await w.retireOn(await w.deploy("web", 1))).toEqual([{ asked: true }]);
  });

  test("a session whose owner has no access to the deploy's workspace is no part of its pass", async () => {
    const w = await world();
    await w.commit(1, ["web/a.tsx"]);
    await w.deploy("web", 1);
    const other = await w.t.run(async (ctx) => ctx.db.insert("teams", { name: "Other", created_at: 1 } as any));
    expect(await w.refusal(`team:${other}`)).toBe("it is outside the deploy's workspace");
    expect(await w.t.mutation(internal.retireOnLive.retireSessionOnLive, { conversation: w.ids.conv, workspace: `team:${other}` })).toEqual({ asked: false, reason: "it is outside the deploy's workspace" });
  });

  test("more subagents than it reads: kept rather than judged on part of them", async () => {
    const w = await world();
    await w.commit(1, ["web/a.tsx"]);
    await w.t.run(async (ctx) => {
      for (let i = 0; i < 51; i++) await ctx.db.insert("conversations", { user_id: w.ids.user, agent_type: "claude_code", started_at: NOW - 90_000, updated_at: NOW - 90_000, status: "completed", title: `sub ${i}`, message_count: 1, parent_conversation_id: w.ids.conv, is_subagent: true } as any);
    });
    expect(await w.retireOn(await w.deploy("web", 1))).toEqual([{ asked: false, reason: "it has too many subagents to read" }]);
  });

  test("a pinned session, a role's standing session, an open one and one with no owning device are kept", async () => {
    const pinned = await world({ inbox_pinned_at: NOW - 1_000 });
    await pinned.commit(1, ["web/a.tsx"]);
    expect(await pinned.retireOn(await pinned.deploy("web", 1))).toEqual([{ asked: false, reason: "a person pinned it" }]);

    const standing = await world();
    await standing.t.run(async (ctx) => {
      const role = await ctx.db.insert("org_roles", { workspace: standing.ids.workspace, team_id: standing.ids.team, handle: "release", title: "Release", status: "active", created_at: 1, updated_at: 1 } as any);
      await ctx.db.patch(standing.ids.conv, { standing_role_id: role } as any);
    });
    await standing.commit(1, ["web/a.tsx"]);
    expect(await standing.retireOn(await standing.deploy("web", 1))).toEqual([{ asked: false, reason: "it is a role's standing session" }]);

    const open = await world();
    await open.t.run(async (ctx) => {
      await ctx.db.insert("user_presence", { user_id: open.ids.user, surface: "web", last_seen: Date.now(), last_input_at: Date.now(), focused: true, updated_at: Date.now(), viewing_conversation_id: open.ids.conv } as any);
    });
    await open.commit(1, ["web/a.tsx"]);
    expect(await open.retireOn(await open.deploy("web", 1))).toEqual([{ asked: false, reason: "a person has it open" }]);

    const homeless = await world({ owner_device_id: undefined });
    await homeless.commit(1, ["web/a.tsx"]);
    expect(await homeless.retireOn(await homeless.deploy("web", 1))).toEqual([{ asked: false, reason: "it has no confirmed owning device" }]);
  });
});

// The change flow's Deploy segment, as deployRunsLive.test.ts has it.
const node = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, label: id, shape: "box", type, ...extra });
const GRAPH = {
  nodes: [node("deploy", "conditional"), node("deploy__wait", "command", { script: "cast flow await-deploy --merge m.json" }), node("deploy__live", "command"), node("deploy__failed", "exit"), node("exit", "exit")],
  edges: [
    { from: "deploy", to: "deploy__wait" },
    { from: "deploy__wait", to: "deploy__live", condition: "outcome = success" },
    { from: "deploy__wait", to: "deploy__failed", condition: "outcome = failure" },
    { from: "deploy__live", to: "exit" },
  ],
};

describe("a run stopped at Deploy that a later deploy completes", () => {
  /** A run of the subject's change, stopped at Deploy; `heard` is the session its end message reached (the subject by default). */
  async function stoppedRun(subject: Record<string, unknown> = {}, heardBy?: "lead") {
    const w = await world(subject);
    await w.commit(1, ["web/a.tsx"]);
    const lead = heardBy ? await w.t.run(async (ctx) => ctx.db.insert("conversations", {
      user_id: w.ids.user, team_id: w.ids.team, agent_type: "claude_code", started_at: NOW - 100_000, updated_at: NOW - 50_000, status: "active", short_id: "jx7lead", session_id: "s-lead", owner_device_id: "dev-1", title: "Lead", message_count: 3, git_root: ROOT,
      thread_state: "Shipped", thread_state_status: "done", thread_state_at: NOW - 40_000, thread_state_msg_count: 3, last_person_turn_at: NOW - 95_000,
    } as any)) : null;
    // The lead has a live commit of its own too: judged by mistake, it would be the one asked.
    if (lead) await w.commit(2, ["web/lead.tsx"], { conv: lead, at: NOW - 61_000 });
    const heard = lead ?? w.ids.conv;
    const run = await w.t.run(async (ctx) => {
      const wf = await ctx.db.insert("workflows", { user_id: w.ids.user, name: "change", slug: "change", ...GRAPH, created_at: 1, updated_at: 1 } as any);
      const run = await ctx.db.insert("workflow_runs", {
        user_id: w.ids.user, workflow_id: wf, workspace: w.ids.workspace, status: "failed", current_node_id: "deploy__failed", fail_reason: "Stopped: Deploy stuck",
        merge: { sha: sha(1), branch: "fix", into: "main", at: NOW - 50_000 }, primary_conversation_id: w.ids.conv, ...(lead ? { spawner_conversation_id: lead } : {}),
        node_statuses: [{ node_id: "deploy__wait", status: "failed", outcome: "failure" }, { node_id: "deploy__failed", status: "failed" }], created_at: NOW - 100_000, updated_at: NOW - 30_000,
      } as any);
      await ctx.db.insert("pending_messages", { conversation_id: heard, from_user_id: w.ids.user, client_id: `run:${run}:end:1a2b`, content: "stopped at Deploy", status: "delivered", created_at: NOW - 29_000, retry_count: 0 } as any);
      return run;
    });
    const complete = async (deployId: any) => w.t.run(async (ctx) => completeLiveRuns(ctx, deployId));
    const told = (conv: any = w.ids.conv) => w.t.run(async (ctx) => (await ctx.db.query("pending_messages").withIndex("by_conversation_status", (q: any) => q.eq("conversation_id", conv).eq("status", "pending")).collect()).length);
    const tellLater = () => w.t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((f: any) => f.name.includes("tellIfKept")));
    return { ...w, run, lead, complete, told, tellLater };
  }

  test("its subject, with nothing left, is asked to retire; the tell waits on the daemon and goes only if it stays", async () => {
    const s = await stoppedRun();
    expect(await s.complete(await s.deploy("web", 1))).toEqual([s.run]);
    expect((await s.asks()).map((a) => a.parsed.conversation_id)).toEqual([String(s.ids.conv)]);
    expect(await s.told()).toBe(0);
    const [later] = await s.tellLater();
    expect(later.args[0]).toMatchObject({ conversation: s.ids.conv, client_id: `run:${s.run}:live` });
    // The daemon kept it: once the ask's time is up it hears the run is over, once.
    expect(await s.t.mutation(internal.retireOnLive.tellIfKept, later.args[0])).toEqual({ told: true });
    expect(await s.t.mutation(internal.retireOnLive.tellIfKept, later.args[0])).toEqual({ told: false });
    expect(await s.told()).toBe(1);
  });

  test("its subject, retired by its daemon meanwhile, hears nothing", async () => {
    const s = await stoppedRun();
    await s.complete(await s.deploy("web", 1));
    const [later] = await s.tellLater();
    await s.t.run(async (ctx) => ctx.db.patch(s.ids.conv, { inbox_killed_at: Date.now() } as any));
    expect(await s.t.mutation(internal.retireOnLive.tellIfKept, later.args[0])).toEqual({ told: false });
    expect(await s.told()).toBe(0);
  });

  test("its subject, refused (a person wrote to it since), hears the run is over now", async () => {
    const s = await stoppedRun({ last_person_turn_at: NOW - 10_000 });
    expect(await s.complete(await s.deploy("web", 1))).toEqual([s.run]);
    expect(await s.asks()).toHaveLength(0);
    expect(await s.told()).toBe(1);
  });

  test("a lead heard the stop: the run's subject is the one judged and asked, and the lead is told", async () => {
    const s = await stoppedRun({}, "lead");
    expect(await s.complete(await s.deploy("web", 2))).toEqual([s.run]);
    expect((await s.asks()).map((a) => a.parsed.conversation_id)).toEqual([String(s.ids.conv)]);
    expect(await s.told(s.lead)).toBe(1);
    expect(await s.told()).toBe(0);
    expect(await s.tellLater()).toHaveLength(0);
  });
});
