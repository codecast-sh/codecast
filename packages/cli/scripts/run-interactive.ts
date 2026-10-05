// Run a command as a one-shot launchd job at Interactive priority, relay its
// output, and exit with its code (src/interactiveJob.ts says why).
//
//   bun packages/cli/scripts/run-interactive.ts -- <command> [args...]
import { runAsInteractiveJob } from "../src/interactiveJob";

const sep = process.argv.indexOf("--");
const command = sep >= 0 ? process.argv.slice(sep + 1) : process.argv.slice(2);
if (command.length === 0) {
  console.error("usage: run-interactive.ts -- <command> [args...]");
  process.exit(2);
}
process.exit(await runAsInteractiveJob(command));
