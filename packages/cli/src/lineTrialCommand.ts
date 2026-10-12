// `cast line trial` (convex/lineTrial.ts): a trial project runs the whole flow
// for real and stops at the decision card. Its gates ask nobody; each becomes
// a trial card, answered on the trial review page (/trial in the app).
//
//   cast line trial [--project <ref>] [--json]            spend, then the cards
//   cast line trial on --project <ref> [--graph <file>]   make a project a trial
//   cast line trial off --project <ref>
//   cast line trial run <ct-N> [--graph <file>]           start a trial run (3 running at most)
//   cast line trial answer <tc-N> <key> [note]            answer a card (an agent: an earlier gate only)
//   cast line trial recard <tc-N> --file <card.json>      replace a waiting change card with a rebuilt one
//   cast line trial recard <tc-N> --proposal <file>       give a proposal gate its proposal card
import path from "node:path";
import fs from "node:fs";
import type { Command } from "commander";
import { fmt } from "./colors.js";
import { apiPost, type PublishDeps } from "./castApi.js";
import { durationWords } from "@codecast/shared/contracts/moments";
import { execFileAsync } from "./proc.js";

function fail(message: string, code = 2): never {
  console.error(fmt.error(message));
  process.exit(code);
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const age = (ms: number) => durationWords(Math.max(0, Date.now() - ms));

export function registerLineTrialCommands(line: Command, deps: PublishDeps): void {
  const scope = async () => {
    const { scopeFor } = await import("./signalCommand.js");
    const s: Record<string, unknown> = { ...(await scopeFor(deps, undefined, true)) };
    delete s.project;
    return s;
  };
  const post = async (route: string, body: Record<string, unknown>, read = false) => apiPost(deps, route, { ...(await scope()), ...body }, read ? { read: true } : undefined);

  // --project reads on `trial` or on its subcommand: commander hands it to whichever names it first.
  const projectOf = (opts: { project?: string }): string => opts.project ?? trial.opts().project ?? fail("--project <ref> is required");
  const trial = line
    .command("trial")
    .description("Trial projects: the flow runs for real up to the decision card and stops; cards are answered on the trial review page")
    .option("--project <ref>", "One trial project")
    .option("--json", "Machine-readable output")
    .action(async (options: { project?: string; json?: boolean }) => {
      const projects: Array<{ title: string }> = options.project ? [{ title: options.project }] : await post("/cli/line/trial/projects", {}, true);
      const out = [];
      for (const p of projects) {
        const spend = await post("/cli/line/trial/spend", { project: p.title }, true);
        const cards = await post("/cli/line/trial/cards", { project: p.title }, true);
        out.push({ project: p.title, spend, cards });
      }
      if (options.json) return console.log(JSON.stringify(options.project ? out[0] ?? null : out, null, 2));
      if (!out.length) return console.log("No trial projects. Make one with `cast line trial on --project <ref>`.");
      for (const { project, spend, cards } of out) {
        const b = spend.budget;
        console.log(`${fmt.label(project)}  since ${new Date(spend.since).toISOString().slice(0, 10)}  total ${usd(spend.total_usd)}`);
        console.log(`  model budget ${b.month}: ${usd(b.spent_usd)} of ${usd(b.cap_usd)} (judging ${usd(b.by_purpose.judge)}, grouping ${usd(b.by_purpose.grouping)}, calls ${usd(b.by_purpose.call)})${b.earlier_months_usd ? `, ${usd(b.earlier_months_usd)} earlier` : ""}${b.refused ? `, ${b.refused} refused` : ""}`);
        console.log(`  line runs: ${spend.runs} runs, ${spend.sessions} sessions, ${usd(spend.session_usd)}${spend.unpriced_tokens ? ` + ${Math.round(spend.unpriced_tokens / 1000)}k tokens unpriced` : ""}`);
        if (!cards.length) { console.log("  No cards yet."); continue; }
        for (const c of cards) {
          const state = c.status === "answered" ? `${c.answer.label}${c.answer.stand_in ? " (stand-in)" : ""}` : c.status;
          console.log(`  ${c.short_id}  ${c.kind === "card" ? "card    " : "proposal"}  ${state.padEnd(10)}  ${age(c.created_at).padEnd(8)}  ${c.task_short_id}  ${c.task_title.slice(0, 80)}`);
        }
      }
    });

  trial
    .command("on")
    .description("Make a project a trial: its gates ask nobody and nothing merges")
    .option("--project <ref>", "The project")
    .option("--graph <file>", "The trial graph `cast line trial run` starts; its checkout is where the run starts")
    .option("--json", "Machine-readable output")
    .action(async (opts: { project?: string; graph?: string; json?: boolean }) => {
      const options = { ...opts, project: projectOf(opts) };
      let graph: string | undefined;
      let cwd: string | undefined;
      if (options.graph) {
        graph = path.resolve(process.env.CODECAST_CWD || process.cwd(), options.graph);
        if (!fs.existsSync(graph)) fail(`No graph at ${graph}`);
        // A line graph runs from the directory above its line/ folder, as its script nodes expect.
        cwd = path.basename(path.dirname(graph)) === "line" ? path.dirname(path.dirname(graph)) : path.dirname(graph);
      }
      const result = await post("/cli/line/trial/set", { project: options.project, on: true, ...(graph ? { graph, cwd } : {}) });
      if (options.json) return console.log(JSON.stringify(result, null, 2));
      console.log(`${result.project} is a trial project: its gates become trial cards and nothing merges.${result.graph ? `\n  runs start ${result.graph} from ${result.cwd}` : ""}`);
    });

  trial
    .command("off")
    .description("End a project's trial: its gates ask people again")
    .option("--project <ref>", "The project")
    .action(async (opts: { project?: string }) => {
      const options = { project: projectOf(opts) };
      const result = await post("/cli/line/trial/set", { project: options.project, on: false });
      console.log(`${result.project} is no longer a trial project.`);
    });

  trial
    .command("run <task>")
    .description("Start a trial run on one problem of a trial project, on this machine's daemon (3 running at most)")
    .option("--graph <file>", "A graph other than the project's trial graph")
    .option("--json", "Machine-readable output")
    .action(async (task: string, options: { graph?: string; json?: boolean }) => {
      const target = await post("/cli/line/trial/run-target", { task }, true);
      if (target.live_run) fail(`${target.task} already has a run (${target.live_run})`);
      if (target.running >= target.cap) fail(`${target.running} trial runs are running; the cap is ${target.cap}. Start this one when one finishes or pauses at a card.`);
      const graph = options.graph ? path.resolve(process.env.CODECAST_CWD || process.cwd(), options.graph) : target.graph;
      if (!graph) fail(`${target.project} has no trial graph: cast line trial on --project "${target.project}" --graph <file>`);
      const cwd = options.graph ? (path.basename(path.dirname(graph)) === "line" ? path.dirname(path.dirname(graph)) : path.dirname(graph)) : target.cwd ?? path.dirname(graph);
      // Every run proves against unfixed code: an earlier run's branch is set aside (lineTrialBranch.ts).
      const [{ parseWorkflowFile }, { freshRunBranch }] = await Promise.all([import("./workflow/parser.js"), import("./lineTrialBranch.js")]);
      const fresh = await freshRunBranch(cwd, parseWorkflowFile(graph), target.task);
      const { stdout } = await execFileAsync("cast", ["workflow", "run", graph, "--task", target.task, "--detach", "--json"], { cwd, encoding: "utf8", env: { ...process.env, CODECAST_CWD: cwd } } as any);
      const started = JSON.parse(String(stdout).slice(Math.max(0, String(stdout).search(/[[{]/))));
      if (options.json) return console.log(JSON.stringify({ ...started, graph, cwd, ...fresh }, null, 2));
      console.log(`Started a trial run on ${target.task} (${started.run_id}), ${target.running + 1} of ${target.cap} running, on ${fresh.branch} from ${fresh.base}${fresh.set_aside ? ` (the earlier run's branch is codecast/${fresh.set_aside})` : ""}. Its cards appear on the trial review page.`);
    });

  // The dispatcher (convex lineTrial.dispatch, every 10 minutes) starts the
  // problems most in need of a run; these turn it on and show what it would do.
  const dispatchProject = (opts: { project?: string }): string => opts.project ?? dispatch.opts().project ?? projectOf({});
  const printPass = (r: any) => {
    console.log(`${fmt.label(r.project)}  spend ${usd(r.spent_usd)} of ${usd(r.cap_usd)}, ~${usd(r.per_run_usd)} a run, ${r.running} of ${r.cap} running`);
    if (r.started.length) console.log(`  started ${r.started.join(", ")}`);
    if (r.held) console.log(`  held: ${r.held}`);
    if (!r.due.length) return console.log("  Nothing due.");
    for (const d of r.due) console.log(`  ${d.task.padEnd(9)} ${String(d.findings).padStart(3)} findings  sev ${String(d.severity).padStart(2)}  ${d.regrouped ? `regrouped since ${d.last_run} run` : "never run"}  ${d.title.slice(0, 70)}`);
  };
  const dispatch = trial
    .command("dispatch")
    .description("Start the trial problems most in need of a run now (most live findings first, under the cap); --dry lists what is due")
    .option("--project <ref>", "The trial project")
    .option("--dry", "List what is due and what a pass would start; start nothing")
    .option("--json", "Machine-readable output")
    .action(async (opts: { project?: string; dry?: boolean; json?: boolean }) => {
      const r = await post("/cli/line/trial/dispatch", { project: dispatchProject(opts), ...(opts.dry ? { dry: true } : {}) });
      if (opts.json) return console.log(JSON.stringify(r, null, 2));
      printPass(r);
    });
  dispatch
    .command("on")
    .description("The trial starts its own runs every 10 minutes while its spend stays under --cap")
    .option("--project <ref>", "The trial project")
    .requiredOption("--cap <usd>", "Stop starting runs when the trial's spend (model budget and run sessions) would cross this")
    .action(async (opts: { project?: string; cap: string }) => {
      const r = await post("/cli/line/trial/dispatch-set", { project: dispatchProject(opts), cap_usd: Number(opts.cap) });
      console.log(`${r.project} starts its own runs under ${usd(r.cap_usd)}.`);
    });
  dispatch
    .command("off")
    .description("The trial starts no runs of its own")
    .option("--project <ref>", "The trial project")
    .action(async (opts: { project?: string }) => {
      const r = await post("/cli/line/trial/dispatch-set", { project: dispatchProject(opts) });
      console.log(`${r.project} no longer starts its own runs.`);
    });

  trial
    .command("answer <card> <key> [note...]")
    .description("Answer a trial card by its option key (an agent session may answer only an earlier gate, as a stand-in)")
    .option("--json", "Machine-readable output")
    .action(async (card: string, key: string, note: string[], options: { json?: boolean }) => {
      const result = await post("/cli/line/trial/answer", { card, key, ...(note.length ? { note: note.join(" ") } : {}) });
      if (options.json) return console.log(JSON.stringify(result, null, 2));
      console.log(`${result.short_id}: ${result.answer}. The run moves on.`);
    });

  trial
    .command("recard <card>")
    .description("Replace a waiting change card with one rebuilt by cast card build (the run keeps waiting on the same gate), or give a proposal gate its proposal card")
    .option("--file <card.json>", "The rebuilt change card")
    .option("--proposal <proposal.json>", "A proposal gate's card (cast card proposal)")
    .option("--graph <file>", "Take the card's answers from this graph's gate edges (decide, or proposal_gate with --proposal; same keys)")
    .option("--json", "Machine-readable output")
    .action(async (card: string, options: { file?: string; proposal?: string; graph?: string; json?: boolean }) => {
      const file = options.file ?? options.proposal ?? fail("--file <card.json> or --proposal <proposal.json> is required");
      let parsed: unknown;
      try { parsed = JSON.parse(fs.readFileSync(path.resolve(file), "utf-8")); } catch (err) { fail(`Could not read ${file}: ${err instanceof Error ? err.message : err}`); }
      let gateOptions: Array<{ key: string; label: string; description?: string }> | undefined;
      if (options.graph) {
        const [{ parseWorkflowFile }, { parseGateEdgeLabel }] = await Promise.all([import("./workflow/parser.js"), import("./workflow/runner.js")]);
        const graph = parseWorkflowFile(path.resolve(options.graph));
        // A change card answers on the decide gate's edges; a proposal card on the proposal gate's.
        const gate = options.proposal ? "proposal_gate" : "decide";
        gateOptions = graph.edges.filter((e) => e.from === gate && e.label).map((e) => parseGateEdgeLabel(e.label!));
        if (!gateOptions.length) fail(`${options.graph} has no labelled ${gate} edges`);
      }
      const result = await post("/cli/line/trial/recard", { card, ...(options.proposal ? { proposal: parsed } : { change_card: parsed }), ...(gateOptions ? { options: gateOptions } : {}) });
      if (options.json) return console.log(JSON.stringify(result, null, 2));
      console.log(`${result.short_id}: ${result.headline} (${result.checks.join(", ")})`);
    });
}
