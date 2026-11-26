import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRANCH, PR_URL, T, setup } from "./mergeStation.testkit";

// The Merge station's before-merge deploy steps: from a tree that holds main,
// another round when main moves under them, what a failure says is deployed,
// a step run again from the landed commit, the deploy recorded at it, the
// repository's merge lock, and the real scratch worktree.

describe("cast flow merge: before-merge steps", () => {
  test("a step runs from the rebased tree holding main, and its target is recorded deployed at the landed sha", async () => {
    const s = setup();
    try {
      s.profile(`git merge-base --is-ancestor origin/main HEAD && git rev-parse HEAD > ${join(s.root, "deployed")}`);
      const head = s.branch("api/route.ts", "export {}\n");
      const moved = s.advanceMain("web/page.ts", "page\n");
      s.ci(head);
      const r = await s.run();
      expect(r.code).toBe(0);
      const deployed = readFileSync(join(s.root, "deployed"), "utf-8").trim();
      expect(s.git(s.work, "merge-base", "--is-ancestor", moved, deployed)).toBe("");
      const pass = s.posts.find((p) => p.path === "/cli/deploys/ship-pass")!.body;
      expect(pass).toMatchObject({ repository: "o/r", ok: true, pushed: r.line, pr_url: PR_URL, deploys: [{ name: "convex", stage: "before_push", ok: true, target: "backend" }] });
    } finally { s.done(); }
  }, T);

  test("a failing step refuses (exit 2) naming the step and its output, and merges nothing", async () => {
    const s = setup();
    try {
      s.profile("echo bundling; echo 'typecheck failed' >&2; exit 4");
      const head = s.branch("api/route.ts", "export {}\n");
      s.ci(head);
      const r = await s.run();
      // stdout and stderr reach the station on two pipes, so the two lines may arrive in either order.
      expect(r.code).toBe(2);
      expect(r.line).toStartWith("before-merge step convex failed (exit 4): ");
      expect(r.line.slice(r.line.indexOf(": ") + 2).split(" | ").sort()).toEqual(["bundling", "typecheck failed"]);
      expect(s.merged()).toBe(false);
    } finally { s.done(); }
  }, T);

  test("main moving while a step runs makes it refuse (deploy.sh: BEHIND): another round on the new main, then the merge", async () => {
    const s = setup();
    try {
      s.profile("deploy");
      const head = s.branch("api/route.ts", "export {}\n");
      s.ci(head);
      const from: string[] = [];
      const r = await s.run({
        runStep: async (_cmd, cwd) => {
          from.push(s.git(cwd, "rev-parse", "HEAD"));
          if (from.length > 1) return { code: 0, output: "" };
          s.advanceMain("web/page.ts", "page\n");
          return { code: 1, output: "REFUSING to deploy: this tree is BEHIND origin/main." };
        },
      });
      expect(r.code).toBe(0);
      expect(from).toHaveLength(2);
      expect(s.logged.some((l) => l.includes("moved while convex ran") && l.includes("BEHIND"))).toBe(true);
    } finally { s.done(); }
  }, T);

  test("main changing what a step deployed while it ran: the change goes onto it and the step runs again before the merge", async () => {
    const s = setup();
    try {
      s.profile("deploy");
      const head = s.branch("api/route.ts", "export {}\n");
      s.ci(head);
      const from: string[] = [];
      let landed = "";
      const r = await s.run({
        runStep: async (_cmd, cwd) => {
          from.push(s.git(cwd, "rev-parse", "HEAD"));
          if (from.length === 1) landed = s.advanceMain("api/other.ts", "export const other = 1\n");
          return { code: 0, output: "" };
        },
      });
      expect(r.code).toBe(0);
      expect(from).toHaveLength(2);
      expect(s.git(s.work, "merge-base", "--is-ancestor", landed, from[1])).toBe("");
      expect(r.line).toBe(s.originMain());
    } finally { s.done(); }
  }, T);

  test("main moving under the step's paths between the last check and the squash: the step runs again from main as it is after the merge", async () => {
    const s = setup({ advance: { file: "api/racing.ts", text: "export const racing = 1\n" }, after: { file: "later.txt", text: "later\n" } });
    try {
      s.profile("deploy");
      const head = s.branch("api/route.ts", "export {}\n");
      s.ci(head);
      const from: string[] = [];
      const r = await s.run({ runStep: async (_cmd, cwd) => { from.push(s.git(cwd, "rev-parse", "HEAD")); return { code: 0, output: "" }; } });
      expect(r.code).toBe(0);
      expect(from).toHaveLength(2);
      // Not the landed commit (deploy.sh would refuse it as behind main), but main after it, which holds it.
      expect(from[1]).toBe(s.originMain());
      expect(from[1]).not.toBe(r.line);
      expect(s.git(s.work, "merge-base", "--is-ancestor", r.line, from[1])).toBe("");
      expect(s.git(s.work, "show", `${r.line}:api/racing.ts`)).toBe("export const racing = 1");
      const pass = s.posts.find((p) => p.path === "/cli/deploys/ship-pass")!.body;
      expect(pass).toMatchObject({ pushed: from[1], deploys: [{ name: "convex", stage: "before_push", ok: true, target: "backend" }] });
    } finally { s.done(); }
  }, T);

  test("the repository's lease is taken before the first step, waited on while another machine holds it, and released after the merge", async () => {
    const s = setup();
    try {
      s.profile("deploy");
      const head = s.branch("api/route.ts", "export {}\n");
      s.ci(head);
      let takes = 0;
      s.answers["/cli/repo-lease"] = (body) => body.op === "release" ? { released: true }
        : ++takes === 1 ? { held: false, holder: "cast ship checkout on host-2", since: Date.now() - 120_000, expires_at: Date.now() + 480_000 } : { held: true, expires_at: Date.now() + 600_000 };
      const order: string[] = [];
      const r = await s.run({ runStep: async () => { order.push("step"); return { code: 0, output: "" }; } });
      expect(r.code).toBe(0);
      expect(s.logged).toContain("waiting for cast ship checkout on host-2 to finish its deploys and merge in o/r (holding it 2m)");
      const leases = s.posts.filter((p) => p.path === "/cli/repo-lease");
      // Taken (after one wait), asked outright before the step and again before the merge, released at the end.
      expect(leases.map((p) => p.body.op)).toEqual(["take", "take", "renew", "renew", "release"]);
      // Every ask names the run, whose workspace scopes the lease (not the teams that connected the repository).
      expect(leases[0].body).toMatchObject({ repository: "o/r", run_id: "run_1", holder: expect.stringContaining(`the merge of PR #7 (run run_1) on `) });
      expect(leases.every((p) => p.body.run_id === "run_1")).toBe(true);
      // Released only after the merge was recorded.
      const at = (path: string) => s.posts.findIndex((p) => p.path === path);
      expect(s.posts.length - 1).toBe(s.posts.map((p) => p.body.op).lastIndexOf("release"));
      expect(at("/cli/line/merge/record")).toBeLessThan(s.posts.length - 1);
    } finally { s.done(); }
  }, T);

  /** A step that records the tree it ran from; on its first run, someone pushes to the branch so GitHub refuses the
   *  pinned head and nothing merges. */
  const latePush = (s: ReturnType<typeof setup>, from: string[]) => async (_cmd: string, cwd: string) => {
    from.push(s.git(cwd, "rev-parse", "HEAD"));
    if (from.length === 1) {
      s.git(s.work, "checkout", "-q", BRANCH);
      s.commit("api/route.ts", "export const late = 1\n", "late push");
      s.git(s.work, "push", "-q", "origin", BRANCH);
      s.git(s.work, "checkout", "-q", "main");
    }
    return { code: 0, output: "" };
  };

  test("a merge refused after a step went out sends that step again from main, records it, and says so", async () => {
    const s = setup();
    try {
      s.profile("deploy");
      const head = s.branch("api/route.ts", "export {}\n");
      s.ci(head);
      const from: string[] = [];
      const r = await s.run({ runStep: latePush(s, from) });
      expect(r.code).toBe(2);
      const main = s.originMain();
      expect(r.line).toBe(`gh pr merge failed: Head branch was modified. Review and try the merge again.; nothing merged, so backend went out again from main at ${main.slice(0, 10)}`);
      expect(from).toEqual([from[0], main]);
      expect(s.posts.find((p) => p.path === "/cli/deploys/ship-pass")!.body).toMatchObject({ pushed: main, deploys: [{ name: "convex", ok: true, target: "backend" }] });
      // All of it under the lease, released last.
      expect(s.posts.at(-1)).toMatchObject({ path: "/cli/repo-lease", body: { op: "release" } });
    } finally { s.done(); }
  }, T);

  test("a lease lost before the merge refuses (exit 2): main goes out again if the lease is taken back, else the line says what is deployed", async () => {
    for (const back of [true, false]) {
      const s = setup();
      try {
        s.profile("deploy");
        const head = s.branch("api/route.ts", "export {}\n");
        s.ci(head);
        let renews = 0;
        // The first renew (before the step) holds; the next (before the merge) finds another holder.
        s.answers["/cli/repo-lease"] = (body) => body.op === "release" ? { released: true }
          : body.op === "renew" ? (++renews === 1 ? { held: true, expires_at: 0 } : { held: false, holder: "the merge of PR #9 on host-2", since: 0, expires_at: 0 })
          : renews === 0 || back ? { held: true, expires_at: 0 } : { held: false, holder: "the merge of PR #9 on host-2", since: 0, expires_at: 0 };
        const from: string[] = [];
        const r = await s.run({ leaseWaitMs: 1, runStep: async (_cmd, cwd) => { from.push(s.git(cwd, "rev-parse", "HEAD")); return { code: 0, output: "" }; } });
        expect(r.code).toBe(2);
        expect(s.merged()).toBe(false);
        const lost = "the lease on o/r's deploys was lost before the merge";
        if (back) {
          expect(r.line).toBe(`${lost}; nothing merged, so backend went out again from main at ${s.originMain().slice(0, 10)}`);
          expect(from).toHaveLength(2);
        } else {
          expect(r.line).toBe(`${lost}; backend is deployed at ${from[0].slice(0, 10)} but nothing merged, and the lease on o/r's deploys could not be taken back, so it was not sent again from main`);
          expect(s.logged).toContain("the lease on o/r's deploys was lost after a step went out; waiting for it to send main again");
          expect(from).toHaveLength(1);
        }
      } finally { s.done(); }
    }
  }, { timeout: 120_000 });

  test("the steps come from main's line profile: a change that rewrites its own before-merge step still gets main's", async () => {
    const s = setup();
    try {
      s.profile("deploy-from-main");
      s.git(s.work, "checkout", "-q", "-b", BRANCH);
      s.write(s.work, ".codecast/workspace.toml", `[[ship.deploy]]\nname = "convex"\nwhen = ["nothing/**"]\nrun = "skip-the-deploy"\nstage = "before_push"\n`);
      const head = s.commit("api/route.ts", "export {}\n", "change edits its own deploy");
      s.git(s.work, "push", "-q", "origin", BRANCH);
      s.git(s.work, "checkout", "-q", "main");
      s.ci(head);
      const ran: string[] = [];
      const r = await s.run({ runStep: async (cmd) => { ran.push(cmd); return { code: 0, output: "" }; } });
      expect(r.code).toBe(0);
      expect(ran).toEqual(["deploy-from-main"]);
    } finally { s.done(); }
  }, T);

  test("main's [ship] holding a key this cast does not read (a misspelled deploy table) refuses (exit 2) and merges nothing", async () => {
    const s = setup();
    try {
      s.onMain({ ".codecast/workspace.toml": `[[ship.deploys]]\nname = "convex"\nwhen = ["api/**"]\nrun = "deploy"\nstage = "before_push"\n` });
      const head = s.branch("api/route.ts", "export {}\n");
      s.ci(head);
      const r = await s.run({ runStep: async () => { throw new Error("no step runs"); } });
      expect(r).toEqual({ code: 2, line: ".codecast/workspace.toml: [ship] 'deploys' is not a key this cast reads, so it does not ship: a newer cast's setting? cast update; a typo? fix it" });
      expect(s.merged()).toBe(false);
    } finally { s.done(); }
  }, T);

  test("a merge an earlier attempt landed before it could finish: rerun, it sends the before-merge steps again from main and records them", async () => {
    const s = setup();
    try {
      s.profile("deploy");
      const head = s.branch("api/route.ts", "export {}\n");
      s.ci(head);
      expect((await s.run({ runStep: async () => ({ code: 0, output: "" }) })).code).toBe(0);
      const landed = s.gh().mergeCommit!;
      s.posts.length = 0;
      const from: string[] = [];
      const r = await s.run({ runStep: async (_cmd, cwd) => { from.push(s.git(cwd, "rev-parse", "HEAD")); return { code: 0, output: "" }; } });
      expect(r).toEqual({ code: 0, line: landed });
      expect(from).toEqual([s.originMain()]);
      expect(s.posts.find((p) => p.path === "/cli/deploys/ship-pass")!.body).toMatchObject({ pushed: s.originMain(), deploys: [{ name: "convex", ok: true, target: "backend" }] });
    } finally { s.done(); }
  }, T);
});

describe("cast flow merge: one at a time, in a tree of its own", () => {
  test("waits for the repository's merge lock while a live station holds it, then merges", async () => {
    const s = setup();
    try {
      const head = s.branch("b.txt", "bee\n");
      s.ci(head);
      const holder = spawn("sleep", ["3"]);
      mkdirSync(join(s.work, ".git", "codecast"), { recursive: true });
      writeFileSync(join(s.work, ".git", "codecast", "merge.lock"), String(holder.pid));
      const started = Date.now();
      const r = await s.run();
      expect(r.code).toBe(0);
      expect(Date.now() - started).toBeGreaterThan(2000);
      expect(s.logged).toContain(`waiting for the merge already running in this checkout (pid ${holder.pid}) to finish`);
    } finally { s.done(); }
  }, T);

  test("the real scratch tree: marked as the station's own under the main checkout, set up only for a step, released after", async () => {
    const s = setup();
    try {
      s.profile("deploy");
      const head = s.branch("api/route.ts", "export {}\n");
      s.ci(head);
      const at: string[] = [];
      const { listStates } = await import("../workspace/contract.js");
      let marked: unknown = null;
      const r = await s.run({ scratch: undefined, runStep: async (_cmd, cwd) => {
        at.push(cwd);
        marked = listStates(s.work).find((w) => cwd.endsWith(w.name))?.purpose ?? null;
        return { code: 0, output: "" };
      } });
      expect(r.code).toBe(0);
      expect(at[0].startsWith(join(realpathSync(s.work), ".codecast", "worktrees", "merge-scratch-"))).toBe(true);
      expect(marked).toMatchObject({ kind: "merge-scratch", pid: process.pid });
      expect(listStates(s.work).map((w) => w.name)).toEqual([]);
      expect(s.git(s.work, "branch", "--list", "codecast/merge-scratch-*")).toBe("");
      expect(s.git(s.work, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length).toBe(1);
    } finally { s.done(); }
  }, { timeout: 180_000 });
});
