#!/usr/bin/env bun
// Grades the session goal judge (shared/contracts/sessionGoal.ts buildGoalJudgePrompt)
// over the fixtures in goal-judge-fixtures.ts: each fixture's prompt is sent
// --samples times through prompt-dry-run.ts --call (the isolated harness, never
// a bare `claude -p`), and the verdicts are tallied against what a careful
// reviewer answers.
//
//   bun packages/cli/scripts/goal-judge-eval.ts --model claude-haiku-5-5 [--samples 8] [--jobs 6] [--only <name substring>] [--out <dir>]
//
// Prints one row per fixture (expected, the verdict counts, accuracy) and the
// overall accuracy; writes every reply under --out (default $TMPDIR/goal-judge-eval/<model>).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { buildGoalJudgePrompt, parseGoalVerdict, renderGoalEvidence } from "@codecast/shared/contracts/sessionGoal";
import { parseJsonBlock } from "@codecast/shared/contracts/modelCall";
import { GOAL_JUDGE_FIXTURES } from "./goal-judge-fixtures";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const model = arg("model");
if (!model) {
  console.error("--model is required");
  process.exit(2);
}
const samples = Number(arg("samples", "8"));
const jobs = Number(arg("jobs", "6"));
const only = arg("only");
const outRoot = arg("out", path.join(os.tmpdir(), "goal-judge-eval", model))!;
const harness = path.join(import.meta.dir, "prompt-dry-run.ts");

const fixtures = GOAL_JUDGE_FIXTURES.filter((f) => !only || f.name.includes(only));
type Job = { fixture: string; sample: number; dir: string };
const queue: Job[] = [];
for (const f of fixtures) {
  const base = path.join(outRoot, f.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase());
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "prompt.txt"), buildGoalJudgePrompt(f.objective, renderGoalEvidence(f.messages)));
  for (let s = 0; s < samples; s++) queue.push({ fixture: f.name, sample: s, dir: path.join(base, `s${s}`) });
}

function runOne(j: Job): Promise<string> {
  fs.rmSync(j.dir, { recursive: true, force: true });
  fs.mkdirSync(j.dir, { recursive: true });
  const prompt = path.join(path.dirname(j.dir), "prompt.txt");
  return new Promise((resolve) => {
    const child = spawn("bun", [harness, "--run", j.dir, "--prompt", prompt, "--model", model!, "--call", "--max-output-tokens", "1000"], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      try {
        const out = JSON.parse(fs.readFileSync(path.join(j.dir, "out.json"), "utf8"));
        resolve(String(out.result ?? ""));
      } catch {
        resolve(`(run failed, exit ${code}) ${err.slice(-300)}`);
      }
    });
  });
}

const replies = new Map<string, string[]>();
let next = 0;
let done = 0;
await Promise.all(
  Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    while (next < queue.length) {
      const j = queue[next++];
      const text = await runOne(j);
      replies.set(j.fixture, [...(replies.get(j.fixture) ?? []), text]);
      process.stderr.write(`\r${++done}/${queue.length}`);
    }
  }),
);
process.stderr.write("\n");

let right = 0;
let total = 0;
const report: string[] = [`model ${model}, ${samples} samples per fixture`, ""];
for (const f of fixtures) {
  const got = (replies.get(f.name) ?? []).map((t) => parseGoalVerdict(parseJsonBlock(t))?.verdict ?? "unparsed");
  const counts: Record<string, number> = {};
  for (const g of got) counts[g] = (counts[g] ?? 0) + 1;
  const ok = counts[f.expect] ?? 0;
  right += ok;
  total += got.length;
  report.push(`${f.name.padEnd(34)} expect ${f.expect.padEnd(8)} ${ok}/${got.length}  ${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(" ")}`);
}
report.push("", `overall ${right}/${total} (${((100 * right) / Math.max(1, total)).toFixed(0)}%)`);
fs.writeFileSync(path.join(outRoot, "report.txt"), report.join("\n") + "\n");
fs.writeFileSync(path.join(outRoot, "replies.json"), JSON.stringify(Object.fromEntries(replies), null, 2));
console.log(report.join("\n"));
