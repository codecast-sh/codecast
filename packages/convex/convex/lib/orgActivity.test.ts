import { describe, expect, test } from "bun:test";
import { commitAreaPrefixes, computeOrgActivity, computeStale, pathPrefixOf, projectPathPrefix, type ActivityInputs } from "./orgActivity";

// Ground in what is happening (docs/architecture/org-staffing.md S9): pure over
// rows, so the areas, the people-by-area and the three stale lists are asserted
// with plain fixtures and no database.

const D = 86_400_000;
const NOW = 1_800_000_000_000;
const ME = "u_me";
const MATE = "u_mate";

describe("path prefixes", () => {
  test("a monorepo package reads to its package; a flat repo to its top dir; a root file to the root", () => {
    expect(pathPrefixOf("packages/web/components/Foo.tsx")).toBe("packages/web");
    expect(pathPrefixOf("src/index.ts")).toBe("src");
    expect(pathPrefixOf("src/lib/x.ts")).toBe("src/lib");
    expect(pathPrefixOf("README.md")).toBe("");
    expect(pathPrefixOf("app/routes/home.tsx")).toBe("app");
    expect(projectPathPrefix("/home/me/src/codecast/packages/convex")).toBe("packages/convex");
    expect(projectPathPrefix("/repo/growth")).toBe("growth");
  });

  test("a commit's areas come from the deepest directory its files share, reduced to a package or top level area", () => {
    // Rows shaped like the three inserters: the transcript path (files with a
    // status and numbers), the push webhook (added/modified/removed names),
    // and the older rows that carried no file list at all.
    const transcript = [{ filename: "packages/web/components/A.tsx", status: "modified", additions: 3, deletions: 1, changes: 4 }, { filename: "packages/web/lib/b.ts", status: "added", additions: 9, deletions: 0, changes: 9 }];
    expect(commitAreaPrefixes(transcript)).toEqual(["packages/web"]);
    const webhook = [{ filename: "packages/convex/convex/tasks.ts", status: "modified", additions: 0, deletions: 0, changes: 0 }, { filename: "packages/convex/convex/schema.ts", status: "modified", additions: 0, deletions: 0, changes: 0 }];
    expect(commitAreaPrefixes(webhook)).toEqual(["packages/convex"]);
    expect(commitAreaPrefixes(null)).toEqual([]);
    expect(commitAreaPrefixes([])).toEqual([]);
    // Spanning packages: the shared directory is the bare container, so the
    // commit is evidence for each seam it touched.
    expect(commitAreaPrefixes([{ filename: "packages/web/a.tsx" }, { filename: "packages/convex/b.ts" }])).toEqual(["packages/convex", "packages/web"]);
    // Spanning the root and a package: the same.
    expect(commitAreaPrefixes([{ filename: "docs/x.md" }, { filename: "packages/cli/src/y.ts" }])).toEqual(["docs", "packages/cli"]);
    // Files at different depths under one package share the package.
    expect(commitAreaPrefixes([{ filename: "packages/cli/src/a.ts" }, { filename: "packages/cli/package.json" }])).toEqual(["packages/cli"]);
    // Root files only: the root.
    expect(commitAreaPrefixes([{ filename: "README.md" }, { filename: "CLAUDE.md" }])).toEqual([""]);
    // The cap bounds what one sweeping commit contributes.
    expect(commitAreaPrefixes([{ filename: "packages/a/x" }, { filename: "packages/b/y" }, { filename: "packages/c/z" }], 2)).toEqual(["packages/a", "packages/b"]);
  });
});

function inputs(over: Partial<ActivityInputs> = {}): ActivityInputs {
  return {
    now: NOW,
    commits: [
      { repository: "acme/app", timestamp: NOW - 2 * D, author_name: "Me", files: [{ filename: "packages/web/a.tsx" }, { filename: "packages/web/b.tsx" }] },
      { repository: "acme/app", timestamp: NOW - 3 * D, author_name: "Mate", files: [{ filename: "packages/web/c.tsx" }] },
      { repository: "acme/app", timestamp: NOW - 4 * D, author_name: "Me", files: [{ filename: "packages/convex/s.ts" }], task_ids: ["task_open_landed"] },
    ],
    sessions: [
      { _id: "s1", state: "working", owner_user_id: ME, project_path: "/repo/acme/packages/web", repo: "acme/app" },
      { _id: "s2", state: "done", owner_user_id: MATE, project_path: "/repo/acme/packages/web", repo: "acme/app" },
    ],
    projects: [
      { id: "p_web", title: "Web", status: "active", project_path: "/repo/acme/packages/web", updated_at: NOW - 2 * D },
    ],
    plans: [],
    tasks: [],
    members: [{ user_id: ME, name: "Me" }, { user_id: MATE, name: "Mate" }],
    ...over,
  };
}

describe("areas and people (S9)", () => {
  test("areas roll up commits by repository and prefix, with authors, sessions and a project", () => {
    const a = computeOrgActivity(inputs());
    const web = a.areas.find((x) => x.path_prefix === "packages/web")!;
    expect(web).toMatchObject({ repository: "acme/app", commits_30d: 2, sessions_30d: 2, project_id: "p_web" });
    expect(web.authors).toEqual([{ name: "Me", commits: 1 }, { name: "Mate", commits: 1 }]);
    const convex = a.areas.find((x) => x.path_prefix === "packages/convex")!;
    expect(convex).toMatchObject({ commits_30d: 1, sessions_30d: 0 });
    // People by area: commits matched to a member by name, sessions by owner.
    const me = a.people.find((p) => p.user_id === ME)!;
    expect(me.areas.find((r) => r.path_prefix === "packages/web")).toEqual({ path_prefix: "packages/web", commits: 1, sessions: 1 });
    expect(me.areas.find((r) => r.path_prefix === "packages/convex")).toEqual({ path_prefix: "packages/convex", commits: 1, sessions: 0 });
    expect(a.commits).toEqual({ total: 3, with_files: 3, without_files: 0, spanning_areas: 0 });
  });

  test("real shaped rows: commits without a file list land on the root and are counted as unverified, not as a seam", () => {
    const a = computeOrgActivity(inputs({
      commits: [
        // A webhook row from before file lists were stored: counts only.
        { repository: "acme/app", timestamp: NOW - D, author_name: "Me", files: null },
        { repository: "acme/app", timestamp: NOW - D, author_name: "Me" },
        // A transcript row with the full file shape.
        { repository: "acme/app", timestamp: NOW - D, author_name: "Me", files: [{ filename: "packages/cli/src/daemon.ts", status: "modified", additions: 4, deletions: 2, changes: 6 } as any] },
        // A spanning commit: convex and web, one row, both seams.
        { repository: "acme/app", timestamp: NOW - D, author_name: "Mate", files: [{ filename: "packages/convex/convex/x.ts" }, { filename: "packages/web/y.tsx" }] },
      ],
    }));
    expect(a.commits).toEqual({ total: 4, with_files: 2, without_files: 2, spanning_areas: 1 });
    expect(a.areas.map((x) => [x.path_prefix, x.commits_30d])).toEqual([["", 2], ["packages/web", 1], ["packages/cli", 1], ["packages/convex", 1]]);
  });
});

describe("a session's area is its path relative to its git root", () => {
  test("a session at the repository root shares the root row with commits that carry no file list; one inside a package lands on that package", async () => {
    const { sessionAreaPrefix } = await import("./orgActivity");
    expect(sessionAreaPrefix({ project_path: "/Users/me/src/codecast", git_root: "/Users/me/src/codecast" })).toBe("");
    expect(sessionAreaPrefix({ project_path: "/Users/me/src/codecast/packages/web", git_root: "/Users/me/src/codecast" })).toBe("packages/web");
    expect(sessionAreaPrefix({ project_path: "/Users/me/src/codecast/docs", git_root: "/Users/me/src/codecast" })).toBe("docs");
    expect(sessionAreaPrefix({ project_path: "/repo/growth", git_root: null })).toBe("growth");
    expect(sessionAreaPrefix({ project_path: null, git_root: "/x" })).toBeNull();
    const a = computeOrgActivity(inputs({
      commits: [{ repository: "acme/app", timestamp: NOW - D, author_name: "Me" }],
      sessions: [
        { _id: "root", state: "working", owner_user_id: ME, project_path: "/home/me/src/app", git_root: "/home/me/src/app", repo: "acme/app" },
        { _id: "web", state: "working", owner_user_id: ME, project_path: "/home/me/src/app/packages/web", git_root: "/home/me/src/app", repo: "acme/app" },
      ],
    }));
    const root = a.areas.find((x) => x.path_prefix === "")!;
    expect(root).toMatchObject({ commits_30d: 1, sessions_30d: 2 });
    const me = a.people.find((p) => p.user_id === ME)!;
    expect(me.areas).toEqual([{ path_prefix: "", commits: 1, sessions: 1 }, { path_prefix: "packages/web", commits: 0, sessions: 1 }]);
  });
});

describe("stale plans (S9)", () => {
  const plan = (id: string, over: any = {}) => ({ id, short_id: id, title: id, status: "active", updated_at: NOW, ...over });
  const task = (id: string, plan_id: string, over: any = {}) => ({ id, short_id: id, title: id, status: "open", plan_id, updated_at: NOW, ...over });

  test("every task closed; open tasks untouched 21 days with no live session, whether or not it had sessions; bound sessions all done confirms a 14 day quiet", () => {
    const a = computeStale(inputs({
      plans: [plan("pl_closed"), plan("pl_sessions"), plan("pl_quiet"), plan("pl_never"), plan("pl_live"), plan("pl_draftlive", { status: "draft" }), plan("pl_parked"), plan("pl_idea"), plan("pl_stale_closed")],
      tasks: [
        task("t1", "pl_closed", { status: "done" }), task("t2", "pl_closed", { status: "dropped" }),
        // Sessions all done and the tasks quiet for 16 days: confirmed stale.
        task("t3", "pl_sessions", { status: "open", updated_at: NOW - 16 * D }),
        // Quiet 25 days, one session that settled done long ago.
        task("t4", "pl_quiet", { status: "open", updated_at: NOW - 25 * D }),
        // Never had a session, 0 of 3 done, untouched 25 days: the op-6 case (pl-529).
        task("t5a", "pl_never", { status: "in_progress", updated_at: NOW - 25 * D }), task("t5b", "pl_never", { status: "open", updated_at: NOW - 25 * D }),
        // Sessions all done but a task moved 2 days ago: live (the pl-497 case).
        task("t6", "pl_live", { status: "in_progress", updated_at: NOW - 2 * D }),
        // A done task closed 2 days ago does not keep a plan alive whose open
        // rows are untouched for 25 days (pl_stale_closed).
        task("t9a", "pl_stale_closed", { status: "done", updated_at: NOW - 2 * D }), task("t9b", "pl_stale_closed", { status: "open", updated_at: NOW - 25 * D }),
        task("t7", "pl_draftlive", { status: "open", updated_at: NOW - 3 * D }),
        // Quiet 30 days but a hand is parked dormant on it: not stale.
        task("t8", "pl_parked", { status: "open", updated_at: NOW - 30 * D }),
      ],
      sessions: [
        { _id: "sd1", state: "done", active_plan_id: "pl_sessions" },
        { _id: "sd2", state: "done", active_plan_id: "pl_sessions" },
        { _id: "sd3", state: "done", active_plan_id: "pl_quiet" },
        { _id: "sl1", state: "done", active_plan_id: "pl_live" },
        { _id: "sl2", state: "done", active_plan_id: "pl_live" },
        { _id: "sp", state: "dormant", active_plan_id: "pl_parked" },
      ],
    }));
    const byId = Object.fromEntries(a.plans.map((p) => [p.short_id, p.reason]));
    expect(byId).toEqual({ pl_closed: "every task closed", pl_sessions: "bound sessions all done", pl_quiet: "no activity 21d", pl_never: "no activity 21d", pl_stale_closed: "no activity 21d" });
    expect(a.plans.find((p) => p.short_id === "pl_stale_closed")!.last_task_activity_at).toBe(NOW - 25 * D);
    expect(a.plans.find((p) => p.short_id === "pl_sessions")!.sessions_live).toBe(0);
    expect(a.plans.find((p) => p.short_id === "pl_never")!.last_task_activity_at).toBe(NOW - 25 * D);
  });
});

describe("stale tasks and projects (S9)", () => {
  test("in progress with no session for 14 days, in progress with every session done for 14 days, and an open task a commit already landed", () => {
    const a = computeStale(inputs({
      tasks: [
        { id: "task_inprog", short_id: "ct-1", title: "Wire it", status: "in_progress", updated_at: NOW - 16 * D },
        // Landed by a commit and quiet since: a landed commit on a row written this week is not a finished task (the newest word tests below).
        { id: "task_open_landed", short_id: "ct-2", title: "Ship it", status: "open", updated_at: NOW - 16 * D },
        { id: "task_fresh", short_id: "ct-3", title: "Fresh", status: "in_progress", updated_at: NOW - 2 * D },
        { id: "task_done", short_id: "ct-4", title: "Done", status: "done", updated_at: NOW - 30 * D },
        // Bulk filed as in progress on a day nobody worked it, never bound: the 44 rows of op-6.
        { id: "task_bulk", short_id: "ct-5", title: "Filed in bulk", status: "in_progress", updated_at: NOW - 26 * D },
        // The same but only 5 days old: not yet.
        { id: "task_bulk_new", short_id: "ct-6", title: "Filed last week", status: "in_progress", updated_at: NOW - 5 * D },
        // Open, not in progress, untouched a month: backlog, not stale.
        { id: "task_backlog", short_id: "ct-7", title: "Someday", status: "open", updated_at: NOW - 40 * D },
        // In progress 20 days quiet with a live hand still bound: not stale.
        { id: "task_held", short_id: "ct-8", title: "Held", status: "in_progress", updated_at: NOW - 20 * D },
        // Worked once (a session was bound, since released) then untouched 20 days: sessions done, not never picked up.
        { id: "task_worked", short_id: "ct-9", title: "Worked once", status: "in_progress", updated_at: NOW - 20 * D, conversation_ids: ["gone"] },
      ],
      sessions: [
        { _id: "sx", state: "done", active_task_id: "task_inprog", updated_at: NOW - 15 * D },
        { _id: "sy", state: "done", active_task_id: "task_fresh" },
        { _id: "sz", state: "working", active_task_id: "task_held", updated_at: NOW - D },
      ],
    }));
    const byId = Object.fromEntries(a.tasks.map((t) => [t.short_id, t.reason]));
    expect(byId).toEqual({ "ct-1": "in progress, sessions done 14d", "ct-2": "commits landed, still open", "ct-5": "in progress, no session 14d", "ct-9": "in progress, sessions done 14d" });
    expect(a.tasks.find((t) => t.short_id === "ct-1")!.last_session_activity_at).toBe(NOW - 15 * D);
    expect(a.tasks.find((t) => t.short_id === "ct-5")!.last_session_activity_at).toBeNull();
  });

  test("a project nothing touched in 30 days is stale; a touched one is not", () => {
    const a = computeStale(inputs({
      projects: [
        { id: "p_live", title: "Live", status: "active", project_path: "/repo/acme/packages/web", updated_at: NOW - 40 * D },
        { id: "p_stale", title: "Legacy", status: "active", project_path: "/repo/legacy", updated_at: NOW - 40 * D },
        { id: "p_done", title: "Shipped", status: "done", project_path: "/x", updated_at: NOW - 40 * D },
      ],
      tasks: [{ id: "tl", short_id: "ct-9", title: "recent", status: "open", project_id: "p_live", updated_at: NOW - 2 * D }],
      sessions: [{ _id: "s1", state: "working", project_path: "/repo/acme/packages/web", repo: "acme/app" }],
    }));
    expect(a.projects.map((p) => [p.title, p.reason])).toEqual([["Legacy", "no activity 30d"]]);
  });
});

// Union, 2026-09-20 (docs/architecture/org-eval.md ground truth): 8 of 20
// flagged records carried a reason that was false, and every one of them was a
// row still being worked. The clock now reads the row's newest word.
describe("stale reasons read the row's newest word", () => {
  const base: ActivityInputs = { now: NOW, commits: [], sessions: [], projects: [], plans: [], tasks: [], members: [] };
  const task = (over: Partial<ActivityInputs["tasks"][number]>) => ({ id: "t1", short_id: "ct-1", title: "T", status: "in_progress", updated_at: NOW - 20 * D, ...over });

  test("a commit on a feature branch or a pull request is not a landing; one on main is", () => {
    const withBranch = (branch: string | null) => computeStale({ ...base, tasks: [task({ status: "open" })], commits: [{ timestamp: NOW - D, task_ids: ["t1"], branch }] }).tasks.map((t) => t.reason);
    expect(withBranch("ct-1-peer-land")).toEqual([]);
    expect(withBranch("main")).toEqual(["commits landed, still open"]);
    expect(withBranch(null)).toEqual(["commits landed, still open"]);
  });

  test("a task written this week is alive whatever its commits or sessions say", () => {
    const r = computeStale({ ...base,
      tasks: [task({ updated_at: NOW - 2 * 3_600_000 }), task({ id: "t2", short_id: "ct-2", updated_at: NOW - 20 * D })],
      commits: [{ timestamp: NOW - D, task_ids: ["t1", "t2"], branch: "main" }],
    });
    expect(r.tasks.map((t) => t.short_id)).toEqual(["ct-2"]);
  });

  test("a session that touched the task this week keeps it alive even when its state is done", () => {
    const r = computeStale({ ...base,
      tasks: [task({})],
      sessions: [{ _id: "s1", state: "done", updated_at: NOW - 6 * D, active_task_id: "t1" }],
    });
    expect(r.tasks).toEqual([]);
    const quiet = computeStale({ ...base, tasks: [task({})], sessions: [{ _id: "s1", state: "done", updated_at: NOW - 16 * D, active_task_id: "t1" }] });
    expect(quiet.tasks.map((t) => t.reason)).toEqual(["in progress, sessions done 14d"]);
  });

  test("a comment on the plan or a session bound to it is activity for the 21 day clock", () => {
    const plan = { id: "p1", short_id: "pl-1", title: "P", status: "draft", updated_at: NOW - 40 * D };
    const openTask = task({ status: "open", plan_id: "p1", updated_at: NOW - 40 * D });
    expect(computeStale({ ...base, plans: [plan], tasks: [openTask] }).plans.map((p) => p.reason)).toEqual(["no activity 21d"]);
    expect(computeStale({ ...base, plans: [{ ...plan, last_entry_at: NOW - 9 * D }], tasks: [openTask] }).plans).toEqual([]);
    // A bulk write to the row is not a word: only an entry on the plan's timeline moves the clock.
    expect(computeStale({ ...base, plans: [{ ...plan, updated_at: NOW - 2 * D }], tasks: [openTask] }).plans.map((p) => p.reason)).toEqual(["no activity 21d"]);
    expect(computeStale({ ...base, plans: [plan], tasks: [openTask], sessions: [{ _id: "s1", state: "done", updated_at: NOW - 9 * D, active_plan_id: "p1" }] }).plans).toEqual([]);
  });

  test("a plan marked done whose open tasks are still written, or that a live session works, is flagged the other way", () => {
    const plan = { id: "p1", short_id: "pl-1", title: "P", status: "done", updated_at: NOW - 5 * D };
    expect(computeStale({ ...base, plans: [plan], tasks: [task({ plan_id: "p1", updated_at: NOW - 3 * 3_600_000 })] }).plans).toEqual([expect.objectContaining({ short_id: "pl-1", reason: "marked done, still worked" })]);
    expect(computeStale({ ...base, plans: [plan], tasks: [task({ plan_id: "p1", status: "done", updated_at: NOW - 3 * 3_600_000 })] }).plans).toEqual([]);
    // In progress but last written nine days ago: a forgotten row under a finished plan, not live work.
    expect(computeStale({ ...base, plans: [plan], tasks: [task({ plan_id: "p1", updated_at: NOW - 9 * D })] }).plans).toEqual([]);
    // A follow up left open under a finished plan is not the plan still running.
    expect(computeStale({ ...base, plans: [plan], tasks: [task({ plan_id: "p1", status: "open", updated_at: NOW - 3 * 3_600_000 })] }).plans).toEqual([]);
    expect(computeStale({ ...base, plans: [plan], sessions: [{ _id: "s1", state: "working", updated_at: NOW, active_plan_id: "p1" }] }).plans.map((p) => p.reason)).toEqual(["marked done, still worked"]);
    // A session parked on the finished plan (waiting on a person, or on a wake) is not working it.
    expect(computeStale({ ...base, plans: [plan], sessions: [{ _id: "s1", state: "needs_input", updated_at: NOW, active_plan_id: "p1" }] }).plans).toEqual([]);
    expect(computeStale({ ...base, plans: [plan], sessions: [{ _id: "s1", state: "dormant", updated_at: NOW, active_plan_id: "p1" }] }).plans).toEqual([]);
  });
});
