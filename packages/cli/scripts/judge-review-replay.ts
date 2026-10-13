#!/usr/bin/env bun
// Replay the judge route's presenting station (agentwatch-trial-judge.cast,
// node review_words) on a problem whose judge fix is measured, without
// posting anything, and show the decision it would have posted.
//
//   bun packages/cli/scripts/judge-review-replay.ts <ct-N> --prompt <file> --out <dir>
//        [--model claude-opus-5-5] [--max-turns 80] [--account <profile>] [--dry]
//
// The same steps as line-present-replay.ts, which needs a fix's worktree and
// so cannot run this route: the station's opening message is built with the
// runner's own function from the problem's newest checkpoint (less what the
// run made at the station and after it), run through prompt-dry-run.ts from
// the repository's outreach dir with the recording guard
// (line-present-replay-bin/cast), and the recorded decision and pin are drawn
// by `line-present-replay.ts --capture`. `--dry` stops after prompt.md.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { parseWorkflowFile } from "../src/workflow/parser.ts";
import { expandPromptVars } from "../src/workflow/runner.ts";
import { nodesAfter, presenterPrompt, problemCheckpoints, promptVariables, replayContext } from "./lib/linePresent.ts";

const argv = process.argv.slice(2);
const has = (name: string) => argv.includes(`--${name}`);
const arg = (name: string, fallback?: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback; };
const fail = (m: string): never => { console.error(m); process.exit(2); };
const home = (p: string) => path.resolve(p.replace(/^~(?=\/|$)/, os.homedir()));

const repo = home("~/src/union-mobile");
const graphFile = path.join(repo, "outreach/line/agentwatch-trial-judge.cast");
const graphName = "agentwatch-trial-judge";
const station = "review_words";
const model = arg("model", "claude-opus-5-5")!;
const ref = argv.find((a) => /^ct-\d+$/.test(a)) ?? fail("usage: judge-review-replay.ts <ct-N> --prompt <file> --out <dir> [--model id] [--dry]");
const promptFile = home(arg("prompt") ?? fail("--prompt <file>"));
const out = home(arg("out") ?? fail("--out <dir>"));
// The sandbox refuses every parent of a run dir under a temp root, so outs live under ~/.cache.
fs.mkdirSync(out, { recursive: true });
if (/^\/(private\/)?(var\/)?tmp\//.test(fs.realpathSync(out) + "/")) fail("--out must not sit under /tmp (the dry run's sandbox refuses its parents); use ~/.cache/...");

const cp = problemCheckpoints(repo, graphName, ref)[0] ?? fail(`${ref} has no ${graphName} checkpoint`);
const runDir = path.join(out, "run");
const stationDir = path.join(runDir, "station");
fs.rmSync(stationDir, { recursive: true, force: true });
fs.mkdirSync(stationDir, { recursive: true });
const promptText = fs.readFileSync(promptFile, "utf8");
const context = replayContext(cp.context, station, nodesAfter(graphFile, station), { run_dir: stationDir });
const brief = presenterPrompt(graphFile, station, promptText, context);
fs.writeFileSync(path.join(out, "prompt.md"), brief);
const graph = parseWorkflowFile(graphFile);
const variables = promptVariables(promptText, context, (name) => expandPromptVars(`$${name}`, graph, context));
const empty = variables.filter((v) => !v.filled).map((v) => `$${v.name}`);
fs.writeFileSync(path.join(out, "replay.json"), JSON.stringify({ ref, title: cp.context.task_title ?? "", prompt: promptFile, model, station, graph: graphFile, checkpoint: cp.file, run_id: cp.run_id, variables, at: new Date().toISOString() }, null, 1) + "\n");
console.log(`${ref}: ${cp.context.task_title ?? ""}\nprompt ${path.join(out, "prompt.md")} (${brief.length} chars${empty.length ? `, empty: ${empty.join(" ")}` : ""})`);
if (has("dry")) process.exit(0);

for (const f of ["writes", "calls.log"]) fs.rmSync(path.join(runDir, f), { recursive: true, force: true });
const claudeMd = path.join(os.homedir(), ".claude", "CLAUDE.md");
const started = Date.now();
const run = spawnSync("bun", [
  path.join(import.meta.dir, "prompt-dry-run.ts"),
  "--run", runDir, "--prompt", path.join(out, "prompt.md"), "--model", model, "--cwd", path.join(repo, "outreach"),
  "--tools", "Bash,Read,Write,Edit,Grep,Glob", "--guard", path.join(import.meta.dir, "line-present-replay-bin"), "--max-turns", arg("max-turns", "80")!,
  ...(fs.existsSync(claudeMd) ? ["--claude-md", claudeMd] : []),
  ...(arg("account") ? ["--account", arg("account")!] : []),
], { stdio: "inherit", env: { ...process.env, CODECAST_CWD: repo } });
spawnSync("bun", [path.join(import.meta.dir, "line-present-replay.ts"), "--capture", out], { stdio: "inherit" });
console.log(`${ref}: ${Math.round((Date.now() - started) / 1000)}s, exit ${run.status}; preview ${path.join(out, "preview.html")}`);
