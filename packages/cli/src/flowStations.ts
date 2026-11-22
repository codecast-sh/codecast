// The change flow's stations as `cast flow` subcommands (flows.md FL4). Each is
// a script a station of the library change flow runs; its exit code is the
// route the graph takes.
import type { Command } from "commander";
import type { FlowDeps } from "./flowCommand.js";

export function registerFlowStations(flow: Command, deps: FlowDeps): Command {
  // The change flow's CI station (workflow/ciStation.ts): parks on the pull request's checks.
  flow
    .command("ci")
    .description("Wait for a pull request's CI, rerun failed jobs once, and write ci.json: green only when GitHub's runs and every outside check passed, red failures split by whether main has them too; always exits 0")
    .requiredOption("--pr <number>", "The pull request")
    .requiredOption("--dir <path>", "The run's directory, where ci.json is written")
    .option("--deadline <duration>", "How long to wait for the checks (90s, 60m, 2h, 1h30m)", "60m")
    .option("--head <sha>", "Judge only this head: wait until the pull request's head is it")
    .option("--run <id>", "The run whose station this is: each new line goes on the station while it waits, and the verdict to the run (default: $run_id)")
    .option("--node <id>", "That station's id in the run (default: $station_id)")
    .action(async (opts: { pr: string; dir: string; deadline: string; head?: string; run?: string; node?: string }) => (await import("./workflow/ciStation.js")).ciCommand(opts, deps.cliPost));

  flow
    .command("merge")
    .description("A change flow's Merge station: clears the merge on green CI of the PR's head and a ship review, rebases it onto the default branch, runs the before-merge deploy steps from the rebased tree, then squash-merges that head. Exits 0 merged (the last line is the sha on the default branch, merge.json written), 1 conflict, 2 refused, 3 retest")
    .requiredOption("--pr <number>", "The pull request")
    .requiredOption("--branch <name>", "The change's branch")
    .requiredOption("--dir <run_dir>", "The run's directory: ci.json and review.json are read from it, merge.json written to it")
    .option("--run <id>", "The run whose station this is (default: $run_id from the station's environment)")
    .action(async (opts: { pr: string; branch: string; dir: string; run?: string }) => {
      // bun exits 1 on an uncaught error, and the graph reads exit 1 as a conflict: a crash refuses instead.
      const crashed = (err: unknown) => { console.log(`station crashed: ${String(err instanceof Error ? `${err.name}: ${err.message}` : err).split("\n")[0]}`); process.exit(2); };
      process.on("uncaughtException", crashed);
      process.on("unhandledRejection", crashed);
      try {
        const { mergeCommand } = await import("./workflow/mergeStation.js");
        const post = (p: string, body: Record<string, unknown>) => deps.cliPost(p, body, { throwOnError: true, timeoutMs: 300_000 });
        process.exit(await mergeCommand({ ...opts, cwd: deps.realCwd(), post }));
      } catch (err) {
        crashed(err);
      }
    });

  flow
    .command("review-verdict")
    .description("From a change flow's reviewer session: record the verdict and the head it read on the run, which a merge's clearance needs. The session names itself from its environment; the server finds the run and reviewer station it runs as")
    .requiredOption("--verdict <verdict>", "ship, changes or rejected")
    .requiredOption("--head <sha>", "The pull request head the review read (40 hex characters)")
    .option("--round <id>", "The review round, as pr.json names it")
    .option("--run <id>", "The run, when this session reviews for more than one")
    .option("--node <id>", "The reviewer station's id, when the session runs more than one")
    .action(async (opts: { verdict: string; head: string; round?: string; run?: string; node?: string }) => {
      const session = deps.callingSession();
      if (!session) { console.error("no session: the review verdict is recorded from inside the reviewer station's own session"); process.exit(1); }
      try {
        const r = await deps.cliPost("/cli/workflow-runs/review-verdict", {
          session_id: session, verdict: opts.verdict, head_sha: opts.head,
          ...(opts.round ? { round: opts.round } : {}), ...(opts.run ? { run_id: opts.run } : {}), ...(opts.node ? { node_id: opts.node } : {}),
        }, { throwOnError: true });
        console.log(`recorded ${opts.verdict} on ${opts.head.slice(0, 10)} for ${r?.node_id ?? "the reviewer station"}`);
      } catch (err) {
        console.error(`the review verdict was not recorded: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
  return flow;
}
