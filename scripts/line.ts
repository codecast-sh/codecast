#!/usr/bin/env bun
// codecast's side of the line (docs/architecture/line-profile.md LP4), named
// by .codecast/line.toml. Both commands go through ./evals and run from the
// worktree root, the tree they measure.
//
//   bun scripts/line.ts prove --dir <run files> [--reps 5]
//   bun scripts/line.ts eval --base <branch> --dir <run files> [--reps n]
//   bun scripts/line.ts ship --base <branch> --tree <main checkout>
//
// prove: each miss freeze in <dir>/freezes.txt (one id per line) must fail by
// majority on this tree, which is still the base, and each guard in
// <dir>/guards.txt must pass. Writes <dir>/proven.json; exits 0 only when both
// hold. A freeze is made with
//   ./evals freeze create <surface>@<session>:<line> --judge "what a correct reply does"
// eval: `./evals line` on the surfaces the branch touches plus the miss
// freezes. It writes <dir>/reps.json, the file the contract names, and does
// the statistics only for its own report; the station's verdict is
// `cast line eval-result` over the same reps.
// ship: lands an approved change the way this repo works, in the main
// checkout's working tree beside everyone else's uncommitted work, never as a
// push; committing is a person's separate step. It applies the branch's diff
// against its merge base and prints the one line that goes on the task.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { majorityOf, repPassed } from "../packages/evals/src/adapters/replay";

const EVALS = path.resolve(import.meta.dir, "..", "evals");
const DEFAULT_PROVE_REPS = 5;

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  const v = i === -1 ? undefined : process.argv[i + 1];
  return v !== undefined && !v.startsWith("--") ? v : null;
}

function need(name: string): string {
  const v = arg(name);
  if (!v) fail(`--${name} is required`);
  return v;
}

function fail(message: string): never {
  console.error(`line: ${message}`);
  process.exit(1);
}

const ids = (file: string): string[] => (existsSync(file) ? readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter(Boolean) : []);

/** The JSON array `--json` prints after a replay's progress lines. */
export function replayRuns(stdout: string): Array<Parameters<typeof repPassed>[0]> | null {
  for (let at = stdout.lastIndexOf("["); at !== -1; at = at === 0 ? -1 : stdout.lastIndexOf("[", at - 1)) {
    if (at > 0 && stdout[at - 1] !== "\n") continue;
    try {
      const parsed = JSON.parse(stdout.slice(at));
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return null;
}

export interface ProvenEntry {
  freeze: string;
  kind: "miss" | "guard";
  /** Reps that passed, of the reps that scored. */
  passed: number;
  scored: number;
  ok: boolean;
  error?: string;
}

/** One freeze's entry: a miss is shown when it fails by majority, a guard holds when it passes by majority. */
export function provenEntry(freeze: string, kind: ProvenEntry["kind"], runs: Array<Parameters<typeof repPassed>[0]>): ProvenEntry {
  const reps = runs.filter((r) => r.status !== "crash" && r.status !== "unscored" && r.status !== "running").map((r) => ({ passed: repPassed(r), score: null, reply: "", judge_note: "", cost_usd: 0 }));
  const verdict = majorityOf(reps);
  const passed = reps.filter((r) => r.passed).length;
  if (verdict === undefined) return { freeze, kind, passed, scored: 0, ok: false, error: "no rep scored" };
  return { freeze, kind, passed, scored: reps.length, ok: kind === "miss" ? !verdict : verdict };
}

function prove(): void {
  const dir = need("dir");
  mkdirSync(dir, { recursive: true });
  const reps = Number(arg("reps") ?? DEFAULT_PROVE_REPS);
  const misses = ids(path.join(dir, "freezes.txt"));
  const guards = ids(path.join(dir, "guards.txt"));
  if (!misses.length) {
    fail(`no miss freezes in ${dir}/freezes.txt. Make each with ./evals freeze create <surface>@<session>:<line> --judge "what a correct reply does", then list the miss freeze ids there, one per line, and two or three guards (moments the prompt already gets right) in ${dir}/guards.txt`);
  }
  const entries: ProvenEntry[] = [];
  for (const [kind, list] of [["miss", misses], ["guard", guards]] as const) {
    for (const freeze of list) {
      console.error(`prove: ${kind} ${freeze}, ${reps} reps`);
      const r = spawnSync(EVALS, ["freeze", "replay", freeze, "--reps", String(reps), "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      const runs = r.status === 0 ? replayRuns(r.stdout ?? "") : null;
      entries.push(runs ? provenEntry(freeze, kind, runs) : { freeze, kind, passed: 0, scored: 0, ok: false, error: `./evals freeze replay exited ${r.status}: ${(r.stderr || r.stdout || "").trim().split("\n").pop() ?? ""}` });
    }
  }
  const reasons = entries.filter((e) => !e.ok).map((e) =>
    e.error ? `${e.kind} ${e.freeze}: ${e.error}`
      : e.kind === "miss" ? `miss ${e.freeze} passes on the base (${e.passed}/${e.scored}), so it shows no miss`
        : `guard ${e.freeze} fails on the base (${e.passed}/${e.scored})`);
  const ok = reasons.length === 0;
  writeFileSync(path.join(dir, "proven.json"), `${JSON.stringify({ ok, reps, entries, reasons }, null, 2)}\n`);
  console.log(JSON.stringify({ ok, proven: path.join(dir, "proven.json"), misses: misses.length, guards: guards.length, reasons }));
  if (!ok) process.exit(1);
}

function evalBranch(): void {
  const dir = need("dir");
  mkdirSync(dir, { recursive: true });
  const freezes = ids(path.join(dir, "freezes.txt"));
  const reps = arg("reps");
  const r = spawnSync(EVALS, [
    "line", "--base", need("base"),
    "--out", path.join(dir, "eval-result.json"),
    "--reps-out", path.join(dir, "reps.json"),
    ...freezes.flatMap((f) => ["--freeze", f]),
    ...(reps ? ["--reps", reps] : []),
  ], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

function git(cwd: string, args: string[], input?: string): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? "", err: (r.stderr ?? "").trim() };
}

function ship(): void {
  const tree = need("tree");
  const cwd = process.cwd();
  const base = git(cwd, ["merge-base", need("base"), "HEAD"]);
  if (!base.ok) fail(`no merge base with ${arg("base")}: ${base.err}`);
  const range = `${base.out.trim()}..HEAD`;
  const patch = git(cwd, ["diff", "--binary", range]).out;
  if (!patch.trim()) { console.log("nothing to land: the branch has no change against its base"); return; }
  const check = git(tree, ["apply", "--check", "-"], patch);
  if (!check.ok) fail(`the change does not apply to ${tree} as it stands: ${check.err.split("\n")[0]}`);
  const applied = git(tree, ["apply", "-"], patch);
  if (!applied.ok) fail(`applying to ${tree} failed: ${applied.err.split("\n")[0]}`);
  const stat = git(cwd, ["diff", "--shortstat", range]).out.trim();
  console.log(`applied to the working tree at ${tree}: ${stat}`);
}

if (import.meta.main) {
  const commands: Record<string, () => void> = { prove, eval: evalBranch, ship };
  const run = commands[process.argv[2] ?? ""];
  if (!run) fail(`usage: bun scripts/line.ts ${Object.keys(commands).join("|")} [options]`);
  run();
}
