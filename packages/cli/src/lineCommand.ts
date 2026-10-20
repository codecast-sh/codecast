// `cast line` (docs/architecture/the-line.md): the merge step the shipped line
// runs, the fix trace, and the repo's line profile, moments, trials, dissolves
// and judges. A command group (commandGroups.ts), so none of it loads for any
// other command.

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
  // The merge step (L12), run by the shipped line's merge node.
  const line = program.command("line").description(commandGroup("line").description);
  line
    .command("fixloop")
    .description("Trace each fix commit to the commit, session, line run and role that introduced the lines it changed (SZZ: parent-revision blame)")
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
  line
    .command("merge")
    .description("Merge an approved run's branch into the default branch when the role's line allows it (the shipped line's merge node)")
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
    .description("The line's deploy stage: the shipped fixes no live deploy has carried yet; --go sends them together through [line.deploy] command and records the deploy (dp-N)")
    .option("--project <ref>", "The project (default: the repo profile's [line] project)")
    .option("--go", "Ask for the deploy and run the deploy path here")
    .option("--json", "Machine-readable output")
    .action(async (options: any) => {
      const { formatStage, runDeploy } = await import("./lineDeploy.js");
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
      const result = await runDeploy({ root: profileRoot ?? root, deploy: asked.short_id, command, actor: process.env.USER ?? "cast", post: (path, body) => apiPost(deps, path, body) });
      console.log(`${asked.short_id}: ${result.status}${result.sha ? ` at ${result.sha.slice(0, 10)}` : ""}`);
      if (result.status !== "live") process.exit(1);
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
    .description("Run a deploy the Line page asked for (dp-N) through this checkout's [line.deploy] command; the daemon's line_deploy runs this")
    .argument("<deploy>", "The deploy (dp-N)")
    .action(async (ref: string) => {
      const { runDeploy } = await import("./lineDeploy.js");
      const { loadLineProfile } = await import("./lineProfile.js");
      const root = process.env.CODECAST_CWD || process.cwd();
      const { profile, root: profileRoot } = loadLineProfile(root);
      const command = profile.deploy?.command;
      const post = (path: string, body: Record<string, unknown>) => apiPost(deps, path, body);
      if (!command) {
        await post("/cli/line/deploy/report", { deploy: ref, status: "failed", note: "No [line.deploy] command in the checkout that publishes this line" });
        console.error("No [line.deploy] command in this checkout's .codecast/line.toml");
        process.exit(1);
      }
      const d = await apiPost(deps, "/cli/deploys/get", { ref }, { read: true });
      if (!d) { console.error(`No deploy ${ref}`); process.exit(1); }
      if (d.status !== "requested") { console.log(`${ref} is ${d.status}; nothing to run`); return; }
      const result = await runDeploy({ root: profileRoot ?? root, deploy: ref, command, actor: d.started_by?.name ?? "cast", post });
      console.log(`${ref}: ${result.status}`);
      if (result.status !== "live") process.exit(1);
    });

  // A station measured on frozen past cases before an edit reaches a run (learning-loop.md LL14).
  line
    .command("replay")
    .description("Replay one station of a line graph on past runs this machine holds, on the graph's files at a revision and as they are on disk, in the dry-run sandbox (nothing written, no connection but the model's); each case passes on its pinned fields or a blind yes/no grade")
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
      const { tally, p } = await runReplay({ root, cast: graph, station, cases, base, overlay, db, asOf: !!options.asOf, reps: options.reps, out, concurrency: options.concurrency, log: options.json ? undefined : (l) => console.log(`  ${l}`) }, replayDeps());
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
