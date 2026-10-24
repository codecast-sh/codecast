// `cast flow` (docs/architecture/flows.md): the team's library of structured
// flows and its live flows. A flow is a .cast graph; a whole flow takes a
// change to done, a variant extends a flow and changes only what differs, a
// segment does one part of the path. A live flow is a flow switched on, with
// sources feeding one queue. This file lists the library and the live flows,
// shows one, runs a change through one, switches a live flow, and turns a
// Claude Code workflow script into a flow (lineCommand.ts adds the flows'
// working commands).
import type { Command } from "commander";
import { commandGroup } from "./commandGroups.js";
import { spawnSync } from "./proc.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { holdUntil, libraryTree, liveFlowLines, namesLiveFlow, variantChangeLines, variantChanges, variantSummary, type LibraryNode, type LiveFlow, type VariantChanges } from "./flowLibrary.js";
import type { WorkflowGraph } from "./workflow/types.js";
import { graphExtends, parseWorkflowSource } from "./workflow/parser.js";
import { describeFlow, flowLine, poolFlows, type PoolFlow, type PushedPoolRow } from "./workflow/flowPool.js";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./workflow/templates.js";
import type { Workspace } from "./resolveWorkspace.js";

export interface FlowDeps {
  cliPost: (urlPath: string, body: Record<string, any>, opts?: { timeoutMs?: number; throwOnError?: boolean }) => Promise<any>;
  /** The session this `cast` runs inside (its codecast id or agent session id), or undefined at a plain shell. */
  callingSession: () => string | undefined;
  realCwd: () => string;
  /** The workspace a read names: the team given, else the one this shell reads. */
  readWorkspace: (team?: string) => Promise<Workspace>;
  /** The workspace a write names outright (a team, or it stops with why). */
  writeWorkspace: (team?: string) => Promise<Workspace>;
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const KIND_MARK: Record<string, string> = { agent: "◉", script: "▶", person: "◇", segment: "▣", call: "○", parallel: "⫴" };

async function cast(args: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  const { resolveCastInvocation } = await import("./castInvocation.js");
  const { cmd, prefixArgs } = resolveCastInvocation();
  const r = spawnSync(cmd, [...prefixArgs, ...args], { cwd, encoding: "utf-8", env: process.env });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** When each way of putting work in a flow fits: what `cast flow --help` says after the verbs. */
const FLOW_HELP = `
Choosing a flow:
  A library flow that fits the work runs as it stands: it carries what the team has learned.
  A library flow that fits as a backbone, with a step this change needs done its own way, is
  extended: name it with extends and fill its slots with steps you write. The rest stays the team's.
  A flow written whole fits only when nothing in the library has the shape of the work.

  cast flow run change                      a library flow, on this session's own edits
  cast flow run - <<'EOF'                   a flow written here, checked before it starts
  digraph flaky_fix {
    graph [extends="change"]
    subgraph check { reproduce -> prove }   steps that fill the backbone's check slot
  }
  EOF

  cast flow show <flow> lists a flow's slots. A flow written here is kept in .codecast/session-flows/
  as this session's draft; its run draws in the conversation, where it can be saved to the library.
`;

export function registerFlowCommands(program: Command, deps: FlowDeps): Command {

  const flow = program
    .command("flow")
    .description(commandGroup("flow").description)
    .showHelpAfterError(true)
    .addHelpText("after", FLOW_HELP);

  flow
    .command("ls")
    .description("The library as a tree (the spine, whole flows with their variants, segments) and the team's live flows")
    .option("--kind <kind>", "Only whole flows or only segments (line, segment)")
    .option("--team <name>", "Read this team's library (default: the workspace this directory reads)")
    .option("--json", "Print { library, live } as JSON")
    .action(async (opts: { kind?: string; json?: boolean; team?: string }) => {
      const tdeps = teamDeps(deps, opts.team);
      const [pool, live] = await Promise.all([readPool(tdeps), readLive(deps, opts.team)]);
      const library = pool.filter((f) => !opts.kind || f.kind === opts.kind);
      const tree = libraryTree(library, live.flows);
      if (opts.json) {
        const spines = new Set(tree.spine.map((n) => n.flow.slug));
        console.log(JSON.stringify({ library: library.map((f) => ({ ...f, spine: spines.has(f.slug) })), live: live.flows }, null, 2));
        return;
      }
      const home = (f: typeof pool[number]) => (f.draft ? dim("  (your draft)") : f.where === "repo" ? dim("  (this repo)") : f.where === "team" ? dim(`  (the team's${f.by ? `, from ${f.by}` : ""})`) : f.where === "pushed" ? dim("  (yours)") : "");
      const print = (n: LibraryNode, depth: number) => {
        const f = n.flow;
        const lead = depth ? `${"  ".repeat(depth)}└ ` : "  ";
        console.log(`${lead}${flowLine(f)}${home(f)}${f.errors.length ? `  ✗ ${f.errors[0]}` : ""}`);
        const pad = `${" ".repeat(lead.length)}${"".padEnd(16)} `;
        if (depth) {
          const base = graphOf(pool.find((p) => p.slug === f.extends));
          const own = graphOf(f);
          if (base && own) console.log(dim(`${pad}extends ${f.extends}: ${variantSummary(variantChanges(base, own))}`));
        } else if (f.description) console.log(dim(`${pad}${f.description}`));
        for (const v of n.variants) print(v, depth + 1);
      };
      const group = (nodes: LibraryNode[], title: string) => {
        if (!nodes.length) return;
        console.log(bold(title));
        for (const n of nodes) print(n, 0);
        console.log("");
      };
      console.log(dim(`  ${"flow".padEnd(16)} ${"kind".padEnd(8)} ${"takes".padEnd(12)} stations`));
      group(tree.spine, "Spine: the flow the team's live flow runs");
      group(tree.flows, "Whole flows: take a change all the way to done");
      group(tree.segments, "Segments: one part of the path, run alone or inside a flow");
      if (live.flows.length) {
        console.log(bold("Live flows"));
        for (const l of live.flows) for (const line of liveFlowLines(l, { top: 3, bold, dim })) console.log(`  ${line}`);
        console.log("");
      } else if (live.error) console.log(dim(`Live flows: ${live.error}\n`));
      console.log(dim("Run this session's change through one:  cast flow run <flow>"));
      console.log(dim("See a flow's stations and routes:        cast flow show <flow>"));
    });

  flow
    .command("show <flow>")
    .description("A flow's stations, what each does, and where each sends the work; for a variant, what it changes from the flow it extends; for a live flow, its switch, sources and queue first")
    .option("--team <name>", "Read this team's library (default: the workspace this directory reads)")
    .option("--json", "Print the flow as JSON (with its live flow, and a variant's changes)")
    .action(async (slug: string, opts: { json?: boolean; team?: string }) => {
      const tdeps = teamDeps(deps, opts.team);
      // A live flow is named by its flow (slug, label or id) or its own id; the flow it runs prints after it.
      const [lives, pool] = await Promise.all([readLive(deps, opts.team), readPool(tdeps)]);
      const live = lives.flows.find((l) => namesLiveFlow(l, slug)) ?? null;
      const name = live ? live.flow.slug : slug;
      if (live && !pool.some((p) => p.slug === name)) {
        if (opts.json) { console.log(JSON.stringify({ live }, null, 2)); return; }
        for (const line of liveFlowLines(live, { top: 10, bold, dim })) console.log(line);
        console.log(dim(`\nIts flow ${name} is not in this team's library, so its stations cannot be read here.`));
        return;
      }
      const found = await findFlow(name, tdeps, pool);
      const spineLive = live ?? lives.flows.find((l) => l.flow.slug === found.slug) ?? null;
      const base = found.extends ? pool.find((p) => p.slug === found.extends) ?? baseBeside(found) : null;
      const baseGraph = graphOf(base);
      const ownGraph = baseGraph ? graphOf(found) : null;
      const changes = baseGraph && ownGraph ? variantChanges(baseGraph, ownGraph) : null;
      if (opts.json) { console.log(JSON.stringify({ ...found, ...(spineLive ? { live: spineLive } : {}), ...(changes ? { changes } : {}) }, null, 2)); return; }
      if (spineLive) {
        for (const line of liveFlowLines(spineLive, { top: 10, bold, dim })) console.log(line);
        console.log("");
      }
      const home = found.where === "team" ? `the team's${found.by ? `, from ${found.by}` : ""}` : found.where === "pushed" ? "yours, published" : found.file ? `${found.where} · ${path.relative(deps.realCwd(), found.file)}` : found.where;
      console.log(`${bold(found.label)}  ${dim(`${found.kind === "line" ? "flow" : found.kind} · ${home}`)}`);
      if (found.description) console.log(found.description);
      console.log(dim(`takes: ${found.takes.join(", ")}`));
      if (found.extends) printVariantChanges(found.extends, base, changes);
      console.log("");
      // A fan-out's branches print under it, and the routes after its join are its own.
      const byId = new Map(found.stations.map((x) => [x.id, x]));
      const branches = new Set(found.stations.filter((x) => x.kind === "parallel").flatMap((x) => x.next.map((n) => n.toId)));
      const joinAfter = (p: typeof found.stations[number]) => p.next.flatMap((n) => byId.get(n.toId)?.next ?? []).map((n) => byId.get(n.toId)).find((x) => x?.kind === "join");
      let i = 0;
      for (const s of found.stations) {
        if (s.kind === "join" || branches.has(s.id)) continue;
        i++;
        const what = s.slot?.filled === "empty" ? "slot, empty" : s.kind === "segment" ? `${s.slot ? "slot" : "segment"} ${s.flow ?? "written here"}, ${s.steps} step${s.steps === 1 ? "" : "s"}` : s.kind === "parallel" ? `${s.next.length} side by side, then join` : s.kind;
        console.log(`${String(i).padStart(2)}. ${KIND_MARK[s.kind] ?? "·"} ${bold(s.label)}  ${dim(what)}`);
        if (s.kind === "parallel") {
          for (const n of s.next) console.log(`       ${KIND_MARK[byId.get(n.toId)?.kind ?? "agent"] ?? "·"} ${n.to}`);
          for (const n of joinAfter(s)?.next ?? []) console.log(dim(`       → ${n.to}${n.when ? `  when ${n.when}` : ""}`));
          continue;
        }
        for (const n of s.next) console.log(dim(`       → ${n.to}${n.when ? `  when ${n.when}` : ""}`));
      }
      printSlots(found);
      if (found.ends.length) console.log(dim(`\nends: ${found.ends.join(", ")}`));
      if (found.errors.length) console.log(`\n✗ ${found.errors.join("\n✗ ")}`);
      else if (slug === "-") await keepSessionFlow(found, deps);
    });

  flow
    .command("validate <flow>")
    .description("Read a flow (a file, a library name, or - for a graph on stdin), segments and slots expanded, and name what is missing")
    .action(async (ref: string) => {
      const f = await findFlow(ref, deps);
      if (f.errors.length) { for (const e of f.errors) console.error(`✗ ${e}`); process.exit(1); }
      const { flowPathWords } = await import("@codecast/shared/contracts/flowPool");
      console.log(`✓ ${f.label} (${f.kind}${f.draft ? `, draft of ${f.draft}` : ""}): ${flowPathWords(f).path}`);
      printSlots(f);
      if (ref === "-") await keepSessionFlow(f, deps);
    });

  flow
    .command("publish <flow>")
    .description("Publish a repo flow to the team's pool, where every member sees and runs it (cast flow ls, the Flows page)")
    .option("--team <name>", "The team whose pool it joins (default: your active team; personal keeps it yours)")
    .action(async (slug: string, opts: { team?: string }) => {
      const found = await findFlow(slug, deps);
      if (!found.file) { console.error(`${found.slug} ships with codecast; it is in every pool already`); process.exit(1); }
      if (found.where === "team" || found.where === "pushed") {
        console.error(`${found.slug} is already published${found.by ? ` by ${found.by}` : ""}. Publish from the repo file it came from (.codecast/flows/${found.slug}.cast).`);
        process.exit(1);
      }
      if (found.draft) {
        console.error(`${found.slug} is still a draft of the run it came from. Before the team sees it, make it general: name each station and the flow for what it does in any change, write a description that names no one task, rewrite its prompts the same way (the task's words become $task_title, $task_description, $acceptance_criteria, $branch), then delete draft= from its graph line and publish again.`);
        process.exit(1);
      }
      if (found.errors.length) { for (const e of found.errors) console.error(`✗ ${e}`); process.exit(1); }
      const r = await cast(["workflow", "push", found.file, "--publish", ...(opts.team ? ["--team", opts.team] : [])], deps.realCwd());
      if (r.code !== 0) { console.error((r.err || r.out).trim()); process.exit(1); }
      const { flowPathWords } = await import("@codecast/shared/contracts/flowPool");
      console.log(`✓ ${found.label} published: ${flowPathWords(found).path}`);
    });

  flow
    .command("run <flow>")
    .description("Run a change through a flow (a library name, a file, or - for a graph on stdin): this session's own edits by default, or a task, branch or pull request")
    .option("--task <id>", "The change is this task's (its branch, or the session's edits bound to it)")
    .option("--session [id]", "The change is a session's own uncommitted edits (default: this session)")
    .option("--branch <name>", "The change is this branch")
    .option("--pr <number>", "The change is this pull request's head branch")
    .option("--title <text>", "Title for the task the run binds to, when one is made")
    .option("--only <paths>", "With a session's edits: only these files belong to the change (comma-separated paths or globs)")
    .option("--foreground", "Run here and wait, rather than handing the run to this machine's daemon")
    .option("--dry-run", "Say what would run on what, and start nothing")
    .option("--team <name>", "Read this team's pool (default: the workspace this directory reads)")
    .option("--json", "Print {run_id, task, branch, worktree, files} as JSON")
    .action(async (slug: string, opts: { task?: string; session?: string | boolean; branch?: string; pr?: string; title?: string; only?: string; foreground?: boolean; dryRun?: boolean; json?: boolean; team?: string }) => {
      const only = opts.only ? opts.only.split(",").map((s) => s.trim()).filter(Boolean) : null;
      const cwd = deps.realCwd();
      const found = await findFlow(slug, teamDeps(deps, opts.team));
      if (found.errors.length) { console.error(`✗ ${found.slug} does not run: ${found.errors.join("; ")}`); process.exit(1); }
      const empty = found.stations.filter((s) => s.slot?.filled === "empty");
      if (empty.length) {
        console.error(`✗ ${found.slug} is a backbone: ${empty.map((s) => s.id).join(", ")} ${empty.length === 1 ? "is a slot" : "are slots"} left to fill. Run a flow that extends it and fills ${empty.length === 1 ? "it" : "them"}:`);
        console.error(`  cast flow run - <<'EOF'\n  digraph <name> {\n    graph [extends="${found.slug}"]\n${empty.map((s) => `    subgraph ${s.id} { ... }   // ${s.slot!.does}`).join("\n")}\n  }\n  EOF`);
        process.exit(1);
      }
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
      const { runSlug, lineRunDir } = await import("./workflow/runner.js");
      const graph = parseWorkflowSource(found.source, found.file ? path.dirname(found.file) : cwd);
      let task = opts.task;
      // A session's change is read first: a session with nothing here stops before anything is made.
      const { previewSessionChange } = await import("./workflow/flowChange.js");
      const preview = sessionRef && !branch ? await previewSessionChange(top, sessionRef, only).catch((err) => { console.error(err.message); process.exit(1); }) : null;
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
        if (slug === "-") await keepSessionFlow(found, deps);
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
      // A worktree an earlier run of this change made, read before its branch moves: one holding work of its own is never reset.
      const earlierPath = (await cast(["ws", "path", worktree], top)).out.trim();
      const earlier = earlierPath && fs.existsSync(earlierPath) ? earlierPath : null;
      if (earlier && (branch || sessionRef)) {
        const dirty = spawnSync("git", ["-C", earlier, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf-8" }).stdout.trim();
        if (dirty) { console.error(`The run's worktree ${earlier} holds uncommitted work from an earlier run; finish or clear it before running this change again`); process.exit(1); }
      }
      // A task named alone brings the branch an earlier run of it left, when the flow works on a branch.
      if (!branch && !sessionRef && task && found.takes.includes("branch")) {
        const known = [`codecast/${worktree}`, `line-${task}`, `codecast/line-${task}`].find((b) => spawnSync("git", ["-C", top, "rev-parse", "--verify", "--quiet", b]).status === 0);
        if (!known) {
          console.error(`${found.label} works on a change, and ${task} has no branch here yet: run it from the session that made the change (its own edits), or name the change with --branch or --pr`);
          process.exit(1);
        }
        branch = known;
      }
      if (branch) {
        const head = spawnSync("git", ["-C", top, "rev-parse", branch], { encoding: "utf-8" }).stdout.trim();
        if (!head) { console.error(`No branch ${branch} here`); process.exit(1); }
        change = { source: opts.pr ? "pr" : "branch", base: head, tip: head, branch, worktree, paths: [], shared: [], held: [] };
      } else if (sessionRef) {
        const { freezeSessionChange } = await import("./workflow/flowChange.js");
        try {
          change = await freezeSessionChange(top, sessionRef, { branch: `codecast/${worktree}`, worktree, title: changeTitle, only });
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
      }
      if (change) {
        const ws = await cast(["ws", "acquire", worktree, "--branch", change.branch, "--skip-pool", "--json"], top);
        if (ws.code !== 0) { console.error(`Could not make the worktree for the change: ${(ws.err || ws.out).trim().split("\n").pop()}`); process.exit(1); }
        // A rerun moved the branch under the worktree an earlier run made: its files follow the new tip.
        if (earlier) spawnSync("git", ["-C", earlier, "reset", "--quiet", "--hard", change.tip]);
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

  // The daemon's tracer for a Claude Code Workflow run (daemon.ts
  // workflowRunGraph): the script as the graph it ran, as JSON, in its own
  // process so a script that never yields cannot hold the daemon.
  flow
    .command("trace <script>", { hidden: true })
    .description("Print the graph a Claude Code workflow script would run, as JSON (the daemon's tracer)")
    .action(async (script: string) => {
      const { traceScriptGraph } = await import("./workflow/flowImport.js");
      const text = fs.readFileSync(script, "utf-8");
      console.log(JSON.stringify(await traceScriptGraph(text, launchArgs(script, text))));
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
      const session = deps.callingSession() ?? null;
      const out = await importWorkflowScript(text, { kind: opts.as === "line" ? "line" : "segment", slug: opts.slug, cwd, force: !!opts.force, args, session: await shortSessionId(session, deps) });
      console.log(`✓ ${out.slug}: ${out.stations.join(" → ")}`);
      console.log(dim(`  ${path.relative(cwd, out.file)}`));
      for (const p of out.prompts) console.log(dim(`  ${path.relative(cwd, p)}`));
      for (const n of out.notes) console.log(`  ${n}`);
      console.log(`\nThis is your draft: it still carries the task it ran for, so only this session sees it in the pool. To publish it, make it general: name each station and the flow for what it does in any change, give it a description that names no one task, rewrite the prompts above the same way (the task's words become $task_title, $task_description, $acceptance_criteria, $branch), delete draft= from its graph line, then: cast flow publish ${out.slug}`);
    });

  // A hold parks every new run of a live flow while a wait no person needs to answer runs out (a spent budget until
  // its roll-over). A hand or the watcher sets one; only a person clears it, in the browser.
  flow
    .command("hold <until> <why>")
    .description("Hold a live flow's new runs until a time (90m, 6h, 2d or a date and time, at most 48h): a second hold keeps the later end; a person clears it in the browser")
    .option("--flow <flow>", "The live flow (default: the team's one)")
    .option("--team <name>", "The team whose live flow it is (default: the workspace this directory reads)")
    .option("--json", "Print the hold as JSON")
    .action(async (until: string, why: string, opts: { flow?: string; team?: string; json?: boolean }) => {
      const at = holdUntil(until);
      if (typeof at !== "number") { console.error(at.error); process.exit(1); }
      if (!why.trim()) { console.error("Say why the flow waits"); process.exit(1); }
      const ws = await deps.writeWorkspace(opts.team);
      const r = await deps.cliPost("/cli/flow/live/hold", { ...(ws.kind === "team" ? { team_id: ws.teamId } : {}), ...(opts.flow ? { flow: opts.flow } : {}), why: why.trim(), until: at, from_session: deps.callingSession() });
      if (opts.json) { console.log(JSON.stringify(r, null, 2)); return; }
      const hold = r?.hold as LiveFlow["hold"];
      console.log(hold ? `✓ held until ${new Date(hold.until).toLocaleString()}: ${hold.why}${hold.until > at ? dim("  (an earlier hold ends later, so it stands)") : ""}` : "✓ held");
      if (r?.waiting) console.log(dim(`  waiting: ${r.waiting}`));
    });

  // A live flow's switch: the server holds who may turn it, and refuses everyone else in its own words.
  for (const on of [true, false]) {
    flow
      .command(`${on ? "on" : "off"} [flow]`)
      .description(on ? "Switch a live flow on: its queue starts problems by itself (a person's switch; the server refuses agents)" : "Switch a live flow off: nothing starts from its queue until it is on again (a person's switch)")
      .option("--team <name>", "The team whose live flow it is (default: the workspace this directory reads)")
      .option("--json", "Print the live flow as JSON")
      .action(async (name: string | undefined, opts: { team?: string; json?: boolean }) => {
        // A switch is a write: it names its team outright, and the server decides who may turn it.
        const ws = await deps.writeWorkspace(opts.team);
        const l: LiveFlow | null = await deps.cliPost(`/cli/flow/live/${on ? "on" : "off"}`, { ...(ws.kind === "team" ? { team_id: ws.teamId } : {}), ...(name ? { flow: name } : {}), from_session: deps.callingSession() });
        if (opts.json) { console.log(JSON.stringify(l, null, 2)); return; }
        if (!l) { console.error("No live flow to switch"); process.exit(1); }
        for (const line of liveFlowLines(l, { top: 3, bold, dim })) console.log(line);
      });
  }
  return flow;
}

/** What a variant changes from the flow it extends, under its header. */
function printVariantChanges(slug: string, base: PoolFlow | null, changes: VariantChanges | null): void {
  if (!base) { console.log(dim(`extends ${slug}, which this library does not hold`)); return; }
  const lines = changes ? variantChangeLines(changes) : [];
  console.log(`extends ${bold(base.label)} ${dim(`(${slug})`)}${lines.length ? ", changing:" : changes ? ", changing nothing" : ""}`);
  for (const l of lines) console.log(`  ${l}`);
}

/** A graph file's base read from where its `extends` points, for a variant whose base is not in the library. */
function baseBeside(f: FoundFlow): PoolFlow | null {
  let ext: string | undefined;
  try { ext = f.file ? graphExtends(f.source) : undefined; } catch { return null; }
  const file = ext ? path.resolve(path.dirname(f.file!), ext) : null;
  if (!file || !fs.existsSync(file)) return null;
  return describeFlow(path.basename(file).replace(/\.cast$/, ""), fs.readFileSync(file, "utf-8"), "repo", file);
}

/** A pool flow's parsed graph, or null when it has none or does not parse. */
function graphOf(f: (PoolFlow & { source?: string }) | null | undefined): WorkflowGraph | null {
  if (!f || f.errors.length) return null;
  const source = f.source ?? (f.file ? fs.readFileSync(f.file, "utf-8") : BUILTIN_WORKFLOW_TEMPLATES[f.slug]);
  if (!source) return null;
  try { return parseWorkflowSource(source, f.file ? path.dirname(f.file) : undefined); } catch { return null; }
}

/** The team's live flows, or why they could not be read (the pool still lists without them). */
async function readLive(deps: FlowDeps, team?: string): Promise<{ flows: LiveFlow[]; error: string | null }> {
  try {
    // A personal workspace has no live flow, and a server from before them answers 404 (convex liveFlows.ts).
    const ws = await deps.readWorkspace(team);
    if (ws.kind !== "team") return { flows: [], error: null };
    const r = await deps.cliPost("/cli/flow/live/show", { team_id: ws.teamId }, { throwOnError: true }).catch((err: Error) => {
      if (err.message.includes("/cli/flow/live/show route")) return null;
      throw err;
    });
    return { flows: Array.isArray(r) ? r : r ? [r] : [], error: null };
  } catch (err) {
    return { flows: [], error: err instanceof Error ? err.message : String(err) };
  }
}

type FoundFlow = PoolFlow & { source: string };

/** A session's 7-character codecast id, from whatever id the caller holds (its codecast id, or its agent's session id). */
async function shortSessionId(session: string | null, deps: FlowDeps): Promise<string | null> {
  if (!session) return null;
  if (/^jx[a-z0-9]{5,}$/.test(session)) return session.slice(0, 7);
  const { readLocalConversationMap } = await import("./localConversationMap.js");
  const conv = readLocalConversationMap()[session];
  return conv ? String(conv).slice(0, 7) : session.slice(0, 8);
}

/**
 * A flow this session wrote on stdin, kept for what comes next: where its file is (run it again, or edit it,
 * by that path) and pushed as the session's own draft graph, so the transcript draws it before any run.
 */
async function keepSessionFlow(f: Pick<FoundFlow, "file" | "slug">, deps: FlowDeps): Promise<void> {
  if (!f.file) return;
  console.log(dim(`kept at ${path.relative(deps.realCwd(), f.file)}`));
  await cast(["workflow", "push", f.file], deps.realCwd());
}

/** A flow's slots: each one's id, what it must do, and how it is filled. An empty one makes the flow a backbone to extend. */
function printSlots(f: Pick<FoundFlow, "stations" | "slug">): void {
  const slots = f.stations.filter((s) => s.slot);
  if (!slots.length) return;
  console.log(bold("\nslots"));
  const how = { empty: "empty", default: "default steps", generated: "filled here" } as const;
  for (const s of slots) console.log(`  ${s.id.padEnd(16)} ${how[s.slot!.filled].padEnd(14)} ${dim(s.slot!.does)}`);
  if (slots.some((s) => s.slot!.filled === "empty")) console.log(dim(`  fill them from a flow with graph [extends="${f.slug}"] and subgraph <slot> { ... }`));
}

/** The deps with the pool read from a named team's workspace. */
const teamDeps = (deps: FlowDeps, team?: string): FlowDeps => (team ? { ...deps, readWorkspace: () => deps.readWorkspace(team) } : deps);

/** The flows published to the workspace's pool (/cli/workflows/pool, flows.md FL2). */
async function fetchPool(deps: FlowDeps): Promise<PushedPoolRow[]> {
  const ws = await deps.readWorkspace();
  const r = await deps.cliPost("/cli/workflows/pool", ws.kind === "team" ? { team_id: ws.teamId } : {});
  return r?.flows ?? [];
}

/** The pool as this session sees it: the repo's, the shipped, and the workspace's published flows. */
async function readPool(deps: FlowDeps) {
  const pushed = await fetchPool(deps).catch(() => []);
  return poolFlows(deps.realCwd(), await shortSessionId(deps.callingSession() ?? null, deps), pushed);
}

async function findFlow(slug: string, deps: FlowDeps, pool?: PoolFlow[]): Promise<FoundFlow> {
  if (slug === "-") {
    // A graph this session writes now: kept in the checkout as its draft, the library flows it names pinned beside it.
    const { readStdin, writeSessionFlow } = await import("./workflow/sessionFlow.js");
    const text = readStdin();
    if (!text.trim()) { console.error("No graph on stdin: pipe a flow's digraph in, e.g. cast flow run - <<'EOF' ... EOF"); process.exit(1); }
    const top = (spawnSync("git", ["-C", deps.realCwd(), "rev-parse", "--show-toplevel"], { encoding: "utf-8" }).stdout ?? "").trim() || deps.realCwd();
    try {
      const kept = writeSessionFlow(top, text, await shortSessionId(deps.callingSession() ?? null, deps), (pool ?? (await readPool(deps))));
      return { ...describeFlow(kept.slug, kept.source, "repo", kept.file), source: kept.source };
    } catch (err) {
      console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }
  const abs = path.resolve(deps.realCwd(), slug);
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
    const source = fs.readFileSync(abs, "utf-8");
    return { ...describeFlow(path.basename(abs).replace(/\.cast$/, ""), source, "repo", abs), source };
  }
  const f = (pool ?? (await readPool(deps))).find((p) => p.slug === slug.replace(/\.cast$/, ""));
  if (!f) {
    console.error(`No flow "${slug}" in the pool. cast flow ls lists them.`);
    process.exit(1);
  }
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
