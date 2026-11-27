import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";
import { allModules } from "./testModules.testkit";
import { stampMainOrder } from "./deployTargetsCi";
import { recordDeployMarker } from "./deploys";
import { completeLiveRuns } from "./deployCarries";
import { liveRetireRefusal } from "./retireOnLive";

setDefaultTimeout(60_000);

// A session whose change is live on every target it touches is retired when the deploy that took it there goes live,
// however it shipped (retireOnLive.ts). Synthetic data only.

const REPO = "acme/app";
const ROOT = "/work/app";
const NOW = Date.now();
const sha = (n: number) => `${n.toString(16).padStart(2, "0")}ab`.repeat(10);
const file = (filename: string) => ({ filename, status: "modified", additions: 1, deletions: 0, changes: 1 });

async function world(subject: Record<string, unknown> = {}) {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { name: "Ana" } as any);
    const team = await ctx.db.insert("teams", { name: "Acme", created_at: 1 } as any);
    await ctx.db.insert("team_memberships", { team_id: team, user_id: user, role: "member", joined_at: 1 } as any);
    const workspace = `team:${team}`;
    for (const name of ["web", "api"]) {
      await ctx.db.insert("deploy_targets", { workspace, team_id: team, repository: REPO, name, runs: "push", live: { kind: "marker" }, policy: "press", paths: [`${name}/**`], publisher_user_id: user, published_at: NOW - 100_000 } as any);
    }
    const conv = await ctx.db.insert("conversations", {
      user_id: user, team_id: team, agent_type: "claude_code", started_at: NOW - 100_000, updated_at: NOW - 50_000, status: "active", short_id: "jx7subj", session_id: "s-subj", title: "Fix checkout", message_count: 12, git_root: ROOT,
      // It pinned done, as a session that shipped does.
      thread_state: "Shipped", thread_state_status: "done", thread_state_at: NOW - 40_000, thread_state_msg_count: 12,
      last_person_turn_at: NOW - 90_000, ...subject,
    } as any);
    return { user, team, workspace, conv };
  });
  /** A commit the session made, on main at `n`, at `at`. */
  const commit = (n: number, files: string[], at = NOW - 60_000, onMain = true) => t.run(async (ctx) => {
    const id = await ctx.db.insert("commits", { conversation_id: ids.conv, sha: sha(n), message: `change ${n}`, author_name: "Ana", author_email: "a@x", timestamp: at, files_changed: files.length, insertions: 1, deletions: 0, repository: REPO, team_id: ids.team, branch: onMain ? "main" : "fix", files: files.map(file) } as any);
    if (onMain) await stampMainOrder(ctx, [id], NOW - 50_000 + n);
  });
  const edit = (path: string, at = NOW - 70_000) => t.run(async (ctx) => {
    const message = await ctx.db.insert("messages", { conversation_id: ids.conv, message_uuid: `m-${path}-${at}`, role: "assistant", content: "editing", timestamp: at } as any);
    await ctx.db.insert("file_changes", { conversation_id: ids.conv, change_key: `${path}:${at}`, message_id: message, seq: 0, file_path: `${ROOT}/${path}`, change_type: "edit", timestamp: at } as any);
  });
  /** A live deploy of `target` at main commit `n`; returns its id. */
  const deploy = (target: string, n: number) => t.run(async (ctx) => {
    const short = await recordDeployMarker(ctx, { workspace: ids.workspace, team_id: ids.team, target, sha: sha(n), repository: REPO, source: "m", status: "live", at: NOW });
    return (await ctx.db.query("deploys").withIndex("by_workspace_created", (q: any) => q.eq("workspace", ids.workspace)).collect()).find((d: any) => d.short_id === short)!._id;
  });
  const retireOn = async (deployId: any) => {
    const { sessions } = await t.mutation(internal.retireOnLive.retireSessionsOnLive, { deploy: deployId });
    return Promise.all(sessions.map((id: string) => t.mutation(internal.retireOnLive.retireSessionOnLive, { conversation: id as any })));
  };
  const row = () => t.run(async (ctx) => (await ctx.db.get(ids.conv)) as any);
  const refusal = () => t.run(async (ctx) => liveRetireRefusal(ctx, (await ctx.db.get(ids.conv))!, Date.now()));
  return { t, ids, commit, edit, deploy, retireOn, row, refusal };
}

describe("a deploy going live retires the sessions whose change it takes live everywhere", () => {
  test("a pull request merged by hand: its session's commit is live on the one target it touches, so it is retired, once", async () => {
    const w = await world();
    await w.edit("web/a.tsx");
    await w.commit(1, ["web/a.tsx"]);
    expect(await w.refusal()).toBe("its change is not live yet on web");
    const d = await w.deploy("web", 1);
    expect(await w.retireOn(d)).toEqual([{ retired: true }]);
    expect((await w.row()).inbox_killed_at).toBeGreaterThan(0);
    // A later deploy finds it stopped and does nothing more.
    expect(await w.retireOn(d)).toEqual([{ retired: false, reason: "it is already stopped" }]);
  });

  test("the deploy's own live write schedules the pass", async () => {
    const w = await world();
    await w.commit(1, ["web/a.tsx"]);
    await w.deploy("web", 1);
    // Real timers: scheduled work starts on its own; wait for the chain (the pass, then the session's own) to land.
    for (let i = 0; i < 100 && !(await w.row()).inbox_killed_at; i++) {
      await new Promise((r) => setTimeout(r, 20));
      await w.t.finishInProgressScheduledFunctions();
    }
    expect((await w.row()).inbox_killed_at).toBeGreaterThan(0);
  });

  test("a session that has not settled (its turn ended asking, no done pinned) is kept", async () => {
    const w = await world({ thread_state_status: undefined, thread_state: undefined });
    await w.commit(1, ["web/a.tsx"]);
    expect(await w.retireOn(await w.deploy("web", 1))).toEqual([{ retired: false, reason: "it has not settled (needs_input)" }]);
  });

  test("one target its change touches is not live yet: kept", async () => {
    const w = await world();
    await w.commit(1, ["web/a.tsx"]);
    await w.commit(2, ["api/b.ts"]);
    const d = await w.deploy("web", 2);
    expect(await w.retireOn(d)).toEqual([{ retired: false, reason: "its change is not live yet on api" }]);
    expect((await w.row()).inbox_killed_at).toBeUndefined();
    // Once api runs it too, the session goes.
    expect(await w.retireOn(await w.deploy("api", 2))).toEqual([{ retired: true }]);
  });

  test("a person wrote to it after its last commit: kept", async () => {
    const w = await world({ last_person_turn_at: NOW - 10_000 });
    await w.commit(1, ["web/a.tsx"]);
    expect(await w.retireOn(await w.deploy("web", 1))).toEqual([{ retired: false, reason: "a person wrote to it after its last commit" }]);
    expect((await w.row()).inbox_killed_at).toBeUndefined();
  });

  test("an edit no commit of its own on main holds keeps it: one made after the commit, or committed only on a branch", async () => {
    const after = await world();
    await after.commit(1, ["web/a.tsx"]);
    await after.edit("web/a.tsx", NOW - 30_000);
    await after.edit("api/new.ts", NOW - 30_000);
    expect(await after.retireOn(await after.deploy("web", 1))).toEqual([{ retired: false, reason: "it has changes not on main: web/a.tsx, api/new.ts" }]);

    const branch = await world();
    await branch.edit("web/b.tsx");
    await branch.commit(1, ["web/a.tsx"]);
    await branch.commit(2, ["web/b.tsx"], NOW - 60_000, false);
    expect(await branch.retireOn(await branch.deploy("web", 1))).toEqual([{ retired: false, reason: "it has changes not on main: web/b.tsx" }]);
  });

  test("a file it wrote outside its checkout is no part of the change", async () => {
    const w = await world();
    await w.commit(1, ["web/a.tsx"]);
    await w.t.run(async (ctx) => {
      const message = await ctx.db.insert("messages", { conversation_id: w.ids.conv, message_uuid: "m-scratch", role: "assistant", content: "notes", timestamp: NOW - 20_000 } as any);
      await ctx.db.insert("file_changes", { conversation_id: w.ids.conv, change_key: "scratch", message_id: message, seq: 0, file_path: "/tmp/notes.md", change_type: "write", timestamp: NOW - 20_000 } as any);
    });
    expect(await w.retireOn(await w.deploy("web", 1))).toEqual([{ retired: true }]);
  });

  test("a pinned session, a role's standing session and a working one are kept", async () => {
    const pinned = await world({ inbox_pinned_at: NOW - 1_000 });
    await pinned.commit(1, ["web/a.tsx"]);
    expect(await pinned.retireOn(await pinned.deploy("web", 1))).toEqual([{ retired: false, reason: "a person pinned it" }]);

    const standing = await world();
    await standing.t.run(async (ctx) => {
      const role = await ctx.db.insert("org_roles", { workspace: standing.ids.workspace, team_id: standing.ids.team, handle: "release", title: "Release", status: "active", created_at: 1, updated_at: 1 } as any);
      await ctx.db.patch(standing.ids.conv, { standing_role_id: role } as any);
    });
    await standing.commit(1, ["web/a.tsx"]);
    expect(await standing.retireOn(await standing.deploy("web", 1))).toEqual([{ retired: false, reason: "it is a role's standing session" }]);

    const working = await world();
    await working.t.run(async (ctx) => {
      await ctx.db.insert("managed_sessions", { session_id: "s-subj", conversation_id: working.ids.conv, user_id: working.ids.user, pid: 1, started_at: NOW - 60_000, last_heartbeat: Date.now(), agent_status: "working", agent_status_updated_at: Date.now() } as any);
    });
    await working.commit(1, ["web/a.tsx"]);
    const [kept] = await working.retireOn(await working.deploy("web", 1));
    expect(kept.retired).toBe(false);
    expect((await working.row()).inbox_killed_at).toBeUndefined();
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
  async function stoppedRun(subject: Record<string, unknown> = {}) {
    const w = await world(subject);
    await w.commit(1, ["web/a.tsx"]);
    const run = await w.t.run(async (ctx) => {
      const wf = await ctx.db.insert("workflows", { user_id: w.ids.user, name: "change", slug: "change", ...GRAPH, created_at: 1, updated_at: 1 } as any);
      const run = await ctx.db.insert("workflow_runs", {
        user_id: w.ids.user, workflow_id: wf, workspace: w.ids.workspace, status: "failed", current_node_id: "deploy__failed", fail_reason: "Stopped: Deploy stuck",
        merge: { sha: sha(1), branch: "fix", into: "main", at: NOW - 50_000 }, primary_conversation_id: w.ids.conv,
        node_statuses: [{ node_id: "deploy__wait", status: "failed", outcome: "failure" }, { node_id: "deploy__failed", status: "failed" }], created_at: NOW - 100_000, updated_at: NOW - 30_000,
      } as any);
      await ctx.db.insert("pending_messages", { conversation_id: w.ids.conv, from_user_id: w.ids.user, client_id: `run:${run}:end:1a2b`, content: "stopped at Deploy", status: "delivered", created_at: NOW - 29_000, retry_count: 0 } as any);
      return run;
    });
    const complete = async (deployId: any) => w.t.run(async (ctx) => completeLiveRuns(ctx, deployId));
    const told = () => w.t.run(async (ctx) => (await ctx.db.query("pending_messages").withIndex("by_conversation_status", (q: any) => q.eq("conversation_id", w.ids.conv).eq("status", "pending")).collect()).length);
    return { ...w, run, complete, told };
  }

  test("its session, with nothing left, is retired instead of told", async () => {
    const s = await stoppedRun();
    expect(await s.complete(await s.deploy("web", 1))).toEqual([s.run]);
    expect((await s.row()).inbox_killed_at).toBeGreaterThan(0);
    expect(await s.told()).toBe(0);
  });

  test("its session, refused (a person wrote to it since), hears the run is over", async () => {
    const s = await stoppedRun({ last_person_turn_at: NOW - 10_000 });
    expect(await s.complete(await s.deploy("web", 1))).toEqual([s.run]);
    expect((await s.row()).inbox_killed_at).toBeUndefined();
    expect(await s.told()).toBe(1);
  });
});
