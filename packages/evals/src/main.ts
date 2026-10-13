// The program behind ./evals (index.ts runs `stale` before this loads). The
// convo, freeze and runs commands are @platform/evals'; this file wires them
// to codecast's access-checked reads, its two freeze homes and EVALS_HOME.

import { Command } from 'commander';
import { fmt } from '@platform/cli-kit/colors';
import { registerEvals, runEvalsCli } from '@platform/evals/cli';

import { codecastConvoSource } from './adapters/convo';
import { codecastFreezeStore } from './adapters/freezes';
import { codecastReplyJudge } from './adapters/judge';
import { codecastReplayer } from './adapters/replay';
import { codecastFreezeResolver, defaultJudgeFor, describeFreeze, judgeMomentOfFreeze, productionReplyOf } from './adapters/resolver';
import { codecastRunSource } from './adapters/runs';
import { registerApi } from './commands/api';
import { registerBisect } from './commands/bisect';
import { registerCapture } from './commands/capture';
import { registerCheck } from './commands/check';
import { registerDoctor } from './commands/doctor';
import { registerGrade, registerRescore } from './commands/grade';
import { registerIndex } from './commands/indexCmd';
import { registerLabel } from './commands/label';
import { registerLine } from './commands/line';
import { registerPin } from './commands/pin';
import { registerPublish } from './commands/publish';
import { registerSnapshot } from './commands/snapshot';
import { registerSnippet } from './commands/snippetCmd';
import { registerStale } from './commands/stale';
import { registerStatus } from './commands/status';
import { homePaths } from './paths';
import { writeCheckoutPointer } from './provenance';

export async function main(): Promise<number> {
  // The daemon's evals bridge runs the code of the checkout that last ran ./evals.
  writeCheckoutPointer();
  const program = new Command()
    .name('evals')
    .description('Freeze codecast moments, replay the prompts in this tree against them, grade and publish the result')
    .version('0.1.0')
    .showHelpAfterError()
    .configureHelp({ sortSubcommands: false })
    .addHelpText(
      'after',
      `
The loop: ${fmt.cmd('./evals freeze create title@jx7c6zk:142')} → ${fmt.cmd('./evals check title')} (the baseline) → edit the prompt → ${fmt.cmd('./evals check title')} → ${fmt.cmd('./evals freeze results <id>')}.
A surface is one prod prompt; ${fmt.cmd('./evals')} lists them. A ref names its surface and a moment, ${fmt.cmd('<surface>@<ref>')}: a session
and line (title@jx7c6zk:142), a call, a trigger, a snapshot, or ${fmt.cmd('<surface>@fixture:<case>')}. A bad ref lists every form.
Find moments with ${fmt.cmd('./evals convo inbox')} and ${fmt.cmd('./evals convo find "<text>"')}. Reads change nothing and take --json.
Real data (private freezes, snapshots, runs, labels) lives in EVALS_HOME (~/.local/share/codecast/evals); labels push to
a private repo. Only synthetic fixtures under packages/evals enter git. ${fmt.cmd('./evals check --help')} explains the verdict,
${fmt.cmd('./evals doctor')} says what is missing, docs/architecture/evals.md has the design.`,
    );

  // The network-backed seams are built on first use, so `runs`, `freeze list`
  // and `--help` work on a machine with no codecast sign-in at all.
  const lazy = <T extends object>(make: () => T): T =>
    new Proxy({} as T, {
      get(_, key) {
        const target = make();
        const v = (target as Record<string | symbol, unknown>)[key];
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });

  const freezes = codecastFreezeStore({ defaultJudge: defaultJudgeFor });
  const sources = {
    name: './evals',
    convo: lazy(() => codecastConvoSource({ freezes, describeFreeze })),
    freezes,
    freezeResolver: lazy(() => codecastFreezeResolver()),
    replayer: codecastReplayer,
    judge: lazy(() => codecastReplyJudge(judgeMomentOfFreeze)),
    productionReply: productionReplyOf,
    runs: codecastRunSource(),
    htmlDir: homePaths().html,
  };

  registerStatus(program);
  registerCheck(program, sources);
  registerStale(program);
  registerLine(program, sources);
  registerEvals(program, sources);
  registerLabel(program, sources);
  registerSnapshot(program);
  registerGrade(program);
  registerRescore(program);
  registerCapture(program);
  registerDoctor(program);
  registerSnippet(program);
  registerPublish(program);
  registerPin(program);
  registerIndex(program);
  registerBisect(program);
  registerApi(program);

  // A bare `./evals` (flags at most) is the status view. Any word is a command,
  // so a typo gets commander's unknown-command error and its suggestion.
  const args = process.argv.slice(2);
  const bare = args.every((a) => a.startsWith('-')) && !args.some((a) => ['-h', '--help', '-V', '--version'].includes(a));
  try {
    return await runEvalsCli(program, bare ? [...process.argv.slice(0, 2), 'status', ...args] : process.argv);
  } catch (e) {
    // A refusal or a missing input is one line; EVALS_DEBUG=1 shows where it came from.
    process.stderr.write(`evals: ${e instanceof Error ? (process.env.EVALS_DEBUG ? e.stack : e.message) : String(e)}\n`);
    return 1;
  }
}
