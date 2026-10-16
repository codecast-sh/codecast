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

  // The repo's line profile and the eval station's builder (line-profile.md LP2, LP4).
  registerLineProfileCommands(line, deps);
  // Bringing moments and the team's model budget (learning-loop.md LL7, LL10).
  registerMomentsCommands(line, deps);
  registerLineTrialCommands(line, deps);
  // A dissolved problem's close by what it argued (learning-loop.md LL13).
  registerLineDissolveCommand(line, deps);
  // Setting up and improving a project's judges (learning-loop.md LL4).
  registerJudgingCommands(line, deps);
}
