import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseWorkflowSource } from "./parser.js";
import { lineRunDir, runWorkflow } from "./runner.js";
import { restoreRunWorktree } from "./runWorktree.js";

// Real git: what matters is git's own refusal to check out a branch whose
// removed worktree it still lists, and that the branch's commits come back.
let repoRoot: string;
let savedDir: string | undefined;
const NAME = "agentwatch-ct-1";
const BRANCH = `codecast/${NAME}`;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tree = () => path.join(repoRoot, ".codecast", "worktrees", NAME);

beforeEach(() => {
  repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "run-wt-")));
  savedDir = process.env.CODECAST_DIR;
  process.env.CODECAST_DIR = path.join(repoRoot, "host-state");
  git(repoRoot, "init", "-q", "-b", "main");
  git(repoRoot, "config", "user.email", "t@t.t");
  git(repoRoot, "config", "user.name", "t");
  fs.mkdirSync(path.join(repoRoot, "outreach"));
  fs.writeFileSync(path.join(repoRoot, "outreach", "app.ts"), "export const v = 1;\n");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-qm", "init");
  // The run built its change on its branch in its own worktree, then waited at its card.
  git(repoRoot, "worktree", "add", "-q", "-b", BRANCH, tree());
  fs.writeFileSync(path.join(tree(), "outreach", "app.ts"), "export const v = 2;\n");
  git(tree(), "commit", "-qam", "the built change");
});

afterEach(() => {
  try { git(repoRoot, "worktree", "prune"); } catch {}
  fs.rmSync(repoRoot, { recursive: true, force: true });
  if (savedDir === undefined) delete process.env.CODECAST_DIR;
  else process.env.CODECAST_DIR = savedDir;
});

describe("a resumed run's worktree", () => {
  test("removed by hand while the run waited, it comes back on the run's branch with the built change", async () => {
    const built = git(repoRoot, "rev-parse", BRANCH);
    fs.rmSync(tree(), { recursive: true, force: true });
    expect(await restoreRunWorktree(path.join(repoRoot, "outreach"), NAME, BRANCH)).toBe("restored");
    expect(git(tree(), "rev-parse", "HEAD")).toBe(built);
    expect(git(tree(), "rev-parse", "--abbrev-ref", "HEAD")).toBe(BRANCH);
    expect(fs.readFileSync(path.join(tree(), "outreach", "app.ts"), "utf8")).toBe("export const v = 2;\n");
    expect(await restoreRunWorktree(repoRoot, NAME, BRANCH)).toBe("present");
  });

  test("a run resumed past its card finds the checkout at its next station", async () => {
    const graph = parseWorkflowSource(`digraph line {
      start [shape=Mdiamond]
      build [label="Build", backend=session, agent=claude, prompt="build it", isolated=true]
      decide [label="Decide", shape=hexagon]
      ship [shape=parallelogram, script="mkdir -p $run_dir && git -C \\"$(git rev-parse --show-toplevel)/.codecast/worktrees/$worktree\\" log -1 --format=%s > $run_dir/shipped.txt"]
      exit [shape=Msquare]
      start -> build -> decide
      decide -> ship [label="[S] Ship"]
      ship -> exit
    }`);
    // The run's worktree is named for its graph and task: line-ct-9.
    const name = "line-ct-9";
    git(repoRoot, "worktree", "add", "-q", "-b", `codecast/${name}`, path.join(repoRoot, ".codecast", "worktrees", name));
    git(path.join(repoRoot, ".codecast", "worktrees", name), "commit", "-q", "--allow-empty", "-m", "the approved change");
    fs.rmSync(path.join(repoRoot, ".codecast", "worktrees", name), { recursive: true, force: true });
    const fetched = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
    const log = console.log;
    console.log = () => {};
    try {
      const done = (node_id: string, completed_at: number) => ({ node_id, status: "completed", completed_at });
      const outcome = await runWorkflow(graph, {
        cwd: repoRoot, runId: "run-1", runSession: "conv_run", taskId: "ct-9", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1,
        resume: { status: "running", current_node_id: "ship", node_statuses: [done("start", 1), done("build", 2), done("decide", 3)] },
      } as any);
      expect(outcome).toBe("completed");
    } finally {
      globalThis.fetch = fetched;
      console.log = log;
    }
    expect(fs.readFileSync(path.join(lineRunDir(repoRoot, name), "shipped.txt"), "utf8").trim()).toBe("the approved change");
  }, 30000);

  test("with no branch left there is nothing to put back, and no checkout is made from main", async () => {
    fs.rmSync(tree(), { recursive: true, force: true });
    git(repoRoot, "worktree", "prune");
    git(repoRoot, "branch", "-D", BRANCH);
    expect(await restoreRunWorktree(repoRoot, NAME, BRANCH)).toBe("no_branch");
    expect(fs.existsSync(tree())).toBe(false);
  });
});
