#!/usr/bin/env bun
// Replay a line's presenting station on a problem that already has a built
// fix, without posting anything, and show the decision it would have posted.
//
//   bun packages/cli/scripts/line-present-replay.ts <ct-N> --prompt <file> --out <dir>
//        [--model claude-opus-5-5] [--refresh] [--read-only] [--max-turns 80] [--account <profile>]
//        [--repo ~/src/union-mobile] [--graph outreach/line/agentwatch-trial.cast] [--station card_write]
//        [--no-claude-md] [--dry]
//   bun packages/cli/scripts/line-present-replay.ts --list [--json]
//   bun packages/cli/scripts/line-present-replay.ts --capture <dir>
//   bun packages/cli/scripts/line-present-replay.ts --serve <dir> [--port N]
//
// A run does five things, in order:
//  1. Reads the problem's newest checkpoint under
//     <repo>/.git/cast-line/<graph>-<ct-N>/runs/.
//  2. Builds the station's opening message with the runner's own function
//     (workflow/runner.ts stationBrief), the node's prompt swapped for the
//     --prompt file. The context is the checkpoint's, less everything the
//     run made at the station and after it, so the replay is a first visit.
//     `--refresh` replaces two stale facts with today's: the graph's shared
//     text (its `shared` node's script) and the card draft (`cast card build`
//     written into the out dir, never the run's proof dir). Without it the
//     prompt reads the problem as it was when the run passed, and most runs
//     passed before their problem was regrouped.
//  3. Runs that message as an agent through prompt-dry-run.ts, in the
//     problem's worktree, on a pinned model, with the recording guard
//     (line-present-replay-bin/cast): reads go to the live workspace, every
//     write is refused and kept whole under <out>/run/writes.
//  4. Folds the recorded `cast decide` calls into <out>/decision.json,
//     context.md and report.html|md, and the `cast state` pin into pin.md and
//     fields.json.
//  5. Draws <out>/preview.html: the decision as codecast lays it out, in one
//     standalone file.
//
// `--capture <dir>` redoes 4 and 5 over a finished run. `--dry` stops after 2
// and leaves prompt.md. `--list` prints every problem with a built fix whose
// worktree still exists. `--serve <dir>` serves a directory of previews.
//
// The agent runs with the tools a station has and is not sandboxed read-only
// by default, because a presenter counts traffic with a read-only database
// query, which --read-only would cut off. The worktree's `git status` is
// compared before and after, and a run that changed it says so.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { parseWorkflowFile } from "../src/workflow/parser.ts";
import { expandPromptVars } from "../src/workflow/runner.ts";
import { previewDecisionPage, usesDecisionKit } from "../src/decisionKit.ts";
import {
  captureDecision, capturePin, checkpointRefs, fixKind, nodesAfter, presenterPrompt, problemCheckpoints, promptVariables,
  readWrites, renderPreview, replayContext, stationJson, type Checkpoint,
} from "./lib/linePresent.ts";

const argv = process.argv.slice(2);
const has = (name: string) => argv.includes(`--${name}`);
function arg(name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
}
function fail(message: string): never { console.error(message); process.exit(2); }
const home = (p: string) => path.resolve(p.replace(/^~(?=\/|$)/, os.homedir()));

const SELF = path.relative(process.cwd(), import.meta.path) || import.meta.path;
const repo = home(arg("repo", "~/src/union-mobile")!);
const graphFile = path.resolve(repo, arg("graph", "outreach/line/agentwatch-trial.cast")!);
const graphName = path.basename(graphFile).replace(/\.[^.]+$/, "");
const station = arg("station", "card_write")!;
const model = arg("model", "claude-opus-5-5")!;
const TOOLS = "Bash,Read,Write,Edit,Grep,Glob";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout : "";
}
const worktreeOf = (cp: Checkpoint) => (cp.context.worktree ? path.join(repo, ".codecast", "worktrees", cp.context.worktree) : "");

/** The harness run dir for an out dir: <out>/run, or, when <out> sits under a
 *  temp root, a dir under ~/.cache that <out>/run links to. */
function harnessRunDir(out: string): string {
  const link = path.join(out, "run");
  const real = fs.realpathSync(out);
  if (!/^\/private\/(var\/)?tmp\//.test(real + "/")) {
    if (fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) fs.rmSync(link);
    return link;
  }
  const dir = path.join(os.homedir(), ".cache", "line-present-replay", real.replace(/^\/+/, "").replace(/[^\w.-]+/g, "_"));
  fs.mkdirSync(dir, { recursive: true });
  const at = fs.lstatSync(link, { throwIfNoEntry: false });
  if (at && !(at.isSymbolicLink() && fs.readlinkSync(link) === dir)) fs.rmSync(link, { recursive: true, force: true });
  if (!fs.lstatSync(link, { throwIfNoEntry: false })) fs.symlinkSync(dir, link);
  return dir;
}

// ─── --serve ──────────────────────────────────────────────

if (has("serve")) {
  const dir = home(arg("serve") ?? fail("--serve <dir>"));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(arg("port", "0")),
    fetch(req) {
      const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, "");
      const file = path.resolve(dir, rel);
      if (file !== dir && !file.startsWith(dir + path.sep)) return new Response("outside", { status: 403 });
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return new Response(Bun.file(file));
      const url = new URL(req.url);
      if (fs.existsSync(file) && fs.statSync(file).isDirectory() && !url.pathname.endsWith("/")) return Response.redirect(`${url.pathname}/`, 302);
      if (fs.existsSync(path.join(file, "preview.html"))) return new Response(Bun.file(path.join(file, "preview.html")));
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
        const rows = fs.readdirSync(file).filter((n) => !n.startsWith(".")).map((n) => {
          const href = `/${path.join(rel, n)}`;
          return `<li><a href="${href}">${n}</a></li>`;
        });
        return new Response(`<!doctype html><meta charset="utf-8"><body style="font:14px ui-monospace,monospace;padding:24px"><ul>${rows.join("")}</ul>`, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  console.log(`serving ${dir} at http://127.0.0.1:${server.port}/  (a run's directory opens on its preview.html)`);
  await new Promise(() => {});
}

// ─── --list ───────────────────────────────────────────────

if (has("list")) {
  const rows = [];
  for (const ref of checkpointRefs(repo, graphName)) {
    const cp = problemCheckpoints(repo, graphName, ref)[0];
    if (!cp) continue;
    const build = stationJson(cp.context, "build");
    const worktree = worktreeOf(cp);
    if (build.outcome !== "built" || !worktree || !fs.existsSync(worktree)) continue;
    const base = `origin/${cp.context.default_branch || "main"}`;
    const files = git(worktree, "diff", "--name-only", `${base}...HEAD`).split("\n").filter(Boolean);
    const stat = git(worktree, "diff", "--shortstat", `${base}...HEAD`).trim();
    const fix = fixKind(files);
    const card = stationJson(cp.context, "card").card ?? {};
    rows.push({
      ref, title: cp.context.task_title ?? "", strategy: stationJson(cp.context, "propose").strategy ?? "",
      kind: fix.kind, files: files.length, stat, changed: [...fix.prompt, ...fix.code], support: fix.support.length,
      // What the last presenter concluded, for picking cases; a replay does not read it.
      recommended: card.recommend?.verdict ?? null, reach: card.reach ? `${card.reach.conversations} of ${card.reach.of}` : null,
      sends_less: !!card.stops, at_node: cp.node_id, checkpoint: cp.file, worktree,
    });
  }
  if (has("json")) console.log(JSON.stringify(rows, null, 1));
  else {
    for (const r of rows) {
      console.log(`${r.ref}  ${r.kind}  ${r.files} files (${r.stat || "no diff"})  last card: ${r.recommended ?? "none"}${r.reach ? `, reaches ${r.reach} conversations` : ""}${r.sends_less ? ", sends less" : ""}`);
      console.log(`  ${r.title}`);
      console.log(`  strategy: ${r.strategy}`);
      for (const f of r.changed) console.log(`  ${f}`);
      if (r.support) console.log(`  + ${r.support} test, fixture and repro files`);
      console.log("");
    }
    console.log(`${rows.length} problems under ${graphName} have a built fix and a worktree.`);
  }
  process.exit(0);
}

// ─── capture and preview ──────────────────────────────────

function readJson(file: string): any { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function readText(file: string): string | undefined { try { return fs.readFileSync(file, "utf8").trim(); } catch { return undefined; } }

/** Steps 4 and 5 over a finished run directory: decision.json, context.md, the report, the pin and preview.html. */
function capture(out: string): { posted: boolean; missing: string[] } {
  const runDir = path.join(out, "run");
  const replay = readJson(path.join(out, "replay.json")) ?? {};
  const writes = readWrites(runDir);
  const decision = captureDecision(writes);
  const pin = capturePin(writes);
  const result = readJson(path.join(runDir, "out.json"));
  for (const f of ["decision.json", "context.md", "report.html", "report.source.html", "report.md", "pin.md", "fields.json", "preview.html"]) fs.rmSync(path.join(out, f), { force: true });
  const links: { label: string; href: string }[] = [];
  if (decision) {
    const reportFile = decision.report?.content != null ? `report.${decision.report.kind}` : null;
    fs.writeFileSync(path.join(out, "decision.json"), JSON.stringify({ ...decision, report: decision.report && { path: decision.report.path, kind: decision.report.kind, file: reportFile } }, null, 1) + "\n");
    fs.writeFileSync(path.join(out, "context.md"), decision.context + "\n");
    links.push({ label: "decision.json", href: "decision.json" }, { label: "context.md", href: "context.md" });
    if (reportFile) {
      // report.html is the page as codecast serves it (kit inline, colour tokens), so it reads the same opened alone;
      // the page as the presenter wrote it stays beside it.
      const written = decision.report!.content!;
      const served = reportFile === "report.html" && usesDecisionKit(written);
      fs.writeFileSync(path.join(out, reportFile), served ? previewDecisionPage(written) : written);
      links.push({ label: reportFile, href: reportFile });
      if (served) { fs.writeFileSync(path.join(out, "report.source.html"), written); links.push({ label: "report.source.html", href: "report.source.html" }); }
    }
  }
  if (pin) {
    fs.writeFileSync(path.join(out, "pin.md"), pin.text + "\n");
    links.push({ label: "pin.md", href: "pin.md" });
    if (pin.fields) fs.writeFileSync(path.join(out, "fields.json"), JSON.stringify(pin.fields, null, 1) + "\n");
  }
  if (fs.existsSync(path.join(out, "prompt.md"))) links.push({ label: "prompt.md", href: "prompt.md" });
  const said: string[] = readJson(path.join(runDir, "said.json")) ?? [];
  fs.writeFileSync(path.join(out, "preview.html"), renderPreview(decision, {
    ref: replay.ref ?? path.basename(out), title: replay.title, prompt: replay.prompt ?? "prompt.md", model: replay.model ?? model,
    took: readText(path.join(runDir, "took.txt")), cost: result?.total_cost_usd ?? null, turns: result?.num_turns ?? null,
    said: said[said.length - 1], links,
  }));
  const refused = (readText(path.join(runDir, "calls.log")) ?? "").split("\n").filter((l) => l.startsWith("REFUSED "));
  fs.writeFileSync(path.join(out, "writes.txt"), refused.map((l) => l.slice(8).slice(0, 400)).join("\n") + "\n");
  return { posted: !!decision, missing: decision?.missing ?? [] };
}

if (has("capture")) {
  const out = home(arg("capture") ?? fail("--capture <dir>"));
  const got = capture(out);
  console.log(got.posted ? `captured: ${path.join(out, "preview.html")}` : `no decision in ${out}; preview.html says so`);
  for (const m of got.missing) console.log(`missing: ${m}`);
  process.exit(0);
}

// ─── a replay ─────────────────────────────────────────────

const ref = argv.find((a) => /^ct-\d+$/.test(a)) ?? fail(`usage: ${SELF} <ct-N> --prompt <file> --out <dir> [--model id] [--refresh] | --list | --capture <dir> | --serve <dir>`);
const promptFile = home(arg("prompt") ?? fail("--prompt <file>: the presenter prompt to replay"));
const out = home(arg("out") ?? fail("--out <dir>: where the run and its capture go"));
if (!fs.existsSync(promptFile)) fail(`no such prompt file: ${promptFile}`);
if (!fs.existsSync(graphFile)) fail(`no such graph: ${graphFile}`);

const cp = problemCheckpoints(repo, graphName, ref)[0] ?? fail(`${ref} has no checkpoint under ${path.join(repo, ".git", "cast-line", `${graphName}-${ref}`, "runs")}`);
const worktree = worktreeOf(cp);
if (!worktree || !fs.existsSync(worktree)) fail(`${ref}: the checkpoint's worktree (${cp.context.worktree || "none"}) is gone; --list names the problems that can be replayed`);
if (stationJson(cp.context, "build").outcome !== "built") console.error(`note: ${ref}'s newest checkpoint has no built fix; the presenter will read empty facts`);

fs.mkdirSync(out, { recursive: true });
const fresh: Record<string, string> = {};
if (has("refresh")) {
  // Today's shared text: the graph's own `shared` node, run where the runner runs it.
  const sharedScript = parseWorkflowFile(graphFile).nodes.get("shared")?.script;
  if (sharedScript) {
    const r = spawnSync("bash", ["-c", sharedScript], { cwd: cp.context.project_path || path.dirname(path.dirname(graphFile)), encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) fresh["shared.json"] = r.stdout.trim();
    else console.error(`note: the shared text did not refresh (exit ${r.status}); the checkpoint's stays`);
  }
  // Today's card draft: the problem and its findings as they stand now. The
  // graph's own script writes card.json into the run's proof dir, which holds
  // the finished card; this one writes into the out dir.
  const proofDir = stationJson(cp.context, "red").dir;
  if (proofDir) {
    const draftDir = path.join(out, "draft");
    fs.mkdirSync(draftDir, { recursive: true });
    const r = spawnSync("cast", ["card", "build", "--task", ref, "--dir", proofDir, "--base", `origin/${cp.context.default_branch || "main"}`, "--json", "--out", path.join(draftDir, "card.json")], { cwd: worktree, encoding: "utf8", timeout: 300_000 });
    try { fresh["card_draft.json"] = JSON.stringify(JSON.parse(r.stdout)); fresh["card_draft.output"] = r.stdout.trim().slice(0, 4000); }
    catch { console.error(`note: the card draft did not refresh (exit ${r.status}: ${(r.stderr || "").trim().slice(0, 200)}); the checkpoint's stays`); }
  }
}

const promptText = fs.readFileSync(promptFile, "utf8");
// A run started today names its goal from the problem's title as it stands; the checkpoint's goal is the title the run started under.
if (has("refresh") && cp.context.task_title) fresh.goal = cp.context.task_title;
// The station's own files go under $run_dir. The real one keeps what an earlier
// replay wrote there, which a first visit would not find, so each replay gets
// an empty one. It sits inside the harness's run dir, the one place its sandbox
// lets the agent write. The sandbox also refuses every directory above a run
// dir under a temp root, so `mkdir -p` of any path inside it fails there (a
// round-15 page landed in a repo's .git for that reason): such a run dir lives
// under ~/.cache instead, linked from <out>/run.
const runDir = harnessRunDir(out);
fresh.run_dir = path.join(runDir, "station");
fs.rmSync(fresh.run_dir, { recursive: true, force: true });
fs.mkdirSync(fresh.run_dir, { recursive: true });
const context = replayContext(cp.context, station, nodesAfter(graphFile, station), fresh);
const brief = presenterPrompt(graphFile, station, promptText, context);
fs.writeFileSync(path.join(out, "prompt.md"), brief);
const graph = parseWorkflowFile(graphFile);
graph.goal = context.goal ?? graph.goal;
const variables = promptVariables(promptText, context, (name) => expandPromptVars(`$${name}`, graph, context));
const empty = variables.filter((v) => !v.filled).map((v) => `$${v.name}`);
fs.writeFileSync(path.join(out, "replay.json"), JSON.stringify({
  ref, title: cp.context.task_title ?? "", prompt: promptFile, model, station, graph: graphFile, checkpoint: cp.file, run_id: cp.run_id,
  worktree, refreshed: Object.keys(fresh), variables, at: new Date().toISOString(),
}, null, 1) + "\n");
console.log(`${ref}: ${cp.context.task_title ?? ""}`);
console.log(`checkpoint ${cp.file}`);
console.log(`prompt ${path.join(out, "prompt.md")} (${brief.length} chars, ${variables.length} variables${empty.length ? `, empty: ${empty.join(" ")}` : ""})`);
if (has("dry")) process.exit(0);

fs.rmSync(path.join(runDir, "writes"), { recursive: true, force: true });
fs.rmSync(path.join(runDir, "calls.log"), { force: true });
const claudeMd = path.join(os.homedir(), ".claude", "CLAUDE.md");
const before = git(worktree, "status", "--porcelain");
const started = Date.now();
const run = spawnSync("bun", [
  path.join(import.meta.dir, "prompt-dry-run.ts"),
  "--run", runDir, "--prompt", path.join(out, "prompt.md"), "--model", model, "--cwd", worktree,
  "--tools", TOOLS, "--guard", path.join(import.meta.dir, "line-present-replay-bin"), "--max-turns", arg("max-turns", "80")!,
  // A station's hand carries its person's global instructions, where it learns `cast decide`; the replay carries the same.
  ...(!has("no-claude-md") && fs.existsSync(claudeMd) ? ["--claude-md", claudeMd] : []),
  ...(has("read-only") ? ["--read-only"] : []),
  ...(arg("account") ? ["--account", arg("account")!] : []),
  // The broker runs live reads from the run dir; the workspace they resolve in is the worktree's.
], { stdio: "inherit", env: { ...process.env, CODECAST_CWD: worktree } });
const after = git(worktree, "status", "--porcelain");
if (after !== before) console.error(`WARNING: the run changed ${worktree}:\n${after}`);

const got = capture(out);
const result = readJson(path.join(runDir, "out.json"));
console.log(`${ref}: ${Math.round((Date.now() - started) / 1000)}s, exit ${run.status}${result ? `, $${Number(result.total_cost_usd).toFixed(2)}, ${result.num_turns} turns` : ""}`);
console.log(got.posted ? `decision: ${path.join(out, "decision.json")}` : "the station posted no decision");
for (const m of got.missing) console.log(`missing: ${m}`);
console.log(`preview:  ${path.join(out, "preview.html")}`);
console.log(`serve:    bun ${SELF} --serve ${path.dirname(out)}   (then open /${path.basename(out)}/)`);
process.exit(got.posted ? 0 : 1);
