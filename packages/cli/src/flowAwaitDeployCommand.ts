// `cast flow await-deploy` and `cast flow landed` (flows.md FL4), kept out of flowCommand.ts to hold that file under the
// 800-line cap (packages/shared/ratchet): the Deploy stage's wait from the merged sha, and Land's check that a change is on
// main, each run by a parked station in the change's worktree.
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

  // Land's check that the change is on main (workflow/landed.ts): run by templates/line/ship.sh after the land command.
  flow
    .command("landed")
    .description("Find the commit on origin's default branch that carries a change's branch and write it as merge.json; exit 1 when nothing was merged")
    .option("--branch <name>", "The change's branch")
    .option("--base <name>", "The default branch it lands on", "main")
    .option("--files <paths>", "The change's files, space-separated (the run's $change_files); else read from git")
    .option("--out <file>", "Where to write { sha, files } (the run's $run_dir/merge.json)")
    .option("--since <sha>", "Where the change started (its fork from the default branch before it landed): a branch with nothing of its own since is never landed")
    .option("--wait <seconds>", "Wait this long for the branch to merge (a pull request Ship's session merges); exit 2 when it has not")
    .option("--interval <seconds>", "How often to look again while waiting", "30")
    .option("--as <name>", "The branch's name on the run's merge record, when --branch is a commit")
    .option("--run <id>", "The run whose station this is: the landed commit is recorded as its merge, and each waiting line goes on the station")
    .option("--node <id>", "That station's id in the run")
    .action(async (opts: import("./workflow/landed.js").LandedOptions) => {
      const { runLanded } = await import("./workflow/landed.js");
      process.exit(await runLanded(deps.realCwd(), opts, (p, b) => deps.cliPost(p, b, { throwOnError: true })));
    });
}
