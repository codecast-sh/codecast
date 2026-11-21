// `cast flow await-deploy` (flows.md FL4), kept out of flowCommand.ts to hold that file under the 800-line cap
// (packages/shared/ratchet): the Deploy stage's wait from the merged sha, run by the deploy segment's parked station in
// the change's worktree. The other stations' commands are in flowStations.ts.
import type { Command } from "commander";
import type { FlowDeps } from "./flowCommand.js";

type Cast = (args: string[], cwd: string) => Promise<{ code: number; out: string; err: string }>;

export function registerFlowAwaitDeployCommand(flow: Command, deps: Pick<FlowDeps, "cliPost" | "realCwd">, cast: Cast): void {
  // The Deploy stage's wait (workflow/awaitDeploy.ts, flows.md FL4): run by the
  // deploy segment's parked station in the change's worktree.
  flow
    .command("await-deploy")
    .description("From the commit a change merged, send the release targets its files touch, wait on its push and auto targets, and end live, failed (1), not merged (4) or stuck past a target's deadline (5)")
    .option("--sha <sha>", "The merged commit on the default branch")
    .option("--merge <file>", "Merge's merge.json, whose sha is the merged commit (the run's $run_dir/merge.json)")
    .option("--base <name>", "The default branch it merged into", "main")
    .option("--branch <name>", "The change's branch, named on the merge this records on the run")
    .option("--interval <seconds>", "How often to look again", "60")
    .option("--once", "Look once and send nothing: exit 0 live (or nothing to deploy), 1 failed, 3 still waiting")
    .option("--run <id>", "The run whose station this is: each new line goes on the station while it waits")
    .option("--node <id>", "That station's id in the run")
    .option("--task <id>", "The run's task: a missed deadline posts one blocker there")
    .option("--files <paths>", "The change's files, space-separated (the run's $change_files); else the merged commit's")
    .option("--except <targets>", "Targets the change does not wait for, space- or comma-separated")
    .option("--send <policy>", "release: send the release targets the change touches; empty: send nothing and only wait", "release")
    .action(async (opts: import("./workflow/awaitDeploy.js").AwaitDeployOptions) => {
      const { runAwaitDeploy } = await import("./workflow/awaitDeploy.js");
      const cwd = deps.realCwd();
      // A failed post must not end the station: cliPost exits the process unless asked to throw.
      process.exit(await runAwaitDeploy(opts, { cwd, cast: (args) => cast(args, cwd), post: (p, b) => deps.cliPost(p, b, { throwOnError: true }) }));
    });
}
