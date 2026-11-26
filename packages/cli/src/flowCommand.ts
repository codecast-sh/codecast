// `cast flow` (docs/architecture/flows.md): the team's library of structured
// flows and its live flows. A flow is a .cast graph; a whole flow takes a
// change to done, a variant extends a flow and changes only what differs, a
// segment does one part of the path. A live flow is a flow switched on, with
// sources feeding one queue. This file lists the library and the live flows,
// shows one, runs a change through one, switches a live flow, and turns a
// Claude Code workflow script into a flow (lineCommand.ts adds the flows'
// working commands).
import { registerIntentCommands } from "./workflow/intentCommands.js";
import type { Command } from "commander";
import { commandGroup } from "./commandGroups.js";
import { spawnSync } from "./proc.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { holdUntil, libraryTree, liveFlowLines, namesLiveFlow, variantChangeLines, variantChanges, variantSummary, type LibraryNode, type LiveFlow, type VariantChanges } from "./flowLibrary.js";
import type { WorkflowGraph } from "./workflow/types.js";
import { graphExtends, parseWorkflowSource } from "./workflow/parser.js";
import { flowLine } from "./workflow/flowPool.js";
import type { Workspace } from "./resolveWorkspace.js";
import { choiceOption } from "./argChecks.js";
import { staleRepoFlow } from "./workflow/staleRepoFlow.js";
import { registerFlowStations } from "./flowStations.js";
import { registerFlowEditCommand } from "./flowEditCommand.js";
import { registerFlowAwaitDeployCommand } from "./flowAwaitDeployCommand.js";
import { registerFlowRunsCommand } from "./flowRunsCommand.js";
import { baseOf, graphOf, printVariantChanges } from "./flowBase.js";
import { findFlow, poolWorkspace, readPool, shortSessionId, type FoundFlow, type PoolAt } from "./flowFind.js";
import { acquireFailureLine, castResult } from "./flowAcquire.js";

export interface FlowDeps {
  cliPost: (urlPath: string, body: Record<string, any>, opts?: { timeoutMs?: number; throwOnError?: boolean }) => Promise<any>;
  /** The session this `cast` runs inside (its codecast id or agent session id), or undefined at a plain shell. */
  callingSession: () => string | undefined;
  realCwd: () => string;
  /** The workspace a read names: the team given, else the one this shell reads. */
  readWorkspace: (team?: string) => Promise<Workspace>;
  /** The team this directory is mapped to (`cast teams map`, directoryTeam.ts), or null when none is. */
  directoryTeam: () => Promise<string | null>;
  /** The workspace a write names outright (a team, or it stops with why). */
  writeWorkspace: (team?: string) => Promise<Workspace>;
  /** Stops with the team feature's own words unless Flows is on for the workspace (the team given, else this shell's).
   *  The commands that start work call it; reading and a run already going are left alone. */
  /** Stops the command, saying why, when Flows is off in this workspace. */
  requireFlows: (ws: Workspace) => Promise<void>;
  /** This machine's `flow` config: the default machine a flow run is placed on (workflow/placedChange.ts). */
  flowDeviceConfig?: () => import("./workflow/placedChange.js").FlowDeviceConfig | undefined;
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const KIND_MARK: Record<string, string> = { agent: "◉", script: "▶", person: "◇", segment: "▣", call: "○", parallel: "⫴" };

/** A session's inbox row, from any ref to it (its codecast id, short id or agent session id); null when unreadable. */
async function sessionRowOf(ref: string, deps: Pick<FlowDeps, "cliPost">): Promise<any | null> {
  const read = await deps.cliPost("/cli/inbox", { session_ids: [ref], show_all: true, limit: 5 }).catch(() => null);
  const rows: any[] = read?.sessions ?? [];
  return rows.find((r) => r.id === ref) ?? (rows.length === 1 ? rows[0] : null);
}

/** A session's own title, when it has one worth naming a change by. */
async function sessionTitleOf(conversation: string, deps: Pick<FlowDeps, "cliPost">): Promise<string | null> {
  const row = await sessionRowOf(conversation, deps);
  const t = String(row?.short_title || row?.title || "").trim();
  return t && t !== "New Session" ? t.slice(0, 120) : null;
}

/** What `cast flow run` prints for a change upstream already holds: JSON for a caller that parses it (`--json`), else a sentence. */
export function landedOutput(json: boolean, what: string, upstream: string, landed: string): string {
  return json ? JSON.stringify({ landed, upstream }) : `${what} is already on ${upstream} at ${landed.slice(0, 10)}: nothing to run.`;
}

/**
 * The run's subject when the change is named (a task, branch or pull request) from inside a session: that session
 * started the run, so it hears what each stage finds (flows.md FL4). From a plain shell (a run started over ssh on
 * another machine), the session the task's change came from (`change_session` on /cli/work/get). Undefined when there is neither.
 */
export async function callingSubject(deps: Pick<FlowDeps, "cliPost" | "callingSession">, task?: string): Promise<{ session: string; conversation: string } | undefined> {
  const ref = deps.callingSession();
  const row = ref ? await sessionRowOf(ref, deps) : null;
  if (row?.id) return { session: String(row.id).slice(0, 7), conversation: String(row.id) };
  const made = task ? (await deps.cliPost("/cli/work/get", { short_id: task }).catch(() => null))?.change_session : null;
  return made?.conversation_id ? { session: String(made.short_id), conversation: String(made.conversation_id) } : undefined;
}

/**
 * What a run on a task named alone works on: the branch an earlier run of the task left in `top` (named for the run's
 * worktree, or a line's), else the calling session's own edits, else nothing it can run on. A branch an earlier run
 * froze from the calling session's edits is that session's change as it was: while the session still holds edits of
 * its own here (`hasOwnEdits`), those are frozen onto it again, so the edits it made since are not left out.
 */
export async function taskChange(top: string, worktree: string, task: string, callingSession: string | undefined, hasOwnEdits: (session: string) => Promise<boolean>): Promise<{ branch: string } | { session: string } | null> {
  const known = [`codecast/${worktree}`, `line-${task}`, `codecast/line-${task}`].find((b) => spawnSync("git", ["-C", top, "rev-parse", "--verify", "--quiet", b]).status === 0);
  if (known === `codecast/${worktree}` && callingSession && (await hasOwnEdits(callingSession))) return { session: callingSession };
  return known ? { branch: known } : callingSession ? { session: callingSession } : null;
}

/** The task a session is bound to (its task pulse, written by `cast task start`), while that task is still open. */
async function boundOpenTask(agentSession: string | undefined, deps: Pick<FlowDeps, "cliPost">): Promise<string | undefined> {
  const { readTaskPulseFor } = await import("./taskPulse.js");
  const bound = readTaskPulseFor(agentSession)?.task;
  if (!bound) return undefined;
  const row = await deps.cliPost("/cli/work/get", { short_id: bound }).catch(() => null);
  return row && row.status !== "done" && row.status !== "dropped" ? bound : undefined;
}

async function cast(args: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  const { resolveCastInvocation } = await import("./castInvocation.js");
  const { cmd, prefixArgs } = resolveCastInvocation();
  return castResult(spawnSync(cmd, [...prefixArgs, ...args], { cwd, encoding: "utf-8", env: process.env }));
}

/** When each way of putting work in a flow fits: what `cast flow --help` says after the verbs. */
export const FLOW_HELP = `
Choosing a flow:
  A library flow that fits the work runs as it stands: it carries what the team has learned.
  A library flow that fits as a backbone, with a step this change needs done its own way, is
  extended: name it with extends and add the steps you write, or fill its slots when it leaves
  some. The rest stays the team's.
  A flow written whole fits only when nothing in the library has the shape of the work.

  cast flow run                             the workspace's default flow (cast flow ls marks it),
                                            on this session's own edits; --task, --branch, --pr name another change
  cast flow run change                      a library flow by name, on this session's own edits
  cast flow run - <<'EOF'                   a flow written here, checked before it starts
  digraph flaky_fix {
    graph [extends="change"]
    reproduce [after="pr", prompt="Run the flaky test until it fails"]   steps of this change's own,
    prove [after="reproduce", script="bun test --rerun-each 20"]         ahead of CI and review
  }
  EOF

  cast flow edit change add lint --after pr --fix brief --run "bun run lint"
                                            a project's own step, one line in its flow (cast flow edit --help)

  cast flow show <flow> lists a flow's slots. A flow written here is kept in .codecast/session-flows/
  as this session's draft; its run draws in the conversation, where it can be saved to the library.
  A run keeps the station prompts it started with: an edited flow reaches it only at a gate answered
  after the edit, or when the run moves onto a newer version. The line profile's $line.* values are
  read again before every station.
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
    .option("--kind <kind>", "Only whole flows (line) or only segments (segment)", choiceOption(["line", "segment"]))
    .option("--team <name>", "Read this team's library (default: the workspace this directory reads)")
    .option("--json", "Print { library, live } as JSON")
    .action(async (opts: { kind?: string; json?: boolean; team?: string }) => {
      const at = poolWorkspace(deps, opts.team);
      const [{ flows: pool, defaultFlow }, live] = await Promise.all([readPool(deps, at), readLive(deps, at)]);
      const library = pool.filter((f) => !opts.kind || f.kind === opts.kind);
      const tree = libraryTree(library, live.flows);
      if (opts.json) {
        const spines = new Set(tree.spine.map((n) => n.flow.slug));
        console.log(JSON.stringify({ library: library.map((f) => ({ ...f, spine: spines.has(f.slug) })), default: defaultFlow?.slug ?? null, live: live.flows }, null, 2));
        return;
      }
      const home = (f: typeof pool[number]) => (f.slug === defaultFlow?.slug ? bold("  (default)") : "") + (f.draft ? dim("  (your draft)") : f.where === "repo" ? dim("  (this repo)") : f.where === "team" ? dim(`  (the team's${f.by ? `, from ${f.by}` : ""})`) : f.where === "pushed" ? dim("  (yours)") : "");
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
      if (defaultFlow) console.log(dim(`Run this session's change through ${defaultFlow.slug}, the default:  cast flow run`));
      console.log(dim("Run this session's change through one:  cast flow run <flow>"));
      console.log(dim("See a flow's stations and routes:        cast flow show <flow>"));
    });

  flow
    .command("show <flow>")
    .description("A flow's stations, what each does, and where each sends the work; for a variant, what it changes from the flow it extends; for a live flow, its switch, sources and queue first")
    .option("--team <name>", "Read this team's library (default: the workspace this directory reads)")
    .option("--json", "Print the flow as JSON (with its live flow, and a variant's changes)")
    .action(async (slug: string, opts: { json?: boolean; team?: string }) => {
      // A live flow is named by its flow (slug, label or id) or its own id; the flow it runs prints after it.
      const at = poolWorkspace(deps, opts.team);
      const [lives, { flows: pool }] = await Promise.all([readLive(deps, at), readPool(deps, at)]);
      const live = lives.flows.find((l) => namesLiveFlow(l, slug)) ?? null;
      const name = live ? live.flow.slug : slug;
      if (live && !pool.some((p) => p.slug === name)) {
        if (opts.json) { console.log(JSON.stringify({ live }, null, 2)); return; }
        for (const line of liveFlowLines(live, { top: 10, bold, dim })) console.log(line);
        console.log(dim(`\nIts flow ${name} is not in this team's library, so its stations cannot be read here.`));
        return;
      }
      const found = await findFlow(name, deps, pool);
      const stale = staleRepoFlow(found, deps.realCwd());
      if (stale) console.error(`! ${stale}`);
      const spineLive = live ?? lives.flows.find((l) => l.flow.slug === found.slug) ?? null;
      const base = found.extends ? baseOf(found, pool) : null;
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
      if (found.runs_from) console.log(dim(`runs from ${found.runs_from}${found.runs_from === "library" ? " (cast flow versions " + found.slug + ")" : ""}`));
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
        const what = s.slot?.filled === "empty" ? "slot, empty" : s.kind === "segment" ? `${s.slot ? "slot" : "segment"} ${s.flow ?? "written here"}, ${s.steps} step${s.steps === 1 ? "" : "s"}` : s.kind === "parallel" ? `${s.next.length} side by side, then join` : s.subject ? "the session the change came from" : s.kind;
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
    .command("pipeline")
    .description("This repository's pipeline: the change flow a session's Ship runs here and the release flow each deploy runs, every station with who does it, own or inherited, when it runs and what it runs, and the targets a release goes out to")
    .option("--team <name>", "Resolve the team's default flow and published flows for this team (default: the workspace this directory reads)")
    .option("--publish", "Also publish it for the app's pipeline page (every deploy targets publish does this too)")
    .option("--json", "Print the pipeline as JSON (contracts/pipeline.ts)")
    .action(async (opts: { team?: string; publish?: boolean; json?: boolean }) => {
      const { checkoutPipeline, pipelineLines, publishPipeline, teamFlowFacts } = await import("./pipeline.js");
      const cwd = deps.realCwd();
      const root = (spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf-8" }).stdout ?? "").trim();
      if (!root) { console.error("Not inside a repository: run from the checkout whose pipeline this is"); process.exit(1); }
      const ws = await deps.readWorkspace(opts.team).catch(() => null);
      const teamId = ws?.kind === "team" ? ws.teamId : null;
      const post = (p: string, b: Record<string, unknown>) => deps.cliPost(p, b, { throwOnError: true });
      const { deviceId } = await import("./remote/device.js");
      let pipeline;
      try {
        ({ pipeline } = await checkoutPipeline(root, { ...(await teamFlowFacts(post, teamId)), deviceId: deviceId() }));
      } catch (err) {
        console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      const published = opts.publish ? await publishPipeline(post, root, { teamId, deviceId: deviceId() }).catch((err: Error) => ({ error: err.message })) : null;
      if (opts.json) { console.log(JSON.stringify({ ...pipeline, ...(published ? { published } : {}) }, null, 2)); return; }
      for (const line of pipelineLines(pipeline)) console.log(line);
      if (!published) return;
      if ("error" in published) console.log(`\n✗ not published: ${published.error}`);
      else if ("skipped" in published) console.log(`\nNot published: ${published.skipped}`);
      else if (published.refused) console.log(`\nNot published: ${published.refused}`);
      else console.log(`\n${published.changed ? "Published" : "Already published, unchanged"} for ${published.repository}`);
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

  registerFlowEditCommand(flow, deps);

  flow
    .command("publish <flow>")
    .description("Publish a repo flow to the team's pool, where every member sees and runs it (cast flow ls, the Flows page)")
    .option("--team <name>", "The team whose pool it joins (default: your active team; personal keeps it yours)")
    .action(async (slug: string, opts: { team?: string }) => {
      await deps.requireFlows(await deps.readWorkspace(opts.team));
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
    .command("run [flow]")
    .description("Run a change through a flow (a library name, a file, or - for a graph on stdin; none runs the workspace's default flow, the one cast flow ls marks): this session's own edits by default, or a task, branch, pull request or the whole shared checkout")
    .option("--task <id>", "The change is this task's (its branch, or the session's edits bound to it)")
    .option("--session [id]", "The change is a session's own uncommitted edits (default: this session)")
    .option("--branch <name>", "The change is this branch")
    .option("--pr <number>", "The change is this pull request's head branch")
    .option("--checkout", "The change is everything uncommitted in this shared checkout, a commit per session that wrote it (as cast ship checkout plans a pass); each finding goes to the sessions that wrote the files it names")
    .option("--title <text>", "Title for the task the run binds to, when one is made")
    .option("--only <paths>", "With a session's edits: only these files belong to the change (comma-separated paths or globs)")
    .option("--foreground", "Run here and wait, rather than handing the run to this machine's daemon")
    .option("--device <name>", "Run the whole flow on this machine of yours (id, label or hostname), in its checkout of this repository; \"here\" keeps it on this one. Default: cast config flow.device")
    .option("--dry-run", "Say what would run on what, and start nothing")
    .option("--team <name>", "Read this team's pool (default: the workspace this directory reads)")
    .option("--library", "Run the library's flow of that name even though the repo's default branch has its own")
    .option("--json", "Print {run_id, task, branch, worktree, files} as JSON")
    .action(async (named: string | undefined, opts: { task?: string; session?: string | boolean; branch?: string; pr?: string; checkout?: boolean; title?: string; only?: string; foreground?: boolean; device?: string; dryRun?: boolean; json?: boolean; team?: string; library?: boolean }) => {
      // Flows must be on in the workspace the run reads its pool from, not merely the active one (flows.md FL2).
      const at = poolWorkspace(deps, opts.team);
      const where = await at.catch((err: unknown) => {
        console.error(`Could not tell which workspace this directory reads its flows from (${err instanceof Error ? err.message : String(err)}): pass --team`);
        process.exit(1);
      });
      await deps.requireFlows(where.ws);
      if (opts.checkout && (opts.session !== undefined || opts.branch || opts.pr || opts.only)) {
        console.error("--checkout runs the whole checkout's change: it takes no --session, --branch, --pr or --only");
        process.exit(1);
      }
      const only = opts.only ? opts.only.split(",").map((s) => s.trim()).filter(Boolean) : null;
      const cwd = deps.realCwd();
      const read = await readPool(deps, at);
      // No flow named: the workspace's default, by the rule the web's pickers use (flows.md FL4).
      if (!named && read.failed) { console.error(`Could not read the workspace's flows, so its default flow is unknown (${read.failed}): name the flow to run (cast flow ls)`); process.exit(1); }
      if (!named && !read.defaultFlow) { console.error("No flow here takes a session's change, so there is no default to run: name one (cast flow ls)"); process.exit(1); }
      const slug = named ?? read.defaultFlow!.slug;
      if (!named && !opts.json) console.error(`${dim("No flow named:")} running ${bold(slug)}, the workspace's default`);
      const found = await findFlow(slug, deps, read.flows);
      const stale = opts.library ? null : staleRepoFlow(found, cwd);
      if (stale) { console.error(`✗ ${stale}`); process.exit(1); }
      if (found.errors.length) { console.error(`✗ ${found.slug} does not run: ${found.errors.join("; ")}`); process.exit(1); }
      const empty = found.stations.filter((s) => s.slot?.filled === "empty");
      if (empty.length) {
        console.error(`✗ ${found.slug} is a backbone: ${empty.map((s) => s.id).join(", ")} ${empty.length === 1 ? "is a slot" : "are slots"} left to fill. Run a flow that extends it and fills ${empty.length === 1 ? "it" : "them"}:`);
        console.error(`  cast flow run - <<'EOF'\n  digraph <name> {\n    graph [extends="${found.slug}"]\n${empty.map((s) => `    subgraph ${s.id} { ... }   // ${s.slot!.does}`).join("\n")}\n  }\n  EOF`);
        process.exit(1);
      }
      const top = (spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf-8" }).stdout ?? "").trim();
      if (!top) { console.error("cast flow run works inside a git checkout"); process.exit(1); }
      // The machine the whole run goes to (ct-98920, workflow/placedChange.ts); null is here.
      const placed = await (await import("./workflow/placedChange.js")).runDeviceFor(opts.device, deps.flowDeviceConfig?.(), top, opts.foreground);
      if (placed && opts.checkout) { console.error(`--checkout runs this checkout's own pass, which only this machine can freeze again: pass --device here to run it here`); process.exit(1); }

      // Which change: a branch or PR names its own; else a session's edits, unless only a task was named.
      let sessionRef = opts.checkout ? undefined : typeof opts.session === "string" ? opts.session : opts.session === true || (!opts.task && !opts.branch && !opts.pr) ? deps.callingSession() : undefined;
      if (!opts.task && !opts.branch && !opts.pr && !sessionRef && !opts.checkout) {
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
      // A task named alone, when the flow works on a change: the branch an earlier run of it left, else the calling
      // session's own edits, bound to that task rather than a new one, so its description and requester stay the run's.
      if (task && !branch && !sessionRef && !opts.checkout && found.takes.includes("branch")) {
        const ownEdits = async (session: string) => {
          const { previewSessionChange } = await import("./workflow/flowChange.js");
          return previewSessionChange(top, session, only, { fetch: false }).then((p) => p.paths.length > 0, () => false);
        };
        const taken = await taskChange(top, runSlug(graph, { task_id: task }, "run"), task, deps.callingSession(), ownEdits);
        if (!taken) {
          console.error(`${found.label} works on a change, and ${task} has no branch here yet: run it from inside the session that made the change (its own edits), or name the change with --branch or --pr`);
          process.exit(1);
        }
        if ("branch" in taken) branch = taken.branch;
        else sessionRef = taken.session;
      }
      // A session's change is read first: a session with nothing here stops before anything is made.
      const { previewSessionChange, previewCheckoutChange, inboxRosterVia, NoCheckoutChange } = await import("./workflow/flowChange.js");
      const preview = sessionRef && !branch ? await previewSessionChange(top, sessionRef, only).catch((err) => { console.error(err.message); process.exit(1); }) : null;
      // The checkout's change is planned first too: a checkout with nothing that can ship stops before anything is made.
      const roster = inboxRosterVia((route, body) => deps.cliPost(route, body));
      const pass = opts.checkout ? await previewCheckoutChange(top, { roster }).catch((err) => { console.error(err.message); process.exit(1); }) : null;
      if (pass && !pass.groups.length) { console.error(new NoCheckoutChange(top, pass.held).message); process.exit(1); }
      // A change upstream already holds has nothing to land: nothing is made for it.
      const landed = preview?.landed ?? pass?.landed;
      if (landed) {
        console.log(landedOutput(!!opts.json, preview ? `Session ${preview.session}'s change` : "The shared checkout's change", (preview ?? pass)!.upstream, landed));
        return;
      }
      // A session's change runs on the session's own task (flows.md FL4): the one it is bound to, else one made and
      // bound to it below, so the run's messages and a second run find the same task, branch and worktree.
      const subjectRun = !task && !branch && !!preview;
      if (subjectRun) task = await boundOpenTask(preview!.agentSession, deps);
      // A session's change is named for what the session says it is doing: its own title, not the flow it runs through.
      const sessionTitle = preview?.conversation ? await sessionTitleOf(preview.conversation, deps) : null;
      const passFiles = pass?.groups.reduce((n, g) => n + g.paths.length, 0) ?? 0;
      const changeTitle = title ?? (branch ? `Run ${branch} through ${found.label}`
        : pass ? `Ship the shared checkout: ${passFiles} file${passFiles === 1 ? "" : "s"} in ${pass.groups.length} commit${pass.groups.length === 1 ? "" : "s"}`
        : sessionTitle ?? `Change from session ${preview?.session ?? "here"}`);
      if (opts.dryRun) {
        console.log(`${bold(found.label)}: ${found.stations.filter((s) => s.main).map((s) => s.label).join(" → ")}`);
        console.log(`on ${branch ? `branch ${branch}` : preview ? `session ${preview.session}'s own edits` : pass ? "the shared checkout's uncommitted pass" : `task ${task}`}, bound to ${task ?? `a new task "${changeTitle}"`}`);
        for (const g of pass?.groups ?? []) {
          const who = g.session ? `session ${g.session.id ?? g.session.conversation_id?.slice(0, 7) ?? g.id.slice(2)}${g.session.title ? ` (${g.session.title})` : ""}` : "no session's edit names these";
          console.log(`${who}: ${g.paths.length} file${g.paths.length === 1 ? "" : "s"}, ${dim(g.message)}`);
          for (const f of g.paths) console.log(`  ${f}`);
        }
        for (const h of pass?.held ?? []) console.log(`held out: ${h.path} (${h.why})`);
        console.log(placed ? `runs on ${placed.name} (${placed.device_id.slice(0, 8)}, ${placed.from}), in its checkout of this repository: the change's branch is pushed to origin and fetched there` : "runs on this machine");
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
      // One pass through a flow per checkout at a time: a second would freeze, brief and land the same files again.
      const checkoutGitDir = opts.checkout ? spawnSync("git", ["-C", top, "rev-parse", "--absolute-git-dir"], { encoding: "utf-8" }).stdout.trim() : "";
      if (opts.checkout) {
        const { claimCheckoutRun } = await import("./workflow/checkoutRunHold.js");
        const runLive = async (runId: string) => {
          const read = await deps.cliPost("/cli/workflow-runs/list", { run_id: runId, limit: 1, slim: true }).catch(() => null);
          if (!Array.isArray(read?.runs)) return null;
          return ["pending", "running", "paused"].includes(String(read.runs[0]?.status ?? ""));
        };
        await claimCheckoutRun(checkoutGitDir, runLive).catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
      }
      if (!task) {
        const made = await cast(["task", "create", changeTitle, "-d", `A change run through the ${found.label} flow (${found.slug}).`, "--found-during", "none"], top);
        task = (made.out + made.err).match(/\bct-\d+\b/)?.[0];
        if (!task) { console.error(`Could not make the task for this change: ${(made.err || made.out).trim()}`); process.exit(1); }
        // Bound only from the session itself: `task start` binds the session it runs in.
        if (subjectRun && sessionRef === deps.callingSession()) {
          const bound = await cast(["task", "start", task], top);
          if (bound.code !== 0) console.error(dim(`  ${task} was not bound to this session: ${(bound.err || bound.out).trim().split("\n").pop()}`));
        }
      }

      // The change on its own branch and worktree, named as the run's isolated stations name theirs.
      const worktree = runSlug(graph, { task_id: task }, "run");
      const runDir = lineRunDir(top, worktree);
      const { writeFrozenChange, originTip, freezeSessionChange } = await import("./workflow/flowChange.js");
      let change: import("./workflow/flowChange.js").FrozenChange | null = null;
      // A worktree an earlier run of this change made, read before its branch moves: one holding work of its own is never
      // reset; one on another branch (an earlier run's) keeps it there and is released (putChangeInWorktree).
      const earlierPath = (await cast(["ws", "path", worktree], top)).out.trim();
      const earlier = earlierPath && fs.existsSync(earlierPath) ? earlierPath : null;
      const earlierOn = earlier ? spawnSync("git", ["-C", earlier, "symbolic-ref", "--quiet", "--short", "HEAD"], { encoding: "utf-8" }).stdout.trim() : "";
      if (earlier && !placed && (branch || sessionRef || opts.checkout) && earlierOn === (branch ?? `codecast/${worktree}`)) {
        const dirty = spawnSync("git", ["-C", earlier, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf-8" }).stdout.trim();
        if (dirty) { console.error(`The run's worktree ${earlier} holds uncommitted work from an earlier run; finish or clear it before running this change again`); process.exit(1); }
      }
      if (branch) {
        const head = spawnSync("git", ["-C", top, "rev-parse", branch], { encoding: "utf-8" }).stdout.trim();
        if (!head) { console.error(`No branch ${branch} here`); process.exit(1); }
        const { branchChangePaths } = await import("./workflow/flowChangeFile.js");
        const remoteTip = await originTip(top, branch);
        // The files the branch changes, so a station gated on paths (when=) runs when they say it should.
        change = { source: opts.pr ? "pr" : "branch", ...(await callingSubject(deps, task)), base: head, tip: head, ...(remoteTip ? { remote_tip: remoteTip } : {}), branch, worktree, paths: branchChangePaths(top, branch), shared: [], held: [] };
      } else if (opts.checkout) {
        const { freezeCheckoutChange } = await import("./workflow/flowChange.js");
        try {
          // The session that ran this hears the findings that name none of the change's files.
          change = { ...(await freezeCheckoutChange(top, { branch: `codecast/${worktree}`, worktree, title: changeTitle, roster, fetched: true })), ...(await callingSubject(deps, task)) };
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
      } else if (sessionRef) {
        change = await freezeSessionChange(top, sessionRef, { branch: `codecast/${worktree}`, worktree, title: changeTitle, only, fetched: true }).catch((err: unknown) => {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        });
      }
      if (change) {
        const { behindWords } = await import("./workflow/flowChangeFile.js");
        const behind = behindWords(change);
        if (behind) console.error(`  behind upstream: ${behind}`);
      }
      // A placed run's machine makes the worktree in its own checkout: the change goes there by origin.
      const changeFile = change && placed ? (await import("./workflow/placedChange.js")).handOffPlacedChange(top, runDir, change) : null;
      if (change && !placed) {
        // The workspace's setup (its install) runs here, before the run starts: it can take minutes.
        if (!opts.json) console.error(dim(`  making worktree ${worktree} on ${change.branch} (its setup can take a few minutes)`));
        // A rerun moved the branch under the worktree an earlier run made, or brought another branch (putChangeInWorktree).
        const { runHandsVia } = await import("./lineTrialBranch.js");
        const { putChangeInWorktree } = await import("./workflow/flowChange.js");
        await putChangeInWorktree(top, worktree, earlier, change, task!, async () => {
          // No port: no station of a change runs a dev server of its own, and `cast dev` takes a free one if asked (ct-101923).
          const ws = await cast(["ws", "acquire", worktree, "--branch", change!.branch, "--skip-pool", "--no-ports", "--json"], top);
          if (ws.code !== 0) { console.error(acquireFailureLine(worktree, ws.out, ws.err)); process.exit(1); }
        }, runHandsVia((route, body) => deps.cliPost(route, body))).catch((err: Error) => { console.error(err.message); process.exit(1); });
        writeFrozenChange(runDir, change);
      }

      const runArgs = ["workflow", "run", found.file ?? found.slug, "--task", task!];
      if (!opts.foreground) runArgs.push("--detach", "--json");
      if (placed) runArgs.push("--device", placed.device_id, ...(changeFile ? ["--change", changeFile] : []));
      if (opts.foreground) {
        const { resolveCastInvocation } = await import("./castInvocation.js");
        const { cmd, prefixArgs } = resolveCastInvocation();
        // This process's pid holds the checkout while the run goes here. A run it leaves live (at a person's gate)
        // then holds it by its id.
        const r = spawnSync(cmd, [...prefixArgs, ...runArgs], { cwd: top, stdio: "inherit", env: process.env });
        if (opts.checkout) {
          const read = await deps.cliPost("/cli/workflow-runs/list", { task_id: task, limit: 1, slim: true }).catch(() => null);
          const run = Array.isArray(read?.runs) ? read.runs[0] : null;
          if (run?._id && ["pending", "running", "paused"].includes(String(run.status))) {
            try { (await import("./workflow/checkoutRunHold.js")).recordCheckoutRun(checkoutGitDir, String(run._id), task); } catch (err) { console.error(err instanceof Error ? err.message : String(err)); }
          }
        }
        process.exit(r.status ?? 1);
      }
      const started = await cast(runArgs, top);
      const runId = started.out.match(/"run_id"\s*:\s*"([^"]+)"/)?.[1];
      if (started.code !== 0 || !runId) { console.error((started.err || started.out).trim()); process.exit(1); }
      if (opts.checkout) {
        try {
          (await import("./workflow/checkoutRunHold.js")).recordCheckoutRun(checkoutGitDir, runId, task);
        } catch (err) {
          // The run is going; the checkout's hold says another pass has it, so a second pass is not kept out.
          console.error(`${err instanceof Error ? err.message : String(err)} Run ${runId} is going; cancel it (cast workflow cancel ${runId}) if the other pass holds the same files.`);
          process.exitCode = 1;
        }
      }
      const result = { run_id: runId, task, flow: found.slug, branch: change?.branch ?? null, worktree: change ? worktree : null, files: change?.paths ?? [], shared: change?.shared ?? [], held: change?.held ?? [], ...(placed ? { device: placed.device_id } : {}) };
      if (opts.json) { console.log(JSON.stringify(result)); return; }
      console.log(`${bold(found.label)} started on ${task}${placed ? ` on ${placed.name}` : ""}: ${found.stations.filter((s) => s.main).map((s) => s.label).join(" → ")}`);
      if (change?.source === "session") {
        console.log(`  ${change.paths.length} file${change.paths.length === 1 ? "" : "s"} from session ${change.session} on ${change.branch}`);
        for (const s of change.shared) console.log(`  ${s.path} also holds edits from ${s.also.join(", ")}`);
        for (const h of change.held) console.log(`  held out: ${h.path} (${h.why})`);
      } else if (change?.source === "checkout") {
        console.log(`  ${change.paths.length} file${change.paths.length === 1 ? "" : "s"} from the shared checkout on ${change.branch}`);
        const bySession = new Map<string, number>();
        for (const p of change.paths) { const w = change.writers?.[p]?.session ?? "no session"; bySession.set(w, (bySession.get(w) ?? 0) + 1); }
        for (const [w, n] of bySession) console.log(`  ${w}: ${n} file${n === 1 ? "" : "s"}`);
        for (const h of change.held) console.log(`  held out: ${h.path} (${h.why})`);
      } else if (change) console.log(`  on ${change.branch}`);
      console.log(dim(`  run ${runId} · cast workflow runs --task ${task}`));
    });

  flow.command("refreeze <run>").description("For a run placed on another machine (cast flow run --device): freeze this session's edits again onto the run's branch, without touching this tree, and push it for that machine to fetch")
    .action(async (runId: string) => (await import("./workflow/placedChange.js")).refreezeRunCommand(runId, deps.realCwd(), deps.cliPost));

  registerFlowAwaitDeployCommand(flow, deps, cast);
  registerFlowRunsCommand(flow, deps);

  // What the judge segment's call reads (workflow/blindChange.ts): a change's
  // diff or the guidelines it answers to, with every sign of its author removed.
  flow
    .command("blind <part>", { hidden: true })
    .description("Print a change's diff or its repository's guidelines with every sign of its author removed, as one JSON object { text, ... } (part: diff or guidelines)")
    .requiredOption("--head <ref>", "The change's branch or commit")
    .option("--base <ref>", "The branch it goes into; the change runs from their merge base", "main")
    .option("--redact <words...>", "More names or ids to remove from the diff (a session, a branch)")
    .option("--unified <lines>", "Lines of context around each hunk; a large number shows each changed file whole", "5")
    .option("--record <chars>", "The JSON size to fit (default: what a station records)")
    .action(async (part: string, opts: { head: string; base: string; redact?: string[]; unified: string; record?: string }) => {
      const { blindDiff, blindGuidelines } = await import("./workflow/blindChange.js");
      const range = { cwd: deps.realCwd(), base: opts.base, head: opts.head, redact: opts.redact, unified: Number(opts.unified) || 5, ...(opts.record ? { record: Number(opts.record) } : {}) };
      if (part === "diff") console.log(JSON.stringify(blindDiff(range)));
      else if (part === "guidelines") console.log(JSON.stringify(blindGuidelines(range)));
      else throw new Error(`The part is diff or guidelines, not ${part}`);
    });

  // The intent segment's commands (asker, intent-verify).
  registerIntentCommands(flow, deps.cliPost);

  // The daemon's tracer for a Claude Code Workflow run (daemon.ts
  // workflowRunGraph): the script as the graph it ran, as JSON, in its own
  // process so a script that never yields cannot hold the daemon.
  flow
    .command("trace <script>", { hidden: true })
    .description("Print the graph a Claude Code workflow script would run, as JSON (the daemon's tracer)")
    .action(async (script: string) => {
      const { traceScriptGraph, launchArgs } = await import("./workflow/flowImport.js");
      const text = fs.readFileSync(script, "utf-8");
      console.log(JSON.stringify(await traceScriptGraph(text, launchArgs(script, text))));
    });

  // Graphs for this machine's workflow runs that finished before the daemon could trace them (workflowRunBackfill.ts).
  flow
    .command("backfill")
    .description("Send the graphs of this machine's Claude Code workflow runs the server has none for (the library's From sessions)")
    .option("--days <n>", "How far back to look", "14")
    .action(async (opts: { days: string }) => {
      const { backfillRunGraphs } = await import("./workflowRunBackfill.js");
      const since = Date.now() - Math.max(1, Number(opts.days) || 14) * 86_400_000;
      const c = await backfillRunGraphs((body) => deps.cliPost("/cli/workflow-runs/graph", body), { since, log: (l) => console.log(dim(l)) });
      console.log(`${c.sent} sent, ${c.had} already held, ${c.noScript} without a script, ${c.failed} failed, of ${c.runs} runs`);
      if (c.failed) process.exitCode = 1;
    });

  flow
    .command("import <script>")
    .description("Turn a Claude Code workflow script (a path, or a wf_ run id) into a flow under .codecast/flows/")
    .option("--as <kind>", "segment or line", "segment")
    .option("--slug <name>", "The flow's name in the pool (default: the script's meta name)")
    .option("--force", "Replace a flow of that name")
    .option("--args <json>", "The args the script reads (default: the args its run was launched with, when this machine ran it)")
    .action(async (script: string, opts: { as: string; slug?: string; force?: boolean; args?: string }) => {
      await deps.requireFlows(await deps.readWorkspace());
      const { importWorkflowScript, resolveScript, launchArgs } = await import("./workflow/flowImport.js");
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
  // its roll-over). A hand or the watcher sets one; a team admin clears it with unhold or on the Flows page.
  flow
    .command("hold <until> <why>")
    .description("Hold a live flow's new runs until a time (90m, 6h, 2d or a date and time, at most 48h): a second hold keeps the later end; cast flow unhold clears it")
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

  flow
    .command("unhold [flow]")
    .description("Clear a live flow's hold: its queue starts runs again (a team admin's act)")
    .option("--team <name>", "The team whose live flow it is (default: the workspace this directory reads)")
    .option("--json", "Print the live flow as JSON")
    .action(async (name: string | undefined, opts: { team?: string; json?: boolean }) => {
      const ws = await deps.writeWorkspace(opts.team);
      const l: LiveFlow | null = await deps.cliPost("/cli/flow/live/unhold", { ...(ws.kind === "team" ? { team_id: ws.teamId } : {}), ...(name ? { flow: name } : {}), from_session: deps.callingSession() });
      if (opts.json) { console.log(JSON.stringify(l, null, 2)); return; }
      if (!l) { console.error("No live flow to clear"); process.exit(1); }
      for (const line of liveFlowLines(l, { top: 3, bold, dim })) console.log(line);
    });

  // The bar: which problems the flow's machines take. A team admin sets it; a problem under it waits for another finding.
  flow
    .command("bar [flow]")
    .description("Set which problems a live flow runs: those scoring at least --score or holding at least --findings findings; the rest wait for another finding and close after --quiet-days with none (a team admin's setting)")
    .option("--score <n>", "The lowest score that runs (0 to 100)")
    .option("--findings <n>", "The findings that run a problem whatever it scored")
    .option("--quiet-days <n>", "Days a problem under the bar waits for another finding before it closes", "14")
    .option("--off", "Take the bar off: every problem runs, in score order")
    .option("--team <name>", "The team whose live flow it is (default: the workspace this directory reads)")
    .option("--json", "Print the result as JSON")
    .action(async (name: string | undefined, opts: { score?: string; findings?: string; quietDays: string; off?: boolean; team?: string; json?: boolean }) => {
      const num = (v: string | undefined) => (v === undefined ? NaN : Number(v));
      const bar = { score: num(opts.score), findings: num(opts.findings), quiet_days: num(opts.quietDays) };
      if (!opts.off && (!Number.isFinite(bar.score) || !Number.isFinite(bar.findings))) { console.error("Name the bar with --score and --findings, or take it off with --off"); process.exit(1); }
      const ws = await deps.writeWorkspace(opts.team);
      const r = await deps.cliPost("/cli/flow/live/bar", { ...(ws.kind === "team" ? { team_id: ws.teamId } : {}), ...(name ? { flow: name } : {}), ...(opts.off ? { off: true, score: 0, findings: 1, quiet_days: 1 } : bar), from_session: deps.callingSession() });
      if (opts.json) { console.log(JSON.stringify(r, null, 2)); return; }
      console.log(r?.bar ? `✓ the flow runs problems at ${r.words}; the rest wait for another finding, ${r.bar.quiet_days} days` : "✓ no bar: every problem runs, in score order");
    });

  // A live flow's switch: a team admin's, from here or the Flows page.
  for (const on of [true, false]) {
    flow
      .command(`${on ? "on" : "off"} [flow]`)
      .description(on ? "Switch a live flow on: its queue starts problems by itself (a team admin's switch)" : "Switch a live flow off: nothing starts from its queue until it is on again (a team admin's switch)")
      .option("--team <name>", "The team whose live flow it is (default: the workspace this directory reads)")
      .option("--json", "Print the live flow as JSON")
      .action(async (name: string | undefined, opts: { team?: string; json?: boolean }) => {
        // A switch is a write: it names its team outright, and the server decides who may turn it.
        if (on) await deps.requireFlows(await deps.readWorkspace(opts.team));
        const ws = await deps.writeWorkspace(opts.team);
        const l: LiveFlow | null = await deps.cliPost(`/cli/flow/live/${on ? "on" : "off"}`, { ...(ws.kind === "team" ? { team_id: ws.teamId } : {}), ...(name ? { flow: name } : {}), from_session: deps.callingSession() });
        if (opts.json) { console.log(JSON.stringify(l, null, 2)); return; }
        if (!l) { console.error("No live flow to switch"); process.exit(1); }
        for (const line of liveFlowLines(l, { top: 3, bold, dim })) console.log(line);
      });
  }
  return registerFlowStations(flow, deps);
}

/** The team's live flows, or why they could not be read (the pool still lists without them). */
async function readLive(deps: FlowDeps, at: PoolAt): Promise<{ flows: LiveFlow[]; error: string | null }> {
  try {
    // A personal workspace has no live flow, and a server from before them answers 404 (convex liveFlows.ts).
    const { ws } = await at;
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
