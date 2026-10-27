// A flow's working commands (docs/architecture/flows.md FL0): the merge step the
// shipped steps run, the fix trace, deploys, replays, and the repo's profile,
// moments, trials, dissolves and judges. `cast flow` carries them
// (flowCommand.ts); `cast line` is their older name, hidden, with the same
// subcommands and output. Command groups (commandGroups.ts), so none of it
// loads for any other command.

import type { Command } from "commander";
import { cliErrorMessage } from "@codecast/shared/contracts";
import { apiPost } from "./castApi.js";
import { commandGroup, type GroupDeps } from "./commandGroups.js";
import { registerLineProfileCommands } from "./lineProfileCommand.js";
import { registerMomentsCommands } from "./momentsCommand.js";
import { registerReviewsCommands } from "./agentReviewsCommand.js";
import { registerLineTrialCommands } from "./lineTrialCommand.js";
import { registerLineDissolveCommand } from "./lineDissolveCommand.js";
import { registerJudgingCommands } from "./judgingCommand.js";

export function registerLineCommand(program: Command, deps: GroupDeps): void {
  const line = program.command("line", { hidden: true }).description(commandGroup("line").description);
  registerLineSubcommands(line, deps);
}

/** Every working subcommand of a flow, under `parent` (`cast flow`, or `cast line`). */
export function registerLineSubcommands(line: Command, deps: GroupDeps): void {
  // The merge step (L12), run by the shipped steps' merge node.
  line
    .command("fixloop")
    .description("Trace each fix commit to the commit, session, flow run and role that introduced the lines it changed (SZZ: parent-revision blame)")
    .option("--since <window>", "How far back to look for fix commits (git --since)", "7d")
    .option("--cwd <path>", "The repository checkout (default: the current directory)")
    .option("--json", "Machine-readable output")
    .action(async (options: any) => {
      const { traceFixes, formatFixloop, rollupByRole } = await import("./lineFixloop.js");
      const { readAuthConfig } = await import("./config/readAuthConfig.js");
      const { defaultConfigDir } = await import("./config/configDir.js");
      const since = /^\d+d$/.test(options.since) ? `${options.since.slice(0, -1)} days ago` : options.since;
      const traces = await traceFixes({ cwd: options.cwd || process.cwd(), since, config: (readAuthConfig(defaultConfigDir()) ?? {}) as any });
      if (options.json) console.log(JSON.stringify({ since: options.since, traces, by_role: rollupByRole(traces) }, null, 2));
      else console.log(formatFixloop(traces));
    });
  // A problem whose run failed or was cancelled, back in the line's queue (the-line-end-to-end.md LE6).
  line
    .command("requeue <tasks...>")
    .description("Put problems whose run failed or was cancelled back in the line's queue: open, unblocked, with no run, so the sweep starts each in rank order on a machine with a free slot (cast workflow resume continues a run on its own branch instead)")
    .option("--json", "Machine-readable output")
    .action(async (tasks: string[], options: { json?: boolean }) => {
      const out: Array<{ task: string; queued?: string; error?: string }> = [];
      for (const task of tasks) {
        try {
          out.push(await apiPost(deps, "/cli/line/requeue", { task }, { exitOnError: false, describeError: cliErrorMessage }));
        } catch (e) {
          out.push({ task, error: (e as Error).message });
        }
      }
      if (options.json) console.log(JSON.stringify(out, null, 2));
      else for (const r of out) console.log(r.error ? `${r.task}: ${r.error}` : r.queued);
      if (out.some((r) => r.error)) process.exitCode = 1;
    });
  line
    .command("merge")
    .description("Merge an approved run's branch into the default branch when the role's flow allows it (the Standard steps' merge node)")
    .requiredOption("--run <id>", "The workflow run")
    .requiredOption("--branch <name>", "The branch the implementer pushed")
    .option("--into <branch>", "The default branch (default: origin HEAD, else main)")
    .option("--cwd <path>", "The repository checkout (default: the current directory)")
    .option("--task <ct-N>", "The run's task: a merge left to a person is said there as a blocker")
    .option("--json", "Machine-readable output")
    .action(async (options: any) => {
      const { runMergeStep, defaultExec } = await import("./lineMerge.js");
      const cwd = options.cwd || process.cwd();
      const head = defaultExec("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
      const into = options.into || (head.status === 0 ? head.stdout.trim().replace(/^origin\//, "") : "main");
      // Throwing, never exiting: a server that refuses or cannot be read is a
      // merge left to a person (exit 0), not a failed station.
      const post = (path: string, body: Record<string, unknown>) => apiPost(deps, path, body, { exitOnError: false, describeError: cliErrorMessage });
      const result = await runMergeStep({ cwd, run_id: options.run, branch: options.branch, into, task: options.task || undefined, post, log: (l) => { if (!options.json) console.log(l); } });
      if (options.json) console.log(JSON.stringify(result, null, 2));
    });

  // The deploy stage (deploys.md DP2): the shipped fixes waiting to go out, sent together in one deploy.
  const deploy = line
    .command("deploy")
    .description("The flow's deploy stage: the shipped fixes no live deploy has carried yet; --go sends them together through [line.deploy] command and records the deploy (dp-N)")
    .option("--project <ref>", "The project (default: the repo profile's [line] project)")
    .option("--go", "Ask for the deploy and run the deploy path here")
    .option("--json", "Machine-readable output")
    .action(async (options: any) => {
      const { formatStage, runDeployGraph } = await import("./lineDeploy.js");
      const { lineProjectFor, scopeFor } = await import("./lineScope.js");
      const { loadLineProfile } = await import("./lineProfile.js");
      const root = process.env.CODECAST_CWD || process.cwd();
      const project = lineProjectFor(undefined, options.project);
      if (!project) { console.error("No project: pass --project, or set [line] project in .codecast/line.toml"); process.exit(1); }
      const scope: any = await scopeFor(deps, undefined, false, project);
      const ref = { project_id: project, ...(scope.team_id ? { team_id: scope.team_id } : {}) };
      const stage = await apiPost(deps, "/cli/line/deploy/stage", ref, { read: true });
      if (!options.go) {
        console.log(options.json ? JSON.stringify(stage, null, 2) : formatStage(stage));
        return;
      }
      // The command that runs is this checkout's: the file is the authority, the published copy only a mirror of it.
      const { profile, root: profileRoot } = loadLineProfile(root);
      const command = profile.deploy?.command;
      if (!command) { console.error("No [line.deploy] command in this checkout's .codecast/line.toml"); process.exit(1); }
      const asked = await apiPost(deps, "/cli/line/deploy/request", { ...ref, here: true });
      console.log(`${asked.short_id}: sending ${asked.carries} fix${asked.carries === 1 ? "" : "es"}`);
      const code = runDeployGraph(asked.short_id, profileRoot ?? root);
      const after = await apiPost(deps, "/cli/deploys/get", { ref: asked.short_id }, { read: true });
      console.log(`${asked.short_id}: ${after?.status ?? "unknown"}${after?.sha ? ` at ${String(after.sha).slice(0, 10)}` : ""}`);
      if (after?.status !== "live") process.exit(code || 1);
    });
  deploy
    .command("show")
    .description("One deploy (dp-N): what went out, who started it, what it carried and what happened after")
    .argument("<deploy>", "The deploy (dp-N)")
    .option("--json", "Machine-readable output")
    .action(async (ref: string, options: any) => {
      const { formatDeploy } = await import("./lineDeploy.js");
      const d = await apiPost(deps, "/cli/deploys/get", { ref }, { read: true });
      if (!d) { console.error(`No deploy ${ref} you can read`); process.exit(1); }
      console.log(options.json ? JSON.stringify(d, null, 2) : formatDeploy(d));
    });
  deploy
    .command("run")
    .description("Run a deploy that was asked for (dp-N) through its steps, each a station of the line-deploy graph, in this checkout; the daemon's line_deploy runs this")
    .argument("<deploy>", "The deploy (dp-N)")
    .action(async (ref: string) => {
      const { loadLineProfile } = await import("./lineProfile.js");
      const { runDeployGraph } = await import("./lineDeploy.js");
      const root = process.env.CODECAST_CWD || process.cwd();
      const { profile, root: profileRoot } = loadLineProfile(root);
      const post = (path: string, body: Record<string, unknown>) => apiPost(deps, path, body);
      if (!profile.deploy?.command) {
        await post("/cli/line/deploy/report", { deploy: ref, status: "failed", note: "No [line.deploy] command in the checkout that publishes this line" });
        console.error("No [line.deploy] command in this checkout's .codecast/line.toml");
        process.exit(1);
      }
      const d = await apiPost(deps, "/cli/deploys/get", { ref }, { read: true });
      if (!d) { console.error(`No deploy ${ref}`); process.exit(1); }
      if (d.status !== "requested") { console.log(`${ref} is ${d.status}; nothing to run`); return; }
      const code = runDeployGraph(ref, profileRoot ?? root);
      const after = await apiPost(deps, "/cli/deploys/get", { ref }, { read: true });
      console.log(`${ref}: ${after?.status ?? "unknown"}`);
      if (after?.status !== "live") process.exit(code || 1);
    });
  deploy
    .command("step")
    .description("Run one step of a deploy (ci, send, gate, rollout, live) through this checkout's [line.deploy] command for it; a station of the line-deploy graph")
    .argument("<step>", "ci, send, gate, rollout or live")
    .argument("<deploy>", "The deploy (dp-N)")
    .option("--run <id>", "The line-deploy run carrying it")
    .action(async (step: string, ref: string, options: any) => {
      const { runDeployStep } = await import("./lineDeploy.js");
      const { LINE_DEPLOY_STEPS } = await import("@codecast/shared/contracts/lineDeploy");
      const { loadLineProfile } = await import("./lineProfile.js");
      if (!(LINE_DEPLOY_STEPS as readonly string[]).includes(step)) { console.error(`A deploy's steps are ${LINE_DEPLOY_STEPS.join(", ")}`); process.exit(2); }
      const root = process.env.CODECAST_CWD || process.cwd();
      const { profile, root: profileRoot } = loadLineProfile(root);
      const r = await runDeployStep({
        step: step as any, deploy: ref, root: profileRoot ?? root, profile: profile.deploy, runId: options.run || undefined,
        read: (d) => apiPost(deps, "/cli/deploys/get", { ref: d }, { read: true }),
        post: (path, body) => apiPost(deps, path, body),
      });
      // The command's own output is the station's output already; only the exit is said again.
      if (r.code !== 0) { console.error(r.note?.startsWith("exited") ? `exited ${r.code}` : r.note ?? `exited ${r.code}`); process.exit(r.code); }
    });
  deploy
    .command("watch")
    .description("The deploy is live: report it, and watch its shipped fixes for the profile's watch days from now (the line-deploy graph's last station)")
    .argument("<deploy>", "The deploy (dp-N)")
    .action(async (ref: string) => {
      const { watchDeploy } = await import("./lineDeploy.js");
      const { loadLineProfile } = await import("./lineProfile.js");
      const { profile } = loadLineProfile(process.env.CODECAST_CWD || process.cwd());
      console.log(await watchDeploy({ deploy: ref, watchDays: profile.watch_days, read: (d) => apiPost(deps, "/cli/deploys/get", { ref: d }, { read: true }), post: (path, body) => apiPost(deps, path, body) }));
    });
  deploy
    .command("return")
    .description("A deploy step failed: mark the deploy failed and file the failure as a finding in the project's flow, one problem per target and step (the line-deploy graph's Returned station)")
    .argument("<deploy>", "The deploy (dp-N)")
    .option("--run <id>", "The line-deploy run, to name the step that failed")
    .option("--note <text>", "What the step said")
    .action(async (ref: string, options: any) => {
      const { returnDeploy } = await import("./lineDeploy.js");
      const { scopeFor } = await import("./lineScope.js");
      const read = (d: string) => apiPost(deps, "/cli/deploys/get", { ref: d }, { read: true });
      const d = await read(ref);
      const scope: any = await scopeFor(deps, undefined, true, d?.project_id ?? undefined);
      const { conversation_id: _c, project_path: _p, ...where } = scope ?? {};
      const r = await returnDeploy({
        deploy: ref, runId: options.run || undefined, note: options.note, scope: where, read,
        readRun: (id) => apiPost(deps, "/cli/workflow-runs/get", { run_id: id }, { read: true }),
        post: (path, body) => apiPost(deps, path, body),
      });
      const { LINE_DEPLOY_STEP_LABELS } = await import("@codecast/shared/contracts/lineDeploy");
      console.log(`${ref} stopped at ${r.step ? LINE_DEPLOY_STEP_LABELS[r.step] : "a step"}; ${r.signal?.task_short_id ? `the line has it as ${r.signal.task_short_id}` : `filed as ${r.signal?.short_id ?? "a finding"}`}`);
    });
  deploy
    .command("follow")
    .description("Wait for jobs of the deploy path's GitHub Actions run (the one the send step named) and pass when they pass; for a path whose gate and rollout are jobs of one run")
    .requiredOption("--jobs <names>", "Comma-separated job names, e.g. gate,evals")
    .option("--url <url>", "The run (default: CAST_DEPLOY_URL, which the step sets)")
    .action(async (options: any) => {
      const { followJobs } = await import("./lineDeploy.js");
      const jobs = String(options.jobs).split(",").map((j) => j.trim()).filter(Boolean);
      process.exit(await followJobs({ url: options.url || process.env.CAST_DEPLOY_URL, jobs }));
    });
  deploy
    .command("ci")
    .description("Wait for CI's verdict on the deploy sha (CAST_DEPLOY_SHA, which the step sets): pass when green, fail when red")
    .option("--workflow <file>", "The workflow whose newest finished run on the sha decides (default: every check run on it)")
    .option("--sha <sha>", "The commit (default: CAST_DEPLOY_SHA)")
    .option("--repo <owner/name>", "The repository (default: this checkout's)")
    .action(async (options: any) => {
      const { waitForCi } = await import("./lineDeploy.js");
      const sha = options.sha || process.env.CAST_DEPLOY_SHA;
      if (!sha) { console.error("No sha: pass --sha, or run this as a deploy step"); process.exit(2); }
      process.exit(await waitForCi({ sha, workflow: options.workflow, repo: options.repo }));
    });

  // A station measured on frozen past cases before an edit reaches a run (learning-loop.md LL14).
  line
    .command("replay")
    .description("Replay one station of a flow's steps on past runs this machine holds, on the graph's files at a revision and as they are on disk, in the dry-run sandbox (nothing written, no connection but the model's); each case passes on its pinned fields or a blind yes/no grade")
    .argument("<graph>", "The .cast file, from the directory its runs start in")
    .argument("<station>", "The station's id")
    .argument("[runs...]", "Runs to replay (default: the station's cases in cases.json beside the graph)")
    .option("--cases <file>", "Frozen cases: { \"<station>\": [{ \"run\", \"expect\": { \"<field>\": \"<value>\" | [...] }, \"grade\": \"<yes/no question>\", \"why\" }] }")
    .option("--base <rev>", "The other arm: the graph's directory at this git revision, or disk for the files as they are (against --try); none replays the work arm alone", "HEAD")
    .option("--try <dir>", "Edited files laid over the graph's directory for the work arm (same layout), so an edit is measured before the line runs it")
    .option("--reps <n>", "Replays of each case on each arm", (v) => parseInt(v, 10), 1)
    .option("--grade <question>", "A yes/no question asked of every replay (a case's own grade otherwise)")
    .option("--expect <field=value>", "A pinned field every replay must hold (repeat for more)", (v: string, all: string[]) => [...all, v], [] as string[])
    .option("--concurrency <n>", "Replays at once (each is a whole agent turn)", (v) => parseInt(v, 10), 2)
    .option("--as-of", "Serve each case's own problem page (cast task show) as it stood before its run closed it: open, with its history and comments cut")
    .option("--db <file:VAR>", "A read-only database the stations may query: the env file (from the repository root) and the variable holding its URL; the replay's checkout gets only that one, and the real env files are hidden")
    .option("--account <profile>", "The saved Claude account the replays run on (cast accounts); default: this machine's login, which may be another account's spent week")
    .option("--json", "Machine-readable output")
    .action(async (graph: string, station: string, runs: string[], options: any) => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { runReplay, replayDeps, replayOutDir } = await import("./lineReplay.js");
      const root = process.cwd();
      const castAbs = path.resolve(root, graph);
      if (!fs.existsSync(castAbs)) { console.error(`No graph at ${castAbs}`); process.exit(1); }
      const casesFile = options.cases ? path.resolve(options.cases) : path.join(path.dirname(castAbs), path.basename(castAbs, ".cast"), "cases.json");
      const frozen = fs.existsSync(casesFile) ? (JSON.parse(fs.readFileSync(casesFile, "utf8"))[station] ?? []) : [];
      const extra = Object.fromEntries((options.expect as string[]).map((e) => { const [k, ...v] = e.split("="); return [k, v.join("=")]; }));
      const cases = (runs.length ? runs.map((run) => frozen.find((c: any) => c.run === run) ?? { run }) : frozen)
        .map((c: any) => ({ ...c, ...(Object.keys(extra).length ? { expect: { ...c.expect, ...extra } } : {}), ...(options.grade ? { grade: options.grade } : {}) }));
      if (!cases.length) { console.error(`No cases for ${station}: name runs, or list them under "${station}" in ${casesFile}`); process.exit(1); }
      if (cases.some((c: any) => !c.expect && !c.grade)) { console.error("Every case needs an expect or a grade to pass on (--expect field=value, --grade \"<question>\")"); process.exit(1); }
      const out = replayOutDir(station);
      fs.mkdirSync(out, { recursive: true });
      const base = options.base === "none" ? null : options.base;
      const work = options.try ? `the files on disk with ${options.try} over them` : "the files on disk";
      if (!options.json) console.log(`Replaying ${station} on ${cases.length} case${cases.length === 1 ? "" : "s"} x ${options.reps} on ${base ? `${base} and ${work}` : work}, into ${out}`);
      const overlay = options.try ? path.resolve(options.try) : undefined;
      const db = options.db ? { file: String(options.db).slice(0, String(options.db).lastIndexOf(":")), key: String(options.db).slice(String(options.db).lastIndexOf(":") + 1) } : undefined;
      const { tally, p } = await runReplay({ root, cast: graph, station, cases, base, overlay, db, asOf: !!options.asOf, reps: options.reps, out, concurrency: options.concurrency, ...(options.account ? { account: String(options.account) } : {}), log: options.json ? undefined : (l) => console.log(`  ${l}`) }, replayDeps());
      if (options.json) { console.log(JSON.stringify({ out, tally, p }, null, 2)); return; }
      const row = (arm: "base" | "work", label: string) => `  ${label}: ${tally[arm].pass}/${tally[arm].n} pass${tally[arm].failed ? `, ${tally[arm].failed} did not run` : ""}, $${tally[arm].cost_usd.toFixed(2)}`;
      if (base) console.log(row("base", base));
      console.log(row("work", options.try ? "with the edits" : "on disk"));
      if (base) console.log(`  ${p === null ? "no difference" : p < 0.05 ? `separated: better (p=${p.toFixed(3)})` : `not separated (p=${p.toFixed(3)})`}`);
    });

  // The repo's line profile and the eval station's builder (line-profile.md LP2, LP4).
  registerLineProfileCommands(line, deps);
  // Bringing moments and the team's model budget (learning-loop.md LL7, LL10).
  registerMomentsCommands(line, deps);
  registerReviewsCommands(line, deps);
  registerLineTrialCommands(line, deps);
  // A dissolved problem's close by what it argued (learning-loop.md LL13).
  registerLineDissolveCommand(line, deps);
  // Setting up and improving a project's judges (learning-loop.md LL4).
  registerJudgingCommands(line, deps);
}
