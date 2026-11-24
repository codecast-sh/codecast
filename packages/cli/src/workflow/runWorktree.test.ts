import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseWorkflowSource } from "./parser.js";
import { lineRunDir, runWorkflow } from "./runner.js";
import { releaseEndedRunTree, restoreRunWorktree, stopRunBrowser, usesRunTree } from "./runWorktree.js";

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

  // ct-68695: `cast land prune` read the tree of a run waiting 8 days at the Eval wallet as stale, freed its branch
  // name and kept the head under refs/codecast/land-archive/; Eval then failed on "Workspace not found".
  test("pruned with its branch, it comes back from the land archive ref on the run's branch", async () => {
    const built = git(repoRoot, "rev-parse", BRANCH);
    git(repoRoot, "update-ref", `refs/codecast/land-archive/${BRANCH}`, built);
    git(repoRoot, "worktree", "remove", "--force", tree());
    git(repoRoot, "branch", "-D", BRANCH);
    expect(await restoreRunWorktree(repoRoot, NAME, BRANCH)).toBe("restored");
    expect(git(tree(), "rev-parse", "HEAD")).toBe(built);
    expect(git(tree(), "rev-parse", "--abbrev-ref", "HEAD")).toBe(BRANCH);
  });

  test("with neither the branch nor an archive of it, there is nothing to put back", async () => {
    git(repoRoot, "worktree", "remove", "--force", tree());
    git(repoRoot, "branch", "-D", BRANCH);
    expect(await restoreRunWorktree(repoRoot, NAME, BRANCH)).toBe("no_branch");
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

  // ct-98941: a station that starts its workspace's Chrome (`cast ws browser`) leaves none running for the
  // stations after it, so a run parked at a gate, on CI or at Go live holds no browser.
  test("a browser a station starts is stopped when that station ends, and none is left when the run ends", async () => {
    const name = "line-ct-9";
    fs.mkdirSync(path.join(repoRoot, ".codecast"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".codecast", "workspace.toml"), "[browser]\nenabled = true\n\n[browser.cdp_port]\nbase = 38900\nrange = 100\n");
    git(repoRoot, "add", ".");
    git(repoRoot, "commit", "-qm", "manifest");
    const { acquireWorkspace } = await import("../workspace/lifecycle.js");
    await acquireWorkspace(repoRoot, name, { branch: `codecast/${name}`, skipSetup: true, skipHooks: true, skipPool: true });
    // A stand-in Chrome: binds its CDP port and sleeps.
    const fake = path.join(repoRoot, "fake-chrome");
    fs.writeFileSync(fake, `#!${process.execPath}\nconst port = Number(process.argv.find((a) => a.startsWith("--remote-debugging-port="))!.split("=")[1]);\nBun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });\nsetInterval(() => {}, 1 << 30);\n`, { mode: 0o755 });
    // What `cast ws browser <name>` does, run by the station itself.
    const starter = path.join(repoRoot, "start-browser.ts");
    fs.writeFileSync(starter, `import { startWorkspaceBrowser } from ${JSON.stringify(path.join(import.meta.dir, "..", "workspace", "lifecycle.ts"))};\nconst c = await startWorkspaceBrowser(process.argv[2], process.argv[3]);\nawait Bun.write(process.argv[4], String(c.pid));\nprocess.exit(0);\n`);
    const graph = parseWorkflowSource(`digraph line {
      start [shape=Mdiamond]
      build [label="Build", backend=session, agent=claude, prompt="build it", isolated=true]
      browse [shape=parallelogram, script="mkdir -p $run_dir && ${process.execPath} ${starter} ${repoRoot} $worktree $run_dir/pid"]
      after [shape=parallelogram, script="kill -0 $(cat $run_dir/pid) 2>/dev/null && echo alive > $run_dir/after.txt || echo gone > $run_dir/after.txt"]
      exit [shape=Msquare]
      start -> build -> browse -> after -> exit
    }`);
    const savedChromium = process.env.CODECAST_CHROMIUM;
    process.env.CODECAST_CHROMIUM = fake;
    const fetched = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
    const log = console.log;
    console.log = () => {};
    try {
      const done = (node_id: string, completed_at: number) => ({ node_id, status: "completed", completed_at });
      const outcome = await runWorkflow(graph, {
        cwd: repoRoot, runId: "run-1", runSession: "conv_run", taskId: "ct-9", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1,
        resume: { status: "running", current_node_id: "browse", node_statuses: [done("start", 1), done("build", 2)] },
      } as any);
      expect(outcome).toBe("completed");
    } finally {
      globalThis.fetch = fetched;
      console.log = log;
      if (savedChromium === undefined) delete process.env.CODECAST_CHROMIUM; else process.env.CODECAST_CHROMIUM = savedChromium;
    }
    const pid = Number(fs.readFileSync(path.join(lineRunDir(repoRoot, name), "pid"), "utf8"));
    expect(pid).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(lineRunDir(repoRoot, name), "after.txt"), "utf8").trim()).toBe("gone");
    const { readState } = await import("../workspace/contract.js");
    expect(readState(repoRoot, name)?.chrome).toBeUndefined();
    expect(readState(repoRoot, name)?.env.CDP_PORT).toBeUndefined();
  }, 30000);

  test("a run whose worktree has no browser stops nothing", async () => {
    expect(await stopRunBrowser(repoRoot, { worktree: NAME })).toBe(false);
    expect(await stopRunBrowser(repoRoot, {})).toBe(false);
    expect(await stopRunBrowser(os.tmpdir(), { worktree: NAME })).toBe(false);
  });

  // Nov 20 and Nov 23: every line run built its tree at Start, and the 300+ runs waiting at Queue for 4 build places
  // filled the Union line hosts' disks. A run now starts with its branch alone (lineTrialBranch.ts freshRunBranch).
  // Shaped like Union's onefix: Problem and Harm are scripts, Triage a session in the checkout, Queue a long wait, and
  // Build the one isolated station. A probe records, without naming $worktree, whether the run's tree exists.
  const RUN = "line-ct-9";
  const probe = (at: string) => `mkdir -p $run_dir && { test -d "$(git rev-parse --show-toplevel)/.codecast/worktrees/${RUN}" && echo tree || echo none; } > $run_dir/${at}.txt`;
  const seen = (at: string) => fs.readFileSync(path.join(lineRunDir(repoRoot, RUN), `${at}.txt`), "utf8").trim();
  const runTree = () => path.join(repoRoot, ".codecast", "worktrees", RUN);
  // Each isolated hand the run asked for, and whether its tree was there when it asked.
  let isolatedSpawns: boolean[] = [];
  const runQuietly = async (graph: ReturnType<typeof parseWorkflowSource>, extra: Record<string, unknown> = {}) => {
    const fetched = globalThis.fetch;
    isolatedSpawns = [];
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      if (typeof init?.body === "string" && JSON.parse(init.body).worktree_name === RUN) isolatedSpawns.push(fs.existsSync(runTree()));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const log = console.log;
    console.log = () => {};
    try {
      return await runWorkflow(graph, { cwd: repoRoot, runId: "run-1", runSession: "conv_run", taskId: "ct-9", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1, ...extra } as any);
    } finally {
      globalThis.fetch = fetched;
      console.log = log;
    }
  };
  const done = (node_id: string, completed_at: number) => ({ node_id, status: "completed", completed_at });

  test("a run that starts with its branch alone has no tree until its first isolated station, which makes it on that branch", async () => {
    const graph = parseWorkflowSource(`digraph line {
      start [shape=Mdiamond]
      bind [shape=parallelogram, script="${probe("bind").replace(/"/g, '\\"')}"]
      triage [label="Triage", backend=session, agent=claude, prompt="is it real"]
      harm [shape=parallelogram, script="${probe("harm").replace(/"/g, '\\"')}"]
      queue [shape=parallelogram, script="${probe("queue").replace(/"/g, '\\"')}"]
      build [label="Build", backend=session, agent=claude, prompt="build it", isolated=true]
      built [shape=parallelogram, script="mkdir -p $run_dir && t=$(git rev-parse --show-toplevel)/.codecast/worktrees/${RUN} && git -C $t rev-parse --abbrev-ref HEAD > $run_dir/built.txt && git -C $t rev-parse HEAD >> $run_dir/built.txt"]
      exit [shape=Msquare]
      start -> bind -> triage -> harm -> queue -> build -> built -> exit
    }`);
    const started = git(repoRoot, "rev-parse", "HEAD");
    git(repoRoot, "branch", "--no-track", `codecast/${RUN}`, started);
    // The checkout moves on while the run waits, so a tree cut from its HEAD would be the wrong one.
    git(repoRoot, "commit", "-q", "--allow-empty", "-m", "later on main");
    expect(await runQuietly(graph)).toBe("completed");
    expect([seen("bind"), seen("harm"), seen("queue")]).toEqual(["none", "none", "none"]);
    expect(isolatedSpawns).toEqual([true]);
    expect(seen("built").split("\n")).toEqual([`codecast/${RUN}`, started]);
  }, 30000);

  test("after a sweep removed the tree, a station that does not use it leaves it gone, and one naming $worktree gets it back", async () => {
    const graph = parseWorkflowSource(`digraph line {
      start [shape=Mdiamond]
      build [label="Build", backend=session, agent=claude, prompt="build it", isolated=true]
      sweep [shape=parallelogram, script="git worktree remove --force \\"$(git rev-parse --show-toplevel)/.codecast/worktrees/${RUN}\\" && ${probe("swept").replace(/"/g, '\\"')}"]
      push [shape=parallelogram, script="mkdir -p $run_dir && git -C \\"$(git rev-parse --show-toplevel)/.codecast/worktrees/\${worktree}\\" rev-parse --abbrev-ref HEAD > $run_dir/push.txt"]
      exit [shape=Msquare]
      wait [shape=parallelogram, script="${probe("wait").replace(/"/g, '\\"')}"]
      start -> build -> sweep -> wait -> push -> exit
    }`);
    git(repoRoot, "branch", "--no-track", `codecast/${RUN}`, "HEAD");
    expect(await runQuietly(graph)).toBe("completed");
    expect(seen("swept")).toBe("none");
    expect(seen("wait")).toBe("none");
    expect(seen("push")).toBe(`codecast/${RUN}`);
  }, 30000);

  test("a resume at a station that uses the tree puts it back; a resume at one that does not leaves it gone", async () => {
    const graph = parseWorkflowSource(`digraph line {
      start [shape=Mdiamond]
      build [label="Build", backend=session, agent=claude, prompt="build it", isolated=true]
      deploy [shape=parallelogram, script="${probe("deploy").replace(/"/g, '\\"')}"]
      exit [shape=Msquare]
      start -> build -> deploy -> exit
    }`);
    git(repoRoot, "branch", "--no-track", `codecast/${RUN}`, "HEAD");
    const at = (node: string, completed: string[]) => runQuietly(graph, {
      resume: { status: "running", current_node_id: node, node_statuses: completed.map((id, i) => done(id, i + 1)) },
    });
    expect(await at("deploy", ["start", "build"])).toBe("completed");
    expect(seen("deploy")).toBe("none");
    expect(fs.existsSync(runTree())).toBe(false);
    expect(await at("build", ["start"])).toBe("completed");
    expect(seen("deploy")).toBe("tree");
  }, 30000);

  test("only stations that work in the run's tree use it: isolated, the subject's, a script or prompt naming $worktree, a fan-out to one", () => {
    const graph = parseWorkflowSource(`digraph onefix {
      start [shape=Mdiamond]
      bind [shape=parallelogram, script="bun nodes.ts problem --task $task_id"]
      triage [backend=session, agent=claude, prompt="Work only in your own worktree and branch."]
      queue [shape=parallelogram, script="bun nodes.ts queue --task $task_id --cap 4"]
      build [backend=session, agent=claude, isolated=true, prompt="build it"]
      critique [shape=component]
      c_reach [backend=session, agent=claude, prompt="git -C \\"$(cast ws path $worktree)\\" diff origin/main...HEAD"]
      c_intent [backend=session, agent=claude, prompt="read the card"]
      critique_done [shape=tripleoctagon]
      gate [shape=parallelogram, script="bun guard.ts gate --worktree \\"$(cast ws path \${worktree})\\""]
      other [shape=parallelogram, script="echo $worktree_path"]
      decide [shape=hexagon, prompt="$build.json.question"]
      fix [label="Fix", backend=subject, prompt="fix what the check found"]
      exit [shape=Msquare]
      start -> bind -> triage -> queue -> build -> critique
      critique -> c_reach -> critique_done
      critique -> c_intent -> critique_done
      critique_done -> gate -> other -> decide -> fix -> exit
    }`);
    const using = [...graph.nodes.values()].filter((n) => usesRunTree(n, graph)).map((n) => n.id).sort();
    expect(using).toEqual(["build", "c_reach", "critique", "fix", "gate"]);
  });

  test("with no branch left there is nothing to put back, and no checkout is made from main", async () => {
    fs.rmSync(tree(), { recursive: true, force: true });
    git(repoRoot, "worktree", "prune");
    git(repoRoot, "branch", "-D", BRANCH);
    expect(await restoreRunWorktree(repoRoot, NAME, BRANCH)).toBe("no_branch");
    expect(fs.existsSync(tree())).toBe(false);
  });
});

describe("a run's end", () => {
  const quiet = async (fn: () => Promise<void>) => { const log = console.log; console.log = () => {}; try { await fn(); } finally { console.log = log; } };
  function withOrigin(): void {
    const origin = path.join(repoRoot, "host-state", "origin.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    git(repoRoot, "remote", "add", "origin", origin);
    git(repoRoot, "push", "-q", "origin", "main");
    git(repoRoot, "fetch", "-q", "origin");
    git(repoRoot, "remote", "set-head", "origin", "main");
  }

  test("releases the run's tree once main holds its change, and keeps the branch", async () => {
    withOrigin();
    git(repoRoot, "push", "-q", "origin", `${BRANCH}:main`); // the run landed its change
    await quiet(() => releaseEndedRunTree(repoRoot, { worktree: NAME }));
    expect(fs.existsSync(tree())).toBe(false);
    expect(git(repoRoot, "worktree", "list")).not.toContain(NAME);
    expect(git(repoRoot, "branch", "--list", BRANCH)).toContain(BRANCH);
  }, 60_000); // lsof alone takes seconds on a loaded machine

  test("keeps a frozen change's tree as it is: its branch is the snapshot the run checked", async () => {
    withOrigin();
    const runDir = path.join(repoRoot, "host-state", "run");
    fs.mkdirSync(runDir, { recursive: true });
    const tip = git(repoRoot, "rev-parse", BRANCH);
    fs.writeFileSync(path.join(runDir, "change.json"), JSON.stringify({ worktree: NAME, branch: BRANCH, tip }));
    fs.writeFileSync(path.join(tree(), "outreach", "app.ts"), "export const v = 3;\n");
    await quiet(() => releaseEndedRunTree(repoRoot, { worktree: NAME, branch: BRANCH, run_dir: runDir }));
    expect(git(repoRoot, "rev-parse", BRANCH)).toBe(tip);
    expect(git(tree(), "status", "--porcelain")).toBe("M outreach/app.ts");
  }, 60_000);

  test("keeps a tree that is off its run's branch while it holds work main lacks, and commits nothing", async () => {
    withOrigin();
    git(tree(), "switch", "-q", "-c", "feature/elsewhere");
    fs.writeFileSync(path.join(tree(), "outreach", "app.ts"), "export const v = 3;\n");
    const tips = git(repoRoot, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/");
    await quiet(() => releaseEndedRunTree(repoRoot, { worktree: NAME }));
    expect(fs.readFileSync(path.join(tree(), "outreach", "app.ts"), "utf8")).toBe("export const v = 3;\n");
    expect(git(tree(), "status", "--porcelain")).toBe("M outreach/app.ts");
    expect(git(repoRoot, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/")).toBe(tips);
  }, 60_000);
});

// ct-99146: on Nov 22 the trees of a day's codecast_fix runs that ended without landing held all 40 port slots of a
// line host, each kept for its uncommitted work, and every run after them failed with "no free port".
describe("a run that ends without landing", () => {
  const FIX = "codecast-fix-ct-7";
  const fixTree = () => path.join(repoRoot, ".codecast", "worktrees", FIX);
  const OPTS = { skipSetup: true, skipHooks: true };
  const graphOf = (body: string) => parseWorkflowSource(`digraph codecast_fix {
    start [shape=Mdiamond]
    build [label="Build", backend=session, agent=claude, prompt="build it", isolated=true]
    leave [shape=parallelogram, script="cd \\"$(git rev-parse --show-toplevel)/.codecast/worktrees/$worktree\\" && printf 'export const v = 3;\\n' > outreach/app.ts && printf 'half a note\\n' > NOTES.md"]
    exit [shape=Msquare]
    ${body}
  }`);
  const done = (node_id: string, completed_at: number) => ({ node_id, status: "completed", completed_at });
  async function drive(graph: ReturnType<typeof parseWorkflowSource>, opts: Record<string, unknown>) {
    const fetched = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
    const log = console.log;
    console.log = () => {};
    try {
      return await runWorkflow(graph, { cwd: repoRoot, runId: "run-7", runSession: "conv_run", taskId: "ct-7", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1, ...opts } as any);
    } finally {
      globalThis.fetch = fetched;
      console.log = log;
    }
  }

  beforeEach(async () => {
    // One port in the host's range, so a tree that keeps its slot leaves none for the next run.
    fs.mkdirSync(path.join(repoRoot, ".codecast"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".codecast", "workspace.toml"), "[ports.web]\nbase = 47391\nrange = 1\n");
    // As codecast's own checkout has it: a workspace's setup logs and state are not work.
    fs.writeFileSync(path.join(repoRoot, ".gitignore"), ".codecast/*\n!.codecast/workspace.toml\n");
    git(repoRoot, "add", ".gitignore", ".codecast/workspace.toml");
    git(repoRoot, "commit", "-qm", "manifest");
    const { acquireWorkspace } = await import("../workspace/lifecycle.js");
    await acquireWorkspace(repoRoot, FIX, { ...OPTS, skipPool: true });
    fs.writeFileSync(path.join(fixTree(), "outreach", "app.ts"), "export const v = 2;\n");
    git(fixTree(), "commit", "-qam", "the built change");
  });

  test("commits what its tree left uncommitted to its own branch, frees the tree and its port slot, and `cast ws acquire` puts the same content back", async () => {
    const { acquireWorkspace, releaseWorkspace } = await import("../workspace/lifecycle.js");
    const { readState } = await import("../workspace/contract.js");
    const main = git(repoRoot, "rev-parse", "main");
    expect(readState(repoRoot, FIX)?.ports.web).toBe(47391);
    // The run makes its change, leaves part of it uncommitted, and finishes at Exit without shipping.
    const outcome = await drive(graphOf("start -> build -> leave -> exit"), {
      resume: { status: "running", current_node_id: "leave", node_statuses: [done("start", 1), done("build", 2)] },
    });
    expect(outcome).toBe("completed");

    expect(fs.existsSync(fixTree())).toBe(false);
    expect(readState(repoRoot, FIX)).toBeNull();
    expect(git(repoRoot, "worktree", "list")).not.toContain(FIX);
    const branch = `codecast/${FIX}`;
    expect(git(repoRoot, "log", "-1", "--format=%s", branch)).toBe("Left uncommitted when the run on ct-7 ended (run run-7)");
    expect(git(repoRoot, "show", `${branch}:outreach/app.ts`)).toBe("export const v = 3;");
    expect(git(repoRoot, "show", `${branch}:NOTES.md`)).toBe("half a note");
    expect(git(repoRoot, "rev-parse", "main")).toBe(main);
    // Its port slot is free: another workspace takes the host's one port.
    const other = await acquireWorkspace(repoRoot, "another-run", { ...OPTS, skipPool: true });
    expect(other.workspace.ports.web).toBe(47391);
    await releaseWorkspace(repoRoot, "another-run");

    // `cast ws acquire codecast-fix-ct-7`: the tree comes back on the run's branch with what it held.
    const back = await acquireWorkspace(repoRoot, FIX, OPTS);
    expect(back.workspace.path).toBe(fixTree());
    expect(git(fixTree(), "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
    expect(git(fixTree(), "status", "--porcelain")).toBe("");
    expect(fs.readFileSync(path.join(fixTree(), "outreach", "app.ts"), "utf8")).toBe("export const v = 3;\n");
    expect(fs.readFileSync(path.join(fixTree(), "NOTES.md"), "utf8")).toBe("half a note\n");
  }, 90_000);

  test("parked at its gate when its runner went away, its tree is released and the resume with the answer restores the same content", async () => {
    const graph = graphOf(`
      decide [label="Decide", shape=hexagon]
      ship [shape=parallelogram, script="mkdir -p $run_dir && cd \\"$(git rev-parse --show-toplevel)/.codecast/worktrees/$worktree\\" && cat outreach/app.ts NOTES.md > $run_dir/shipped.txt && git status --porcelain -uall > $run_dir/status.txt"]
      start -> build -> leave -> decide
      decide -> ship [label="[S] Ship"]
      ship -> exit`);
    // The runner goes away as the run reaches its gate (a fresh runner takes over, or it crashes): its end runs as any run's does.
    const left = () => fs.existsSync(path.join(fixTree(), "NOTES.md")) || !fs.existsSync(fixTree());
    await expect(drive(graph, {
      resume: { status: "running", current_node_id: "leave", node_statuses: [done("start", 1), done("build", 2)] },
      loadedFlowVersions: "v1",
      pinnedFlowVersions: async () => (left() ? "v2" : "v1"),
      continueFresh: async () => { throw new Error("the runner went away at the gate"); },
    })).rejects.toThrow("went away");
    expect(fs.existsSync(fixTree())).toBe(false);
    expect(git(repoRoot, "show", `codecast/${FIX}:NOTES.md`)).toBe("half a note");

    // The daemon resumes the paused run once its card is answered: the tree is back before the next station that uses it.
    const outcome = await drive(graph, {
      resume: { status: "running", current_node_id: "decide", gate_node_id: "decide", gate_response: "S", node_statuses: [done("start", 1), done("build", 2), done("leave", 3)] },
    });
    expect(outcome).toBe("completed");
    const runDir = lineRunDir(repoRoot, FIX);
    expect(fs.readFileSync(path.join(runDir, "shipped.txt"), "utf8")).toBe("export const v = 3;\nhalf a note\n");
    expect(fs.readFileSync(path.join(runDir, "status.txt"), "utf8")).toBe("");
  }, 90_000);
});
