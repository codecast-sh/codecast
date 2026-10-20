// `cast line trial` (convex/lineTrial.ts): a trial project runs the whole flow
// for real and stops at the decision card. Its gates ask nobody; each becomes
// a trial card, answered on the trial review page (/trial in the app).
//
//   cast line trial [--project <ref>] [--json]            spend, then the cards
//   cast line trial on --project <ref> [--graph <file>]   make a project a trial
//   cast line trial off --project <ref>
//   cast line trial run <ct-N> [--graph <file>]           start a trial run (10 running at most)
//   cast line trial answer <tc-N> <key> [note]            answer a card (an agent: an earlier gate only)
//   cast line trial recard <tc-N> --file <card.json>      replace a waiting change card with a rebuilt one
//   cast line trial recard <tc-N> --proposal <file>       give a proposal gate its proposal card
//   cast line trial recard <tc-N> --judge-fix <file>      replace a waiting judge-fix card with its new measurement
//   cast line trial rebuild <tc-N>                         send a stale-base change card's run back to rebuild on main
//   cast line trial spend add <usd> <what...> --billed-by <key> [--force]   record money billed outside codecast (evals, shadow keys)
//   cast line trial spend rm <at>                          take back one outside entry
//   cast line trial runs [--failed]                        each problem's latest run
//   cast line trial rerun <ct-N>                           rerun a failed run (at its lost card when it died there)
//   cast line trial rerun <ct-N> --fresh                   start it again from main on today's line, wherever its run stands
//   cast line trial rerun <ct-N> --reask                   ask a waiting card again, or send its run back to work when its fix no longer answers the findings
//   cast line trial drop <ct-N> [-m note]                  the drop station: findings left keep the problem open and due; none closes it
//   cast line trial sweep [ct-N...] [--dry]                end runs waiting on closed problems; release closed problems' worktrees here (only the named ones')
//   cast line trial restart [--all] [--dry]                restart waiting runners whose stations or code changed
import path from "node:path";
import fs from "node:fs";
import type { Command } from "commander";
import { fmt } from "./colors.js";
import { apiPost, type PublishDeps } from "./castApi.js";
import { durationWords } from "@codecast/shared/contracts/moments";
import { execFileAsync } from "./proc.js";
import { currentOnly, SUPERSEDED_WORDS, type Superseded, type SupersededWhy } from "@codecast/shared/contracts/superseded";

function fail(message: string, code = 2): never {
  console.error(fmt.error(message));
  process.exit(code);
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const age = (ms: number) => durationWords(Math.max(0, Date.now() - ms));
const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);

/** A trial's spend (convex lineTrial.spend): billed money by what billed it, against the cap; then subscription use, which bills nothing, with its accounts' quota. */
export function spendLines(spend: any): string[] {
  const b = spend.billed;
  const m = b.model;
  const pct = (n: number | null) => (n == null ? "?" : `${Math.round(n)}%`);
  return [
    `  billed      ${usd(b.usd)}${spend.cap_usd != null ? ` of ${usd(spend.cap_usd)} cap` : ""}`,
    `    model calls  ${usd(m.usd)}  (${m.calls} calls: judging ${usd(m.by_purpose.judge)}, calls ${usd(m.by_purpose.call)}, grouping ${usd(m.by_purpose.grouping)}; team budget ${m.team_budget.month} ${usd(m.team_budget.spent_usd)} of ${usd(m.team_budget.cap_usd)}${m.team_budget.refused ? `, ${m.team_budget.refused} refused` : ""})`,
    ...b.keys.map((k: any) => `    ${k.billed_by}  ${usd(k.usd)}  (${k.entries} ${k.entries === 1 ? "entry" : "entries"})`),
    ...(b.run_sessions.sessions ? [`    run sessions on API keys  ${usd(b.run_sessions.usd)}  (${b.run_sessions.sessions} sessions, ${tokens(b.run_sessions.tokens)} tokens)`] : []),
    `  subscription  ${spend.runs} runs, ${spend.subscription.sessions} sessions, ${tokens(spend.subscription.tokens)} tokens${spend.subscription.unpriced_tokens ? ` (${tokens(spend.subscription.unpriced_tokens)} on unpriced models)` : ""}; API list price equivalent ${usd(spend.subscription.list_usd)}, not billed`,
    ...(spend.quota ?? []).map((q: any) => `    quota ${q.account} (${q.provider}, ${q.device})  ${q.windows.map((w: any) => `${w.label} ${pct(w.percent)}`).join(", ") || "no windows reported"}${q.fetched_at ? `  as of ${age(q.fetched_at)} ago` : ""}`),
  ];
}

export function registerLineTrialCommands(line: Command, deps: PublishDeps): void {
  const scope = async () => {
    const { scopeFor } = await import("./lineScope.js");
    const s: Record<string, unknown> = { ...(await scopeFor(deps, undefined, true)) };
    delete s.project;
    return s;
  };
  const post = async (route: string, body: Record<string, unknown>, read = false) => apiPost(deps, route, { ...(await scope()), ...body }, read ? { read: true } : undefined);

  // --project reads on `trial` or on its subcommand: commander hands it to whichever names it first.
  const projectOf = (opts: { project?: string }): string => opts.project ?? trial.opts().project ?? fail("--project <ref> is required");
  // --json too: `cast line trial runs --json` hands it to `trial`.
  const jsonOf = (opts: { json?: boolean }): boolean => !!(opts.json || trial.opts().json);
  const trial = line
    .command("trial")
    .description("Trial projects: the flow runs for real up to the decision card and stops; cards are answered on the trial review page")
    .option("--project <ref>", "One trial project")
    .option("--all", "Include superseded cards (replaced by later work, docs/architecture/line-versions.md)")
    .option("--json", "Machine-readable output")
    .action(async (options: { project?: string; json?: boolean; all?: boolean }) => {
      const projects: Array<{ title: string }> = options.project ? [{ title: options.project }] : await post("/cli/line/trial/projects", {}, true);
      const out = [];
      for (const p of projects) {
        const spend = await post("/cli/line/trial/spend", { project: p.title }, true);
        const every: Array<{ superseded?: Superseded }> = await post("/cli/line/trial/cards", { project: p.title }, true);
        const cards: any[] = currentOnly(every, !!options.all);
        out.push({ project: p.title, spend, cards, superseded: every.length - cards.length });
      }
      if (options.json) return console.log(JSON.stringify(options.project ? out[0] ?? null : out, null, 2));
      if (!out.length) return console.log("No trial projects. Make one with `cast line trial on --project <ref>`.");
      for (const { project, spend, cards, superseded } of out) {
        console.log(`${fmt.label(project)}  since ${new Date(spend.since).toISOString().slice(0, 10)}`);
        for (const l of spendLines(spend)) console.log(l);
        if (superseded) console.log(`  ${superseded} superseded card${superseded === 1 ? "" : "s"} hidden (--all shows them)`);
        if (!cards.length) { console.log("  No cards yet."); continue; }
        for (const c of cards) {
          const state = c.superseded ? `replaced: ${SUPERSEDED_WORDS[c.superseded.why as SupersededWhy]}` : c.status === "answered" ? `${c.answer.label}${c.answer.stand_in ? " (stand-in)" : ""}` : c.status;
          console.log(`  ${c.short_id}  ${c.kind === "card" ? "card    " : "proposal"}  ${state.padEnd(10)}  ${age(c.created_at).padEnd(8)}  ${c.task_short_id}  ${c.task_title.slice(0, 80)}`);
        }
      }
    });

  trial
    .command("on")
    .description("Make a project a trial: its gates ask nobody and nothing merges")
    .option("--project <ref>", "The project")
    .option("--graph <file>", "The trial graph `cast line trial run` starts; its checkout is where the run starts")
    .option("--judge-graph <file>", "The graph a problem of cases against a judge starts instead (the judge route)")
    .option("--judge-decides <role>", "The role whose decision a judge-route fix is (its handle, e.g. agent-quality): it hears it first and hands it up its own line, not to the trial's owner; none gives it back")
    .option("--json", "Machine-readable output")
    .action(async (opts: { project?: string; graph?: string; judgeGraph?: string; judgeDecides?: string; json?: boolean }) => {
      const options = { ...opts, project: projectOf(opts) };
      // A line graph runs from the directory above its line/ folder, as its script nodes expect.
      const located = (file: string) => {
        const graph = path.resolve(process.env.CODECAST_CWD || process.cwd(), file);
        if (!fs.existsSync(graph)) fail(`No graph at ${graph}`);
        return { graph, cwd: path.basename(path.dirname(graph)) === "line" ? path.dirname(path.dirname(graph)) : path.dirname(graph) };
      };
      const main = options.graph ? located(options.graph) : null;
      let judge: { graph: string; cwd: string; name: string } | null = null;
      if (options.judgeGraph) {
        const { parseWorkflowFile } = await import("./workflow/parser.js");
        const at = located(options.judgeGraph);
        judge = { ...at, name: parseWorkflowFile(at.graph).name };
      }
      const result = await post("/cli/line/trial/set", { project: options.project, on: true, ...(main ?? {}), ...(judge ? { judge } : {}), ...(options.judgeDecides ? { judge_decides: options.judgeDecides.replace(/^@/, "") } : {}) });
      if (options.json) return console.log(JSON.stringify(result, null, 2));
      console.log(`${result.project} is a trial project: its gates become trial cards and nothing merges.${result.graph ? `\n  runs start ${result.graph} from ${result.cwd}` : ""}${result.judge ? `\n  problems of cases against a judge start ${result.judge.graph}` : ""}${result.decider ? `\n  their decisions go to the ${result.decider}, not the trial's owner` : ""}`);
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
    .description("Start a trial run on one problem of a trial project, on this machine's daemon (10 running at most)")
    .option("--graph <file>", "A graph other than the project's trial graph")
    .option("--json", "Machine-readable output")
    .action(async (task: string, options: { graph?: string; json?: boolean }) => {
      const target = await post("/cli/line/trial/run-target", { task }, true);
      if (target.live_run) fail(`${target.task} already has a run (${target.live_run})`);
      if (target.running >= target.cap) fail(`${target.running} trial runs are running; the cap is ${target.cap}. Start this one when one finishes or pauses at a card.`);
      const graph = options.graph ? path.resolve(process.env.CODECAST_CWD || process.cwd(), options.graph) : target.graph;
      if (!graph) fail(`${target.project} has no trial graph: cast line trial on --project "${target.project}" --graph <file>`);
      if (options.graph && target.route === "judge") console.error(fmt.warning(`${target.task} holds cases against a judge; --graph overrides its judge route`));
      const cwd = options.graph ? (path.basename(path.dirname(graph)) === "line" ? path.dirname(path.dirname(graph)) : path.dirname(graph)) : target.cwd ?? path.dirname(graph);
      // Every run proves against unfixed code: an earlier run's branch is set aside (lineTrialBranch.ts).
      const [{ parseWorkflowFile }, { freshRunBranch, runHandsVia }] = await Promise.all([import("./workflow/parser.js"), import("./lineTrialBranch.js")]);
      const fresh = await freshRunBranch(cwd, parseWorkflowFile(graph), target.task, new Date(), runHandsVia(post)).catch((e) => fail(e.message));
      const { stdout } = await execFileAsync("cast", ["workflow", "run", graph, "--task", target.task, "--detach", "--json"], { cwd, encoding: "utf8", env: { ...process.env, CODECAST_CWD: cwd } } as any);
      const started = JSON.parse(String(stdout).slice(Math.max(0, String(stdout).search(/[[{]/))));
      if (options.json) return console.log(JSON.stringify({ ...started, graph, cwd, ...fresh }, null, 2));
      console.log(`Started a trial run on ${target.task} (${started.run_id}), ${target.running + 1} of ${target.cap} running, on ${fresh.branch} from ${fresh.base}${fresh.set_aside ? ` (the earlier run's branch is codecast/${fresh.set_aside})` : ""}. Its cards appear on the trial review page.`);
    });

  // The dispatcher (convex lineTrial.dispatch, every 10 minutes) starts the
  // problems most in need of a run; these turn it on and show what it would do.
  const dispatchProject = (opts: { project?: string }): string => opts.project ?? dispatch.opts().project ?? projectOf({});
  const printPass = (r: any) => {
    const tight = (r.quota ?? []).map((q: any) => `${q.account} ${q.percent == null ? "?" : Math.round(q.percent)}%`).join(", ");
    console.log(`${fmt.label(r.project)}  billed ${usd(r.billed_usd)} of ${usd(r.cap_usd)}${r.per_run_usd ? `, ~${usd(r.per_run_usd)} billed a run` : ""}${tight ? `, quota ${tight}` : ""}, ${r.running} of ${r.cap} running${r.max_runs != null ? `, ${r.runs} of ${r.max_runs} runs used` : ""}`);
    if (r.started.length) console.log(`  started ${r.started.join(", ")}`);
    if (r.gathering?.length) console.log(`  sent back to gather evidence before asking: ${r.gathering.join(", ")}`);
    if (r.ended?.length) console.log(`  ended, waiting on a closed problem: ${r.ended.join(", ")}`);
    if (r.held) console.log(`  held: ${r.held}`);
    const waiting = r.due.filter((d: any) => !r.started.includes(d.task));
    if (!waiting.length) return console.log("  Nothing else due.");
    for (const d of waiting) console.log(`  ${d.task.padEnd(9)} ${String(d.findings).padStart(3)} findings  sev ${String(d.severity).padStart(2)}  ${d.reopened ? `fix set aside at ${d.reopened}` : d.regrouped ? `regrouped since ${d.last_run} run` : "never run"}  ${d.title.slice(0, 70)}`);
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
    .description("The trial starts its own runs every 10 minutes while its billed money stays under --cap and its runs' subscription accounts have quota")
    .option("--project <ref>", "The trial project")
    .requiredOption("--cap <usd>", "Stop starting runs when the trial's billed money (model budget, spend added by hand, run sessions on API keys) would cross this; subscription sessions are held by quota instead")
    .option("--max-runs <n>", "Stop starting runs once the trial has this many line runs (every route, since it began)")
    .action(async (opts: { project?: string; cap: string; maxRuns?: string }) => {
      const r = await post("/cli/line/trial/dispatch-set", { project: dispatchProject(opts), cap_usd: Number(opts.cap), ...(opts.maxRuns !== undefined ? { max_runs: Number(opts.maxRuns) } : {}) });
      console.log(`${r.project} starts its own runs under ${usd(r.cap_usd)}${r.max_runs != null ? ` and up to ${r.max_runs} runs` : ""}.`);
    });
  dispatch
    .command("off")
    .description("The trial starts no runs of its own")
    .option("--project <ref>", "The trial project")
    .action(async (opts: { project?: string }) => {
      const r = await post("/cli/line/trial/dispatch-set", { project: dispatchProject(opts) });
      console.log(`${r.project} no longer starts its own runs.`);
    });

  const spend = trial
    .command("spend")
    .description("Money billed outside codecast's own accounting");
  spend
    .command("add <usd> <what...>")
    .description("Record money the trial was billed outside codecast (a shadow harness or evals on an API key): it joins the trial's billed money, which the dispatcher's cap reads. Subscription use (a dry run on a Claude login) bills nothing; do not record it. The same amount and words within an hour is refused as a repeat")
    .requiredOption("--billed-by <key>", "The key or account that billed it (\"evals key\", \"openrouter\")")
    .option("--project <ref>", "The trial project")
    .option("--force", "Record it although the same amount and words were recorded within the hour")
    .option("--json", "Machine-readable output")
    .action(async (amount: string, what: string[], opts: { project?: string; billedBy: string; force?: boolean; json?: boolean }) => {
      const value = Number(amount.replace(/^\$/, ""));
      if (!(value > 0)) fail(`${amount} is not a dollar amount`);
      const r = await post("/cli/line/trial/spend-add", { project: projectOf(opts), usd: value, what: what.join(" "), billed_by: opts.billedBy, ...(opts.force ? { force: true } : {}) });
      if (jsonOf(opts)) return console.log(JSON.stringify(r, null, 2));
      console.log(`${r.project}: +${usd(r.added_usd)} billed by ${r.billed_by} (${usd(r.key_usd)} on it in all); billed ${usd(r.billed_usd)}${r.cap_usd ? ` of the ${usd(r.cap_usd)} cap` : ""}.`);
    });
  spend
    .command("rm <at>")
    .description("Take back one outside entry (recorded twice, or wrong), named by its time (`at` in cast line trial --json, spend.outside)")
    .option("--project <ref>", "The trial project")
    .option("--json", "Machine-readable output")
    .action(async (at: string, opts: { project?: string; json?: boolean }) => {
      if (!/^\d+$/.test(at)) fail(`${at} is not an entry's time (a number of milliseconds)`);
      const r = await post("/cli/line/trial/spend-rm", { project: projectOf(opts), at: Number(at) });
      if (jsonOf(opts)) return console.log(JSON.stringify(r, null, 2));
      console.log(`${r.project}: -${usd(r.removed.usd)} "${r.removed.what}" (billed by ${r.removed.billed_by}); billed ${usd(r.billed_usd)}.`);
    });

  trial
    .command("runs")
    .description("Each trial problem's latest run; --failed lists the failed ones, with those that died waiting at their own card (a rerun picks up there)")
    .option("--project <ref>", "The trial project")
    .option("--failed", "Failed runs only")
    .option("--json", "Machine-readable output")
    .action(async (opts: { project?: string; failed?: boolean; json?: boolean }) => {
      const rows: any[] = (await post("/cli/line/trial/runs", { project: projectOf(opts) }, true)).filter((r: any) => !opts.failed || r.status === "failed");
      if (jsonOf(opts)) return console.log(JSON.stringify(rows, null, 2));
      if (!rows.length) return console.log(opts.failed ? "No failed runs." : "No runs.");
      for (const r of rows) {
        const why = r.lost_at_gate ? `lost at ${r.lost_at_gate.card} (${r.lost_at_gate.node}): a rerun picks up there` : r.fail_reason ?? r.node ?? "";
        console.log(`  ${r.task.padEnd(9)} ${r.status.padEnd(9)} ${age(r.updated_at).padEnd(8)} ${why.slice(0, 90)}  ${r.title.slice(0, 60)}`);
      }
    });

  trial
    .command("rerun <task>")
    .description("Run a failed or stopped trial problem again (the review page's Rerun): one that died waiting at its own card picks up at that card; any other starts fresh from main. Under the dispatcher's billed-money cap, its accounts' quota and its run limit")
    .option("--reask", "A run waiting at a card: stop its runner here and ask that card again on the stations as they are now. A change card whose fix no longer answers its problem's findings is not worded again: with the findings changed and under half reached the run reads the problem again and works on; with none reached it ends and the problem is due a run from main")
    .option("--at <node>", "With --reask, pick the run up at this station whatever its findings (a gate the graph no longer has resumes at the station after it)")
    .option("--fresh", "Start the problem again from main on the line as it is now, wherever its run stands: the run ends and its fix is set aside on its branch")
    .option("--json", "Machine-readable output")
    .action(async (task: string, opts: { json?: boolean; reask?: boolean; at?: string; fresh?: boolean }) => {
      if (opts.at && !opts.reask) fail("--at goes with --reask");
      if (opts.fresh && opts.reask) fail("--fresh starts from main; --reask picks the run up where it stands");
      let asker: string | undefined;
      let entry: string | undefined;
      if (opts.reask || opts.fresh) {
        const projects: Array<{ title: string }> = trial.opts().project ? [{ title: trial.opts().project }] : await post("/cli/line/trial/projects", {}, true);
        let row: { task: string; run_id: string } | undefined;
        for (const p of projects) row ??= ((await post("/cli/line/trial/runs", { project: p.title }, true)) as Array<{ task: string; run_id: string }>).find((r) => r.task === task);
        if (!row) fail(`${task} has no trial run`);
        const { prepareReask, stopRunner } = await import("./workflow/reask.js");
        // A gate its station asks (`asker=`) is asked again by that station, on the graph as it is now.
        if (opts.reask) ({ asker, entry } = await prepareReask(deps, row.run_id, task, opts.at).catch((e) => fail(e.message)));
        else await stopRunner(row.run_id, task).catch((e) => fail(e.message));
      }
      const r = await post("/cli/line/trial/rerun", { task, ...(opts.reask ? { reask: true } : {}), ...(opts.fresh ? { fresh: true } : {}), ...(opts.at ? { at: opts.at } : {}), ...(asker ? { asker } : {}), ...(entry ? { entry } : {}) });
      if (jsonOf(opts)) return console.log(JSON.stringify(r, null, 2));
      if (r.rebuild === "main") return console.log(`${r.task}: not asked again: ${r.why}. Its run ended, its branch is set aside, and the problem is due a new run from main (cast line trial dispatch --dry).`);
      if (r.rebuild === "investigate") return console.log(`${r.task}: not asked again: ${r.why}. Its run reads the problem again at ${r.resumed_at} and works on from there (run ${r.run_id}).`);
      console.log(r.resumed_at ? `${r.task}: picks up at ${r.resumed_at} with what it already made (run ${r.run_id}).` : `${r.task}: rerun from main (run ${r.run_id}).`);
    });

  trial
    .command("restart [tasks...]")
    .description("Restart the runners of trial runs waiting at a card when their graph files or the runner's code changed since they started: each waits at the same card again, on current code (the daemon resumes it within 2 minutes). Naming problems restarts only theirs")
    .option("--project <ref>", "The trial project")
    .option("--all", "Every waiting run's runner on this machine, changed or not")
    .option("--dry", "Name the runners it would restart")
    .option("--json", "Machine-readable output")
    .action(async (tasks: string[], opts: { project?: string; all?: boolean; dry?: boolean; json?: boolean }) => {
      const waiting: Array<{ task: string; run_id: string; status: string; node: string | null }> = (await post("/cli/line/trial/runs", { project: projectOf(opts) }, true)).filter((r: any) => r.status === "paused" && (!tasks.length || tasks.includes(r.task)));
      const { liveRunnerPid, runnerPidFile, runnerCodeFiles } = await import("./workflow/runResume.js");
      const { graphForDaemonRun } = await import("./workflow/daemonGraph.js");
      const { deviceId } = await import("./remote/device.js");
      const newest = (files: string[]) => Math.max(0, ...files.map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }));
      const code = newest(runnerCodeFiles());
      const out: Array<{ task: string; node: string | null; run_id: string; pid: number | null; started: number | null; changed: number; restarted: boolean; why: string }> = [];
      for (const { run_id: runId, task, node } of waiting) {
        const pid = liveRunnerPid(runId);
        let started: number | null = null;
        try { started = Number(JSON.parse(fs.readFileSync(runnerPidFile(runId), "utf-8")).at) || null; } catch {}
        const got = await apiPost(deps, "/cli/workflow-runs/get", { run_id: runId }, { read: true, exitOnError: false }).catch(() => null);
        const graph = got?.run ? graphForDaemonRun(got.run, got.workflow, got.run.project_path || process.cwd(), deviceId(), true) : null;
        const changed = Math.max(code, newest(graph?.sources ?? []));
        const stale = !!pid && (opts.all || !started || changed > started);
        const why = !pid ? "no runner on this machine" : stale ? (opts.all ? "restart asked" : "changed since it started") : "current";
        if (stale && !opts.dry) {
          process.kill(pid!, "SIGTERM");
          for (let i = 0; i < 50 && liveRunnerPid(runId); i++) await new Promise((r) => setTimeout(r, 100));
        }
        out.push({ task, node, run_id: runId, pid, started, changed, restarted: stale && !opts.dry && !liveRunnerPid(runId), why });
      }
      if (jsonOf(opts)) return console.log(JSON.stringify(out, null, 2));
      for (const r of out) console.log(`  ${r.task.padEnd(9)} ${(r.node ?? "").padEnd(14)} ${r.restarted ? "restarted" : opts.dry && r.why === "changed since it started" ? "would restart" : r.why}`);
      const n = out.filter((r) => r.restarted).length;
      if (n) console.log(`${n} runner${n === 1 ? "" : "s"} stopped; this machine's daemon resumes each at its card within 2 minutes, on current code.`);
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
    .command("drop <task>")
    .description("The trial graph's drop station: the fix was rejected at the card. A problem that still holds findings stays open and is due a new run from main; one that holds none closes as dropped")
    .option("-m, --message <text>", "The note the person left with the answer", "")
    .option("--json", "Machine-readable output")
    .action(async (task: string, opts: { message: string; json?: boolean }) => {
      const r = await post("/cli/line/trial/drop", { task, ...(opts.message.trim() ? { note: opts.message.trim() } : {}) });
      if (jsonOf(opts)) return console.log(JSON.stringify(r));
      console.log(r.closed ? `${r.task}: ${r.status}; it holds no findings.` : `${r.task}: the fix is dropped and the problem stays open: ${r.findings} finding${r.findings === 1 ? "" : "s"} in ${r.conversations} conversation${r.conversations === 1 ? "" : "s"}, due a new run from main.`);
    });

  trial
    .command("sweep [tasks...]")
    .description("End the runs still waiting at a gate on a closed problem (merged away or dropped), close the cards still waiting on closed problems and withdraw their questions, and release the worktrees of closed problems' ended runs on this machine (each branch stays; uncommitted work is committed onto it first). Naming problems closes and releases only theirs")
    .option("--project <ref>", "The trial project")
    .option("--dry", "Name what it would end and release")
    .option("--json", "Machine-readable output")
    .action(async (only: string[], opts: { project?: string; dry?: boolean; json?: boolean }) => {
      const r: { project: string; ended: string[]; cards_closed?: string[]; closed: Array<{ task: string; status: string; run_id: string; run_status: string; workflow_name: string; project_path: string | null; runner_device: string | null }> } =
        await post("/cli/line/trial/sweep", { project: projectOf(opts), ...(opts.dry ? { dry: true } : {}), ...(only.length ? { only } : {}) });
      const [{ liveRunnerPid }, { releaseRunWorktree, runHandsVia }, { deviceId }] = await Promise.all([import("./workflow/runResume.js"), import("./lineTrialBranch.js"), import("./remote/device.js")]);
      const released: Array<{ task: string; slug: string; committed: boolean }> = [];
      for (const c of r.closed) {
        const here = c.runner_device === deviceId() && !!c.project_path && fs.existsSync(c.project_path);
        const over = c.run_status === "failed" || c.run_status === "completed" || (opts.dry && r.ended.includes(c.task));
        if (!here || !over || (only.length && !only.includes(c.task))) continue;
        // A runner that still holds the run (it has not read the cancel yet) is stopped before its worktree goes.
        const pid = liveRunnerPid(c.run_id);
        if (pid && !opts.dry) {
          process.kill(pid, "SIGTERM");
          for (let i = 0; i < 50 && liveRunnerPid(c.run_id); i++) await new Promise((res) => setTimeout(res, 100));
        }
        const done = await releaseRunWorktree(c.project_path!, { name: c.workflow_name }, c.task, !!opts.dry, runHandsVia(post))
          .catch((e) => { console.error(`${c.task}: ${e.message}`); return null; });
        if (done) released.push({ task: c.task, ...done });
      }
      const cards = r.cards_closed ?? [];
      if (jsonOf(opts)) return console.log(JSON.stringify({ project: r.project, ended: r.ended, cards_closed: cards, released }, null, 2));
      const verb = opts.dry ? "would end" : "ended";
      console.log(r.ended.length ? `${verb} ${r.ended.length} run${r.ended.length === 1 ? "" : "s"} waiting on a closed problem: ${r.ended.join(", ")}` : "No run waits on a closed problem.");
      if (cards.length) console.log(`${opts.dry ? "would close" : "closed"} ${cards.length} card${cards.length === 1 ? "" : "s"} still waiting on a closed problem: ${cards.join(", ")}`);
      console.log(released.length ? `${opts.dry ? "would release" : "released"} ${released.length} worktree${released.length === 1 ? "" : "s"}: ${released.map((x) => x.slug).join(", ")}` : "No closed problem's worktree is checked out here.");
    });

  trial
    .command("rebuild <card>")
    .description("Send a waiting change card whose branch is stale against main back to the line's fresh station: rebased and proven again, or rebuilt with the clashes named; it reads Rebuilding until its next card")
    .option("--from <station>", "verify: the branch is already on main and only needs proving again (default: fresh)")
    .option("--json", "Machine-readable output")
    .action(async (card: string, options: { json?: boolean; from?: string }) => {
      // The runner still waiting on the card's gate is stopped first: it would read the run leaving the gate as a refused answer.
      const projects: Array<{ title: string }> = await post("/cli/line/trial/projects", {}, true);
      let runId: string | undefined;
      for (const p of projects) {
        const cards: Array<{ short_id: string; run_id: string }> = await post("/cli/line/trial/cards", { project: p.title }, true);
        runId = cards.find((c) => c.short_id === card)?.run_id ?? runId;
      }
      if (!runId) fail(`No trial card ${card}`);
      const { liveRunnerPid } = await import("./workflow/runResume.js");
      const pid = liveRunnerPid(runId);
      if (pid) {
        process.kill(pid, "SIGTERM");
        for (let i = 0; i < 50 && liveRunnerPid(runId); i++) await new Promise((r) => setTimeout(r, 100));
        if (liveRunnerPid(runId)) fail(`The runner waiting on ${card} (pid ${pid}) did not stop`);
      }
      const result = await post("/cli/line/trial/rebuild", { card, ...(options.from ? { from: options.from } : {}) });
      if (options.json) return console.log(JSON.stringify({ ...result, stopped_runner: pid ?? null }, null, 2));
      console.log(`${result.short_id}: rebuilding on main (${result.stale}). Its run resumes at Up to date on its machine.`);
    });

  trial
    .command("recard <card>")
    .description("Replace a waiting change card with one rebuilt by cast card build (the run keeps waiting on the same gate), or give a proposal gate its proposal card")
    .option("--file <card.json>", "The rebuilt change card")
    .option("--proposal <proposal.json>", "A proposal gate's card (cast card proposal)")
    .option("--judge-fix <judge-fix.json>", "A judge-route card measured again (cast line judges ab)")
    .option("--graph <file>", "Take the card's answers from this graph's gate edges (decide, or proposal_gate with --proposal; same keys)")
    .option("--json", "Machine-readable output")
    .action(async (card: string, options: { file?: string; proposal?: string; judgeFix?: string; graph?: string; json?: boolean }) => {
      const file = options.file ?? options.proposal ?? options.judgeFix ?? fail("--file <card.json>, --proposal <proposal.json> or --judge-fix <judge-fix.json> is required");
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
      const result = await post("/cli/line/trial/recard", { card, ...(options.proposal ? { proposal: parsed } : options.judgeFix ? { judge_fix: parsed } : { change_card: parsed }), ...(gateOptions ? { options: gateOptions } : {}) });
      if (options.json) return console.log(JSON.stringify(result, null, 2));
      console.log(`${result.short_id}: ${result.headline} (${result.checks.join(", ")})`);
    });
}
