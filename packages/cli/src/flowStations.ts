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
  return flow;
}
