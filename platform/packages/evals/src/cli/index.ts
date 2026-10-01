/**
 * Mount the eval CLI on a commander program:
 *
 *   const program = new Command().name('xrun');
 *   registerEvals(program, { name: 'xrun', convo, freezes, freezeResolver, replayer, runs, sims, htmlDir });
 *   await runEvalsCli(program);
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
  registerSim(program, sources);
}

/** Parse and run, turning a usage error into one line and exit 1 rather than a stack. */
export async function runEvalsCli(program: Command, argv: string[] = process.argv): Promise<void> {
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${program.name()}: ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

export { UsageError } from './shared';
export { registerConvo, registerFreeze, registerRuns, registerSim };
