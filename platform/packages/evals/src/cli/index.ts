/**
 * Mount the eval CLI on a commander program:
 *
 *   const program = new Command().name('xrun');
 *   registerEvals(program, { name: 'xrun', convo, freezes, freezeResolver, replayer, runs, sims, htmlDir });
 *   process.exitCode = await runEvalsCli(program);
 *
 * Every read view takes --json, --no-color, --width and --full. Colour is
 * off when stdout is not a terminal, so an agent reading through a pipe
 * gets plain text. A source the app did not wire fails with a sentence
 * that names the seam.
 */

import type { Command } from 'commander';

import type { EvalSources } from '../model';
import { registerConvo } from './convo';
import { registerFreeze } from './freeze';
import { registerRuns } from './runs';
import { registerSim } from './sim';
import { setCli, UsageError } from './shared';

export function registerEvals(program: Command, sources: EvalSources): void {
  setCli(sources.name);
  registerConvo(program, sources);
  registerFreeze(program, sources);
  registerRuns(program, sources);
  // A repo with no simulation launcher gets no `sim` command, rather than one that only errors.
  if (sources.sims) registerSim(program, sources);
}

/**
 * Parse and run one invocation and return its exit code: 1 for a usage
 * error, printed as one line rather than a stack, otherwise the code a
 * command set on process.exitCode. The process's own exit code is left as it
 * was, so an in-process caller (a test) never inherits a failed run; the bin
 * entry sets it from the return value.
 */
export async function runEvalsCli(program: Command, argv: string[] = process.argv): Promise<number> {
  // 0, never undefined: Bun ignores an assignment of undefined and keeps the old code.
  const outer = process.exitCode ?? 0;
  process.exitCode = 0;
  try {
    await program.parseAsync(argv);
    return Number(process.exitCode ?? 0);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    process.stderr.write(`${program.name()}: ${err.message}\n`);
    return 1;
  } finally {
    process.exitCode = outer;
  }
}

export { UsageError } from './shared';
export { registerConvo, registerFreeze, registerRuns, registerSim };
