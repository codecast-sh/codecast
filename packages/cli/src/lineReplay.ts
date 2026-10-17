// Replay: one station of a line graph run again on frozen past cases, on two
// versions of the graph's files at once, so a prompt change is measured
// before it reaches a live run (learning-loop.md LL14).
//
// A case is a past run that reached the station. Its brief is rendered from
// the run's checkpoint on this machine the way a resumed run renders it: the
// graph parsed from the arm's files, every `refresh` command station the run
// made run again in the arm's tree (so `_shared.md` is read as that arm has
// it), then stationBrief. Each brief runs through the dry-run harness
// (prompt-dry-run.ts --read-only: writes and every connection but the
// model's refused, cast writes refused and logged), in the checkout the
// station read. What it decided is read from its pin (lineTry.ts).
//
// The two arms are the graph's files at a git revision (`base`, HEAD by
// default) and as they are on disk (`work`), or with edited copies laid over
// them (`overlay`), so an edit is measured before it reaches a live run. Each case's replays alternate
// arms. A case passes when its pinned fields match its `expect` and, with a
// `grade` question, a model reading the replay blind to its arm answers yes.
// The verdict is a one-sided Fisher test of work's passes against base's.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "./proc.js";
import { decisionFromRun, findCheckpointFile, harnessScriptPath, refusedCalls, type TryDecision } from "./lineTry.js";
import { extractJsonOutput } from "./workflow/condition.js";

export type ReplayCase = {
  run: string;
  /** Pinned fields and the values that pass, e.g. { "outcome": ["red", "infeasible"] }. */
  expect?: Record<string, string | string[]>;
  /** A yes/no question about what the replay did; yes passes. */
  grade?: string;
  why?: string;
};

/** A line's frozen cases, by station (`cases.json` beside the graph). */
export type CasesFile = Record<string, ReplayCase[]>;

export type Arm = "base" | "work";

export type ReplayResult = {
  run: string;
  arm: Arm;
  rep: number;
  status: "done" | "failed" | "not_replayable";
  reason?: string;
  decision?: TryDecision | null;
  expect_ok?: boolean | null;
  grade?: { answer: "yes" | "no" | null; why: string } | null;
  pass?: boolean;
  cost_usd?: number;
  minutes?: number;
  refused?: number;
  dir?: string;
};

// ── scoring ──────────────────────────────────────────────────────────────────

/** Whether each expected field of the pin holds one of its values. Null when there is nothing to expect. */
export function expectHolds(result: Record<string, unknown> | null | undefined, expect: ReplayCase["expect"]): boolean | null {
  const keys = Object.keys(expect ?? {});
  if (!keys.length) return null;
  if (!result) return false;
  return keys.every((k) => {
    const want = expect![k];
    const got = result[k];
    return (Array.isArray(want) ? want : [want]).some((w) => String(got ?? "") === w);
  });
}

/** A replay passes on what its case asks: the pinned fields, the grade, or both. */
export function passes(c: ReplayCase, expectOk: boolean | null, grade: ReplayResult["grade"]): boolean {
  if (expectOk === false) return false;
  if (c.grade) return grade?.answer === "yes";
  return expectOk === true;
}

export type ArmTally = { n: number; pass: number; failed: number; cost_usd: number };

export function tally(results: ReplayResult[]): Record<Arm, ArmTally> {
  const t: Record<Arm, ArmTally> = { base: { n: 0, pass: 0, failed: 0, cost_usd: 0 }, work: { n: 0, pass: 0, failed: 0, cost_usd: 0 } };
  for (const r of results) {
    const a = t[r.arm];
    a.cost_usd += r.cost_usd ?? 0;
    if (r.status !== "done") { a.failed++; continue; }
    a.n++;
    if (r.pass) a.pass++;
  }
  return t;
}

// ── the arms ─────────────────────────────────────────────────────────────────

/**
 * The checkout with the graph's directory as `rev` had it (null: as it is on
 * disk), and `overlay`'s files laid over it: a tree under `into` where that
 * directory is a copy and every other entry of `root` is a link to the real
 * one, so a station's script (`bun line/x/nodes.ts shared`) runs on the
 * arm's files and imports the real code beside them.
 */
export function armTree(root: string, graphDir: string, rev: string | null, into: string, overlay?: string): string {
  const rel = path.relative(root, graphDir);
  const top = rel.split(path.sep)[0];
  if (!top || top.startsWith("..")) throw new Error(`${graphDir} is not inside ${root}`);
  fs.rmSync(into, { recursive: true, force: true });
  fs.mkdirSync(path.join(into, rel), { recursive: true });
  for (const e of fs.readdirSync(root)) if (e !== top) fs.symlinkSync(path.join(root, e), path.join(into, e));
  // Siblings of the path down to the graph's directory are links too.
  for (let at = top, parts = rel.split(path.sep).slice(1); parts.length; at = path.join(at, parts.shift()!)) {
    for (const e of fs.readdirSync(path.join(root, at))) {
      if (e !== parts[0]) fs.symlinkSync(path.join(root, at, e), path.join(into, at, e));
    }
  }
  if (rev) {
    const gitTop = git(root, ["rev-parse", "--show-toplevel"]);
    const treeish = `${rev}:${path.relative(gitTop, fs.realpathSync(graphDir))}`;
    const tar = spawnSync("bash", ["-c", 'git -C "$1" archive "$2" | tar -x -C "$3"', "archive", gitTop, treeish, path.join(into, rel)], { encoding: "utf8" });
    if (tar.status !== 0) throw new Error(`could not read ${treeish}: ${(tar.stderr || "").trim()}`);
  } else fs.cpSync(graphDir, path.join(into, rel), { recursive: true });
  if (overlay) fs.cpSync(overlay, path.join(into, rel), { recursive: true });
  return into;
}

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${(r.stderr || "").trim()}`);
  return r.stdout.trim();
}

/** A run's checkpoint, and the branch its isolated stations worked on: the run dir's name under `codecast/` (runner.ts lineRunDir). */
type Checkpoint = { context: Record<string, string>; completed: string[]; branch?: string };

export function readCheckpoint(root: string, runId: string): Checkpoint | null {
  const file = findCheckpointFile(root, runId);
  if (!file) return null;
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!d?.context || typeof d.context !== "object") return null;
    return { context: d.context, completed: Array.isArray(d.completed) ? d.completed : [], branch: `codecast/${path.basename(path.dirname(path.dirname(file)))}` };
  } catch {
    return null;
  }
}

/**
 * The brief the station gets from `tree`'s files on the run's checkpoint, as
 * a resumed run renders it, with the station's model and the directory it
 * worked in. A reason instead when the run cannot be replayed here.
 */
export async function armBrief(tree: string, castRel: string, station: string, ck: Checkpoint): Promise<{ brief: string; model: string; isolated: boolean; timeoutMs: number } | { reason: string }> {
  const [{ parseWorkflowFile }, { stationBrief, refreshedOnResume, expandScriptVars, recordNodeOutput }] = await Promise.all([
    import("./workflow/parser.js"), import("./workflow/runner.js"),
  ]);
  const graph = parseWorkflowFile(path.join(tree, castRel));
  const node = graph.nodes.get(station);
  if (!node?.prompt) return { reason: `${castRel} has no station "${station}" with a prompt` };
  if (!ck.completed.includes(station) && ck.context[`${station}.visits`] === undefined) return { reason: `the run never reached ${station}` };
  const context = { ...ck.context };
  for (const n of refreshedOnResume(graph, ck.completed)) {
    const r = spawnSync("bash", ["-c", expandScriptVars(n.script!, context)], { cwd: tree, encoding: "utf8", timeout: (n.timeout ?? 120) * 1000 });
    if (r.status !== 0) return { reason: `${n.id} did not run: ${((r.stderr || r.stdout || "").trim().split("\n").pop() ?? "").slice(0, 300)}` };
    recordNodeOutput(context, n.id, ((r.stdout || "") + (r.stderr || "")).trim(), r.stdout || "");
  }
  if (graph.goal) graph.goal = graph.goal.replace(/\$(\w+)/g, (_, key) => context[key] || `$${key}`);
  return { brief: stationBrief(node, graph, context), model: node.model || "opus", isolated: node.isolated === true, timeoutMs: (node.timeout ?? 3600) * 1000 + 10 * 60_000 };
}

/**
 * Where a replay's station works: the project, or for an isolated station a
 * clone of the run's branch as the run left it, made inside the replay's own
 * directory, the one place the sandbox lets it write. So it can commit its
 * check there, and nothing it does reaches the real repository. The clone
 * borrows the repository's objects and links its installed dependencies.
 */
export function replayCwd(root: string, ck: Checkpoint, isolated: boolean, dir: string): { cwd: string } | { reason: string } {
  const project = ck.context.project_path && fs.existsSync(ck.context.project_path) ? ck.context.project_path : root;
  if (!isolated) return { cwd: project };
  const top = git(project, ["rev-parse", "--show-toplevel"]);
  const sha = ck.branch ? spawnSync("git", ["-C", top, "rev-parse", "--verify", "--quiet", ck.branch], { encoding: "utf8" }) : null;
  if (!sha || sha.status !== 0) return { reason: `the run's branch ${ck.branch ?? "(unknown)"} is not in this repository` };
  const tree = path.join(dir, "tree");
  git(dir, ["clone", "--quiet", "--shared", "--no-checkout", top, tree]);
  git(tree, ["checkout", "--quiet", "--detach", sha.stdout.trim()]);
  const origin = spawnSync("git", ["-C", top, "rev-parse", "origin/main"], { encoding: "utf8" });
  if (origin.status === 0) git(tree, ["update-ref", "refs/remotes/origin/main", origin.stdout.trim()]);
  const installed = spawnSync("find", [top, "-maxdepth", "4", "-path", path.join(top, ".git"), "-prune", "-o", "-type", "d", "-name", "node_modules", "-print", "-prune"], { encoding: "utf8" });
  for (const nm of installed.stdout.split("\n").filter(Boolean)) {
    const rel = path.relative(top, nm);
    if (fs.existsSync(path.join(tree, path.dirname(rel))) && !fs.existsSync(path.join(tree, rel))) fs.symlinkSync(nm, path.join(tree, rel));
  }
  return { cwd: path.join(tree, path.relative(top, project)) };
}

// ── one replay ───────────────────────────────────────────────────────────────

const GRADE_MODEL = "sonnet";

/** The grader's prompt: the question, then what the agent wrote and ran. Nothing says which version of the prompt it had. */
export function gradePrompt(question: string, said: string[], calls: string[], decision: TryDecision | null): string {
  return [
    "Below is the record of one unattended agent working a task: every message it wrote and every `cast` command it ran (writes were refused, so a refused command is still what it tried). Answer one question about what it did, from this record alone.",
    "",
    `Question: ${question}`,
    "",
    'Reply with only a JSON object: {"answer": "yes" or "no", "why": "<one sentence citing the record>"}.',
    "",
    "## Its cast commands",
    calls.join("\n").slice(0, 20_000) || "(none)",
    "",
    "## What it pinned at the end",
    decision ? JSON.stringify(decision).slice(0, 6000) : "(nothing)",
    "",
    "## Its messages, in order",
    said.join("\n\n---\n\n").slice(-60_000),
  ].join("\n");
}

export type ReplayDeps = {
  harness: (argv: string[], opts: { cwd: string; timeoutMs?: number }) => Promise<number>;
  harnessScript: string;
};

function readIn(dir: string, f: string): string {
  try { return fs.readFileSync(path.join(dir, f), "utf8"); } catch { return ""; }
}

type Brief = Awaited<ReturnType<typeof armBrief>>;

export async function replayOnce(c: ReplayCase, arm: Arm, rep: number, brief: Brief, where: (dir: string, isolated: boolean) => { cwd: string } | { reason: string }, dir: string, deps: ReplayDeps): Promise<ReplayResult> {
  const base = { run: c.run, arm, rep, dir };
  if ("reason" in brief) return { ...base, status: "not_replayable", reason: brief.reason };
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const at = where(dir, brief.isolated);
  if ("reason" in at) return { ...base, status: "not_replayable", reason: at.reason };
  const promptFile = `${dir}.prompt.md`;
  fs.writeFileSync(promptFile, brief.brief);
  const started = Date.now();
  const code = await deps.harness([deps.harnessScript, "--run", dir, "--prompt", promptFile, "--model", brief.model, "--cwd", at.cwd, "--read-only"], { cwd: at.cwd, timeoutMs: brief.timeoutMs });
  let out: any = null;
  try { out = JSON.parse(readIn(dir, "out.json")); } catch { /* none */ }
  let said: string[] = [];
  try { said = JSON.parse(readIn(dir, "said.json")); } catch { /* none */ }
  const minutes = Math.round((Date.now() - started) / 6000) / 10;
  const cost_usd = typeof out?.total_cost_usd === "number" ? out.total_cost_usd : 0;
  if (!out && code !== 0) return { ...base, status: "failed", reason: ((readIn(dir, "err.txt") || readIn(dir, "harness.log")).trim().split("\n").pop() || `the dry run exited ${code}`).slice(0, 300), minutes, cost_usd };
  const decision = decisionFromRun(readIn(dir, "stream.jsonl"), said);
  const calls = readIn(dir, "calls.log").split("\n").filter((l) => /^(SERVED|UNSERVED|LIVE|REFUSED) /.test(l));
  const expect_ok = expectHolds(decision?.result, c.expect);
  let grade: ReplayResult["grade"] = null;
  if (c.grade) {
    const gdir = path.join(dir, "grade");
    fs.mkdirSync(gdir, { recursive: true });
    fs.writeFileSync(path.join(gdir, "prompt.md"), gradePrompt(c.grade, said, calls, decision));
    await deps.harness([deps.harnessScript, "--run", gdir, "--prompt", path.join(gdir, "prompt.md"), "--model", GRADE_MODEL, "--call"], { cwd: gdir, timeoutMs: 10 * 60_000 });
    let g: any = null;
    try { g = JSON.parse(readIn(gdir, "out.json")); } catch { /* none */ }
    const json = extractJsonOutput(String(g?.result ?? "")) as any;
    const answer = json?.answer === "yes" || json?.answer === "no" ? json.answer : null;
    grade = { answer, why: String(json?.why ?? g?.result ?? "no answer").slice(0, 400) };
  }
  return { ...base, status: "done", decision, expect_ok, grade, pass: passes(c, expect_ok, grade), cost_usd, minutes, refused: refusedCalls(readIn(dir, "calls.log")).length };
}

// ── the whole replay ─────────────────────────────────────────────────────────

export type ReplayArgs = {
  /** The directory a run's command stations run in (the project), and the graph in it. */
  root: string;
  cast: string;
  station: string;
  cases: ReplayCase[];
  /** The other arm's revision, or `disk` for the files on disk (beside an overlay); null replays the work arm alone. */
  base: string | null;
  /** Edited files laid over the graph's directory for the work arm, which is otherwise the files on disk. */
  overlay?: string;
  reps: number;
  out: string;
  concurrency?: number;
  log?: (line: string) => void;
};

export async function runReplay(a: ReplayArgs, deps: ReplayDeps): Promise<{ results: ReplayResult[]; tally: Record<Arm, ArmTally>; p: number | null }> {
  const castAbs = path.resolve(a.root, a.cast);
  const castRel = path.relative(a.root, castAbs);
  const trees: Partial<Record<Arm, string>> = { work: a.overlay ? armTree(a.root, path.dirname(castAbs), null, path.join(a.out, "work-tree"), a.overlay) : a.root };
  // `disk` is the files as they are, against an overlay of edits to them.
  if (a.base) trees.base = armTree(a.root, path.dirname(castAbs), a.base === "disk" ? null : a.base, path.join(a.out, "base-tree"));
  const arms = (Object.keys(trees) as Arm[]).sort();
  const jobs: Array<() => Promise<ReplayResult>> = [];
  for (const c of a.cases) {
    const ck = readCheckpoint(a.root, c.run);
    const briefs = new Map<Arm, Promise<Brief>>();
    const briefFor = (arm: Arm) => {
      if (!briefs.has(arm)) briefs.set(arm, ck ? armBrief(trees[arm]!, castRel, a.station, ck) : Promise.resolve({ reason: "this machine holds no checkpoint of the run" }));
      return briefs.get(arm)!;
    };
    const where = (dir: string, isolated: boolean) => replayCwd(a.root, ck!, isolated, dir);
    // Arms alternate within a case, so a slow hour or a busy login weighs on both alike.
    for (let rep = 1; rep <= a.reps; rep++) {
      for (const arm of rep % 2 ? arms : [...arms].reverse()) {
        jobs.push(async () => {
          const dir = path.join(a.out, c.run, `${arm}-${rep}`);
          const brief = await briefFor(arm);
          const r = await replayOnce(c, arm, rep, brief, where, dir, deps);
          // The clone is scratch: keep the record, drop the tree.
          fs.rmSync(path.join(dir, "tree"), { recursive: true, force: true });
          a.log?.(`${c.run} ${arm} #${rep}: ${r.status === "done" ? `${r.pass ? "pass" : "miss"} (${r.decision?.result?.outcome ?? r.decision?.status ?? "no pin"}${r.grade ? `, graded ${r.grade.answer}` : ""}) $${(r.cost_usd ?? 0).toFixed(2)} ${r.minutes}m` : `${r.status}: ${r.reason}`}`);
          fs.appendFileSync(path.join(a.out, "results.jsonl"), JSON.stringify(r) + "\n");
          return r;
        });
      }
    }
  }
  const results: ReplayResult[] = [];
  const queue = [...jobs];
  await Promise.all(Array.from({ length: Math.min(a.concurrency ?? 2, queue.length) }, async () => {
    for (let j = queue.shift(); j; j = queue.shift()) results.push(await j());
  }));
  const t = tally(results);
  const { fisherOneSided } = await import("@codecast/shared/contracts/judgeFix");
  const p = a.base ? fisherOneSided(t.work.pass, t.work.n, t.base.pass, t.base.n, "greater") : null;
  fs.writeFileSync(path.join(a.out, "summary.json"), JSON.stringify({ station: a.station, cast: castRel, base: a.base, overlay: a.overlay ?? null, reps: a.reps, tally: t, p }, null, 1) + "\n");
  return { results, tally: t, p };
}

export function replayDeps(): ReplayDeps {
  const harnessScript = harnessScriptPath();
  if (!harnessScript) throw new Error("this build of cast does not carry the dry-run harness (packages/cli/scripts/prompt-dry-run.ts)");
  // The harness's own words (why it refused, what it ran) go to harness.log in the run dir.
  return {
    harnessScript,
    harness: async (argv, opts) => {
      const dir = argv[argv.indexOf("--run") + 1];
      fs.mkdirSync(dir, { recursive: true });
      const fd = fs.openSync(path.join(dir, "harness.log"), "a");
      try {
        return await new Promise<number>((resolve) => {
          const child = spawn(path.basename(process.execPath) === "bun" ? process.execPath : "bun", argv, { cwd: opts.cwd, stdio: ["ignore", fd, fd] });
          const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* gone */ } }, opts.timeoutMs ?? 30 * 60_000);
          child.on("exit", (code) => { clearTimeout(timer); resolve(code ?? 1); });
          child.on("error", () => { clearTimeout(timer); resolve(127); });
        });
      } finally {
        fs.closeSync(fd);
      }
    },
  };
}

/** Where a replay's dirs go: outside any repository, since a brief can hold a customer's words. */
export function replayOutDir(station: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "codecast", "line-replay", `${stamp}-${station}`);
}
