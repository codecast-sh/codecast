import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";
import { insightSignalFingerprint } from "@codecast/shared/contracts/signalFingerprint";
import { insightBlockerSignals, normalizeSignal } from "./signals";

describe("insightBlockerSignals", () => {
  test("each blocker is an insight bug signal keyed by session and text", () => {
    const out = insightBlockerSignals("jx7c6zk", ["Deploy fails on schema", "Tests time out"], undefined, "Ship the signals door");
    expect(out.map((s) => [s.source, s.kind, s.fingerprint, s.title, s.subject])).toEqual([
      ["insight", "bug", insightSignalFingerprint("jx7c6zk", "Deploy fails on schema"), "Deploy fails on schema", "jx7c6zk"],
      ["insight", "bug", insightSignalFingerprint("jx7c6zk", "Tests time out"), "Tests time out", "jx7c6zk"],
    ]);
    expect(out[0].detail_md).toContain("Ship the signals door");
    for (const s of out) expect(normalizeSignal(s)).toEqual(s);
  });

  test("a blocker the previous insight carried is not filed again, even restated", () => {
    const out = insightBlockerSignals("jx7c6zk", ["deploy fails on schema.", "New one"], ["Deploy fails on schema"], undefined);
    expect(out.map((s) => s.title)).toEqual(["New one"]);
  });

  test("a reworded blocker the previous insight carried is not filed again", () => {
    const out = insightBlockerSignals(
      "jx7c6zk",
      ["Convex deploy fails on the signals schema validator", "Tests time out"],
      ["The signals schema validator makes the convex deploy fail"],
      undefined,
    );
    expect(out.map((s) => s.title)).toEqual(["Tests time out"]);
  });

  test("duplicates and blanks inside one insight file once", () => {
    const out = insightBlockerSignals("jx7c6zk", ["Same", "same", "  "], [], undefined);
    expect(out).toHaveLength(1);
    expect(out[0].detail_md).not.toContain("working on");
  });
});

// The finder end to end under convex-test (line-profile.md LP1): each blocker
// files into the project of the session's active task, else the project whose
// path holds the session's directory, else none. No cause exists before the
// first blocker, so the attach judge is never asked; a second blocker in the
// same project may ask it, and with no API key the judge answers nothing.
describe("ingestInsightBlockers files with a project", () => {
  const T0 = 1_760_000_000_000;
  async function setup() {
    const t = convexTest(schema, {
      "./_generated/server.ts": () => import("./_generated/server"),
      "./signals.ts": () => import("./signals"),
    });
    const ids = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { name: "Owner" } as any);
      const ws = `user:${userId}`;
      const project = (title: string, project_path?: string, extra: Record<string, unknown> = {}, workspace = ws) =>
        ctx.db.insert("projects", { user_id: userId, workspace, title, status: "active", project_path, created_at: T0, updated_at: T0, ...extra } as any);
      const repo = await project("Repo", "/Users/me/src/repo");
      const web = await project("Web", "/Users/me/src/repo/packages/web");
      const tracked = await project("Tracked work");
      const foreign = await project("Foreign", undefined, {}, "team:someone-else");
      const task = (project_id: unknown, workspace = ws) =>
        ctx.db.insert("tasks", {
          user_id: userId, workspace, project_id, short_id: `ct-${String(project_id).slice(-4)}`, title: "Work", task_type: "task", status: "in_progress",
          priority: "medium", blocks: [], attempt_count: 0, retry_count: 0, max_retries: 3, created_at: T0, updated_at: T0,
        } as any);
      return { userId, ws, repo, web, tracked, foreign, trackedTask: await task(tracked), foreignTask: await task(foreign, "team:someone-else") };
    });
    let n = 0;
    const session = (fields: Record<string, unknown>) => t.run(async (ctx) => await ctx.db.insert("conversations", {
      user_id: ids.userId, agent_type: "claude_code", session_id: `s-${++n}`, short_id: `jx7aaa${n}`, started_at: T0, updated_at: T0,
      message_count: 0, is_private: true, status: "active", ...fields,
    } as any));
    const fileBlocker = async (conversation_id: any, blocker: string) => {
      const out = await t.action(internal.signals.ingestInsightBlockers, { conversation_id, blockers: [blocker] });
      expect(out).toEqual({ filed: 1 });
      const signals = await t.run(async (ctx) => await ctx.db.query("signals").collect());
      return signals.find((s: any) => s.title === blocker)!;
    };
    return { t, ...ids, session, fileBlocker };
  }

  test("the active task's project wins over the directory", async () => {
    const { session, fileBlocker, tracked, trackedTask, ws } = await setup();
    const c = await session({ project_path: "/Users/me/src/repo", active_task_id: trackedTask });
    const s = await fileBlocker(c, "Deploy fails on schema");
    expect(s).toMatchObject({ source: "insight", project_id: tracked, workspace: ws });
  });

  test("without a task, the deepest project whose path holds the directory, worktrees included", async () => {
    const { session, fileBlocker, repo, web } = await setup();
    expect((await fileBlocker(await session({ project_path: "/Users/me/src/repo/packages/web/app" }), "Web blocker")).project_id).toBe(web);
    expect((await fileBlocker(await session({ git_root: "/Users/me/src/repo/.codecast/worktrees/x" }), "Worktree blocker")).project_id).toBe(repo);
  });

  test("a task in another workspace does not route the blocker; the directory still does", async () => {
    const { session, fileBlocker, foreignTask, repo } = await setup();
    const s = await fileBlocker(await session({ project_path: "/Users/me/src/repo", active_task_id: foreignTask }), "Foreign task blocker");
    expect(s.project_id).toBe(repo);
  });

  test("a directory no project holds files with no project", async () => {
    const { session, fileBlocker } = await setup();
    expect((await fileBlocker(await session({ project_path: "/Users/me/src/elsewhere" }), "Loose blocker")).project_id).toBeUndefined();
  });
});
