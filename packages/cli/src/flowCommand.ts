// `cast flow`: the pool of structured flows every change can run through
// (docs/architecture/flows.md). A flow is a .cast graph; a line takes a change
// to done, a segment does one part of the path. This file lists the pool,
// shows one flow, runs a change through one, and turns a Claude Code
// workflow script into a flow of the pool.
import type { Command } from "commander";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface FlowDeps {
  cliPost: (urlPath: string, body: Record<string, any>, opts?: { timeoutMs?: number; throwOnError?: boolean }) => Promise<any>;
  /** The session this `cast` runs inside (its codecast id or agent session id), or undefined at a plain shell. */
  callingSession: () => string | undefined;
  realCwd: () => string;
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const KIND_MARK: Record<string, string> = { agent: "◉", script: "▶", person: "◇", segment: "▣", call: "○" };

async function cast(args: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  const { resolveCastInvocation } = await import("./castInvocation.js");
  const { cmd, prefixArgs } = resolveCastInvocation();
  const r = spawnSync(cmd, [...prefixArgs, ...args], { cwd, encoding: "utf-8", env: process.env });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

export function registerFlowCommands(program: Command, deps: FlowDeps): void {
  const flow = program
    .command("flow")
    .description("The pool of structured flows a change runs through: whole lines and segments (check, review, eval, decide, ship)")
    .showHelpAfterError(true);

  flow
    .command("ls")
    .description("List the pool: each flow's kind, what it takes, and its stations in order")
    .option("--kind <kind>", "Only lines or only segments (line, segment)")
    .option("--json", "Print the pool as JSON")
    .action(async (opts: { kind?: string; json?: boolean }) => {
      const { poolFlows, flowLine } = await import("./workflow/flowPool.js");
      const pool = poolFlows(deps.realCwd()).filter((f) => !opts.kind || f.kind === opts.kind);
      if (opts.json) { console.log(JSON.stringify(pool, null, 2)); return; }
      const group = (kind: string, title: string) => {
        const rows = pool.filter((f) => f.kind === kind);
        if (!rows.length) return;
        console.log(bold(title));
        for (const f of rows) {
          console.log(`  ${flowLine(f)}${f.where === "repo" ? dim("  (this repo)") : ""}${f.errors.length ? `  ✗ ${f.errors[0]}` : ""}`);
          if (f.description) console.log(dim(`  ${"".padEnd(16)} ${f.description}`));
        }
        console.log("");
      };
      console.log(dim(`  ${"flow".padEnd(16)} ${"kind".padEnd(8)} ${"takes".padEnd(12)} stations`));
      group("line", "Lines: take a change all the way to done");
      group("segment", "Segments: one part of the path, run alone or inside a line");
      console.log(dim("Run this session's change through one:  cast flow run <flow>"));
      console.log(dim("See a flow's stations and routes:        cast flow show <flow>"));
    });

  flow
    .command("show <flow>")
    .description("A flow's stations, what each does, and where each sends the work")
    .option("--json", "Print the flow as JSON")
    .action(async (slug: string, opts: { json?: boolean }) => {
      const found = await findFlow(slug, deps.realCwd());
      if (opts.json) { console.log(JSON.stringify(found, null, 2)); return; }
      console.log(`${bold(found.label)}  ${dim(`${found.kind} · ${found.where}${found.file ? ` · ${path.relative(deps.realCwd(), found.file)}` : ""}`)}`);
      if (found.description) console.log(found.description);
      console.log(dim(`takes: ${found.takes.join(", ")}`));
      console.log("");
      for (const [i, s] of found.stations.entries()) {
        const what = s.kind === "segment" ? `segment ${s.flow}, ${s.steps} step${s.steps === 1 ? "" : "s"}` : s.kind;
        console.log(`${String(i + 1).padStart(2)}. ${KIND_MARK[s.kind] ?? "·"} ${bold(s.label)}  ${dim(what)}`);
        for (const n of s.next) console.log(dim(`       → ${n.to}${n.when ? `  when ${n.when}` : ""}`));
      }
      if (found.ends.length) console.log(dim(`\nends: ${found.ends.join(", ")}`));
      if (found.errors.length) console.log(`\n✗ ${found.errors.join("\n✗ ")}`);
    });

  flow
    .command("validate <file>")
    .description("Read a flow file (segments expanded) and name what is missing")
    .action(async (file: string) => {
      const { describeFlow } = await import("./workflow/flowPool.js");
      const abs = path.resolve(deps.realCwd(), file);
      const f = describeFlow(path.basename(abs).replace(/\.cast$/, ""), fs.readFileSync(abs, "utf-8"), "repo", abs);
      if (f.errors.length) { for (const e of f.errors) console.error(`✗ ${e}`); process.exit(1); }
      console.log(`✓ ${f.label} (${f.kind}): ${f.stations.map((s) => s.label).join(" → ")}`);
    });

  flow
    .command("run <flow>")
    .description("Run a change through a flow: this session's own edits by default, or a task, branch or pull request")
    .option("--task <id>", "The change is this task's (its branch, or the session's edits bound to it)")
    .option("--session [id]", "The change is a session's own uncommitted edits (default: this session)")
    .option("--branch <name>", "The change is this branch")
    .option("--pr <number>", "The change is this pull request's head branch")
    .option("--title <text>", "Title for the task the run binds to, when one is made")
    .option("--foreground", "Run here and wait, rather than handing the run to this machine's daemon")
    .option("--dry-run", "Say what would run on what, and start nothing")
    .option("--json", "Print {run_id, task, branch, worktree, files} as JSON")
    .action(async (slug: string, opts: { task?: string; session?: string | boolean; branch?: string; pr?: string; title?: string; foreground?: boolean; dryRun?: boolean; json?: boolean }) => {
      const cwd = deps.realCwd();
      const found = await findFlow(slug, cwd);
      if (found.errors.length) { console.error(`✗ ${found.slug} does not run: ${found.errors.join("; ")}`); process.exit(1); }
      const top = (spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf-8" }).stdout ?? "").trim();
      if (!top) { console.error("cast flow run works inside a git checkout"); process.exit(1); }

      // Which change: a branch or PR names its own; else a session's edits, unless only a task was named.
      const sessionRef = typeof opts.session === "string" ? opts.session : opts.session === true || (!opts.task && !opts.branch && !opts.pr) ? deps.callingSession() : undefined;
      if (!opts.task && !opts.branch && !opts.pr && !sessionRef) {
        console.error("Name the change: run this from inside a session (its own edits), or pass --task, --branch, --pr or --session <id>");
        process.exit(1);
      }
      let branch = opts.branch;
      let title = opts.title;
      if (opts.pr) {
        const pr = spawnSync("gh", ["pr", "view", String(opts.pr), "--json", "headRefName,title"], { cwd, encoding: "utf-8" });
        if (pr.status !== 0) { console.error(`Could not read pull request ${opts.pr}: ${pr.stderr.trim()}`); process.exit(1); }
        const info = JSON.parse(pr.stdout);
        branch = info.headRefName;
        title ??= info.title;
        spawnSync("git", ["-C", top, "fetch", "--quiet", "origin", `${branch}:${branch}`]);
      }

      // The task the run binds to: the one named, else a new one for this change.
      const { parseWorkflowSource } = await import("./workflow/parser.js");
      const { runSlug, lineRunDir } = await import("./workflow/runner.js");
      const graph = parseWorkflowSource(found.source, found.file ? path.dirname(found.file) : cwd);
      let task = opts.task;
      // A session's change is read first: a session with nothing here stops before anything is made.
      const { previewSessionChange } = await import("./workflow/flowChange.js");
      const preview = sessionRef && !branch ? await previewSessionChange(top, sessionRef).catch((err) => { console.error(err.message); process.exit(1); }) : null;
      const changeTitle = title ?? (branch ? `Run ${branch} through ${found.label}` : `Run ${preview?.session ?? "the session"}'s change through ${found.label}`);
      if (opts.dryRun) {
        console.log(`${bold(found.label)}: ${found.stations.filter((s) => s.main).map((s) => s.label).join(" → ")}`);
        console.log(`on ${branch ? `branch ${branch}` : preview ? `session ${preview.session}'s own edits` : `task ${task}`}, bound to ${task ?? `a new task "${changeTitle}"`}`);
        if (preview) {
          console.log(`${preview.paths.length} file${preview.paths.length === 1 ? "" : "s"}:`);
          for (const f of preview.paths) {
            const also = preview.shared.find((s) => s.path === f)?.also;
            console.log(`  ${f}${also ? dim(`  also edited by ${also.join(", ")}`) : ""}`);
          }
          for (const h of preview.held) console.log(`  held out: ${h.path} (${h.why})`);
        }
        console.log(dim("Nothing started (--dry-run)."));
        return;
      }
      if (!task) {
        const made = await cast(["task", "create", changeTitle, "-d", `A change run through the ${found.label} flow (${found.slug}).`, "--found-during", "none"], top);
        task = (made.out + made.err).match(/\bct-\d+\b/)?.[0];
        if (!task) { console.error(`Could not make the task for this change: ${(made.err || made.out).trim()}`); process.exit(1); }
      }

      // The change on its own branch and worktree, named as the run's isolated stations name theirs.
      const worktree = runSlug(graph, { task_id: task }, "run");
      const runDir = lineRunDir(top, worktree);
      const { writeFrozenChange } = await import("./workflow/flowChange.js");
      let change: import("./workflow/flowChange.js").FrozenChange | null = null;
      if (branch) {
        const head = spawnSync("git", ["-C", top, "rev-parse", branch], { encoding: "utf-8" }).stdout.trim();
        if (!head) { console.error(`No branch ${branch} here`); process.exit(1); }
        change = { source: opts.pr ? "pr" : "branch", base: head, tip: head, branch, worktree, paths: [], shared: [], held: [] };
      } else if (sessionRef) {
        const { freezeSessionChange } = await import("./workflow/flowChange.js");
        try {
          change = await freezeSessionChange(top, sessionRef, { branch: `codecast/${worktree}`, worktree, title: changeTitle });
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
      }
      if (change) {
        const ws = await cast(["ws", "acquire", worktree, "--branch", change.branch, "--skip-pool", "--json"], top);
        if (ws.code !== 0) { console.error(`Could not make the worktree for the change: ${(ws.err || ws.out).trim().split("\n").pop()}`); process.exit(1); }
        writeFrozenChange(runDir, change);
      }

      const runArgs = ["workflow", "run", found.file ?? found.slug, "--task", task!];
      if (!opts.foreground) runArgs.push("--detach", "--json");
      if (opts.foreground) {
        const { resolveCastInvocation } = await import("./castInvocation.js");
        const { cmd, prefixArgs } = resolveCastInvocation();
        const r = spawnSync(cmd, [...prefixArgs, ...runArgs], { cwd: top, stdio: "inherit", env: process.env });
        process.exit(r.status ?? 1);
      }
      const started = await cast(runArgs, top);
      const runId = started.out.match(/"run_id"\s*:\s*"([^"]+)"/)?.[1];
      if (started.code !== 0 || !runId) { console.error((started.err || started.out).trim()); process.exit(1); }
      const result = { run_id: runId, task, flow: found.slug, branch: change?.branch ?? null, worktree: change ? worktree : null, files: change?.paths ?? [], shared: change?.shared ?? [], held: change?.held ?? [] };
      if (opts.json) { console.log(JSON.stringify(result)); return; }
      console.log(`${bold(found.label)} started on ${task}: ${found.stations.map((s) => s.label).join(" → ")}`);
      if (change?.source === "session") {
        console.log(`  ${change.paths.length} file${change.paths.length === 1 ? "" : "s"} from session ${change.session} on ${change.branch}`);
        for (const s of change.shared) console.log(`  ${s.path} also holds edits from ${s.also.join(", ")}`);
        for (const h of change.held) console.log(`  held out: ${h.path} (${h.why})`);
      } else if (change) console.log(`  on ${change.branch}`);
      console.log(dim(`  run ${runId} · cast workflow runs --task ${task}`));
    });

  flow
    .command("import <script>")
    .description("Turn a Claude Code workflow script (a path, or a wf_ run id) into a flow under .codecast/flows/")
    .option("--as <kind>", "segment or line", "segment")
    .option("--slug <name>", "The flow's name in the pool (default: the script's meta name)")
    .option("--force", "Replace a flow of that name")
    .option("--args <json>", "The args the script reads (default: the args its run was launched with, when this machine ran it)")
    .action(async (script: string, opts: { as: string; slug?: string; force?: boolean; args?: string }) => {
      const { importWorkflowScript } = await import("./workflow/flowImport.js");
      const cwd = deps.realCwd();
      const file = resolveScript(script, cwd);
      const text = fs.readFileSync(file, "utf-8");
      const args = opts.args ? JSON.parse(opts.args) : launchArgs(file, text);
      const out = await importWorkflowScript(text, { kind: opts.as === "line" ? "line" : "segment", slug: opts.slug, cwd, force: !!opts.force, args });
      console.log(`✓ ${out.slug}: ${out.stations.join(" → ")}`);
      console.log(dim(`  ${path.relative(cwd, out.file)}`));
      for (const p of out.prompts) console.log(dim(`  ${path.relative(cwd, p)}`));
      for (const n of out.notes) console.log(`  ${n}`);
      console.log(`\nEach prompt above holds the words the workflow was written with. Rewrite the parts that named one task into $task_title, $task_description, $branch and $acceptance_criteria, then: cast flow validate ${path.relative(cwd, out.file)}`);
    });
}

type FoundFlow = import("./workflow/flowPool.js").PoolFlow & { source: string };

async function findFlow(slug: string, cwd: string): Promise<FoundFlow> {
  const { describeFlow, poolFlows } = await import("./workflow/flowPool.js");
  const abs = path.resolve(cwd, slug);
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
    const source = fs.readFileSync(abs, "utf-8");
    return { ...describeFlow(path.basename(abs).replace(/\.cast$/, ""), source, "repo", abs), source };
  }
  const f = poolFlows(cwd).find((p) => p.slug === slug.replace(/\.cast$/, ""));
  if (!f) {
    console.error(`No flow "${slug}" in the pool. cast flow ls lists them.`);
    process.exit(1);
  }
  const { BUILTIN_WORKFLOW_TEMPLATES } = await import("./workflow/templates.js");
  return { ...f, source: f.file ? fs.readFileSync(f.file, "utf-8") : BUILTIN_WORKFLOW_TEMPLATES[f.slug] };
}

/** A script path, or a dynamic workflow run id whose script the session kept (`<session>/workflows/scripts/<name>-<wf_id>.js`). */
function resolveScript(ref: string, cwd: string): string {
  const abs = path.resolve(cwd, ref);
  if (fs.existsSync(abs)) return abs;
  if (/^wf_[\w-]+$/.test(ref)) {
    const projects = path.join(process.env.HOME ?? "", ".claude", "projects");
    for (const proj of fs.existsSync(projects) ? fs.readdirSync(projects) : []) {
      const projDir = path.join(projects, proj);
      for (const sess of fs.readdirSync(projDir)) {
        const dir = path.join(projDir, sess, "workflows", "scripts");
        if (!fs.existsSync(dir)) continue;
        const hit = fs.readdirSync(dir).find((f) => f.endsWith(`-${ref}.js`));
        if (hit) return path.join(dir, hit);
      }
    }
  }
  console.error(`No workflow script at ${ref} (a path, or a wf_ run id this machine ran)`);
  process.exit(1);
}

/**
 * The args a kept script's run was launched with: the Workflow call in its
 * session's transcript (`<project>/<session>.jsonl`, beside `<session>/workflows/scripts/`)
 * whose script is this one. Undefined when the script was not kept by a session here.
 */
function launchArgs(file: string, text: string): unknown {
  const m = file.match(/^(.*)\/([^/]+)\/workflows\/scripts\/[^/]+$/);
  if (!m) return undefined;
  const transcript = path.join(m[1], `${m[2]}.jsonl`);
  if (!fs.existsSync(transcript)) return undefined;
  const base = path.basename(file);
  let found: unknown;
  for (const line of fs.readFileSync(transcript, "utf-8").split("\n")) {
    if (!line.includes('"Workflow"') || !line.includes('"tool_use"')) continue;
    try {
      for (const b of JSON.parse(line)?.message?.content ?? []) {
        if (b?.type !== "tool_use" || b.name !== "Workflow" || b.input?.args === undefined) continue;
        if (b.input.script === text || String(b.input.scriptPath ?? "").endsWith(base)) found = b.input.args;
      }
    } catch {}
  }
  return found;
}
