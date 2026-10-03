import { spawnSync } from 'node:child_process';

import type { Command } from 'commander';
import type { BisectAnswer, BisectPlan, BisectState, Candidate } from '@codecast/shared/contracts/evalsApi';
import { fmt } from '@platform/cli-kit/colors';
import { formatCost } from '@platform/cli-kit/format';

import { buildPlan, type PlanArgs } from '../bisect/plan';
import { treeEnv } from '../bisect/probe';
import { budgetRefusal, runBisect, startRefusal } from '../bisect/runner';
import { bisectPaths, BISECT_ID_RE, listBisects, LIVE_STATUSES, newBisectId, readBisectState, readSteps, requestStop } from '../bisect/state';
import { indexedRuns } from '../history/runIndex';
import { surfaceMeta } from '../registry';
import { EXIT_INCOMPLETE } from './check';
import { positiveNumber } from './verdict';

// `./evals bisect`: take a regression on one surface to the source change
// that caused it (docs/architecture/evals-ui.md section 5). `plan` answers
// from the records for free (Tier 0), renders the candidates dry for free
// (Tier 1) and prints the most a replay search could spend; `start` runs that
// search (controls, probes, confirmation) inside the plan's budget; `resume`
// goes on after a kill or a stop; `status`, `watch`, `stop` and `ls` read and
// steer what is in EVALS_HOME/bisects. The Evals page launches `start` in
// tmux and reads the same folder.

interface PlanFlags {
  good?: string;
  bad?: string;
  freeze?: string[];
  reps?: number;
  budget?: number;
  maxMinutes?: number;
  allCommits?: boolean;
  render?: boolean;
  json?: boolean;
}

interface StartFlags extends PlanFlags {
  yes?: boolean;
  id?: string;
}

const short = (s: string | null | undefined) => (s ? s.slice(0, 9) : 'none');

const argsOf = (surface: string, f: PlanFlags): PlanArgs => {
  if (!surfaceMeta(surface)) throw new Error(`no surface ${surface}; ./evals lists them`);
  return { surface, good: f.good, bad: f.bad, freezes: f.freeze?.length ? f.freeze : undefined, reps: f.reps, budgetUsd: f.budget, maxMinutes: f.maxMinutes, allCommits: f.allCommits };
};

/** The terminal, when there is one: a detached start writes its stdout into log.txt, which the journal already writes. */
const tty = (line: string) => (process.stdout.isTTY ? console.log(fmt.muted(line)) : undefined);

/** The tmux session this process runs in, or null. */
function tmuxSession(): string | null {
  if (!process.env.TMUX) return null;
  const r = spawnSync('tmux', ['display-message', '-p', '#S'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

const candidateWords = (c: Candidate) => (c.kind === 'commit' ? `${short(c.commit.sha)} ${c.commit.subject}${c.commit.session ? ` (${c.commit.session})` : ''}` : `uncommitted edits ${c.treePatch.slice(0, 8)} on top of ${short(c.base)}`);

/** A bisect's answer in one line. */
export function answerWords(a: BisectAnswer | null): string {
  if (!a) return 'no answer yet';
  switch (a.kind) {
    case 'culprit':
      return `culprit ${short(a.commit.sha)} ${a.commit.subject} (tier ${a.tier}${a.separation.kind === 'too-few' ? '' : `, ${a.separation.kind} p=${a.separation.p.toFixed(4)}`})`;
    case 'range':
      return `a range of ${a.candidates.length}: ${a.candidates.map(candidateWords).join('; ')} (tier ${a.tier}${a.separation && a.separation.kind !== 'too-few' ? `, ${a.separation.kind} p=${a.separation.p.toFixed(4)}` : ''})`;
    case 'drift':
      return a.detail;
    case 'unreplayable':
      return a.detail;
    case 'attribution':
      return `answered before any replay: ${a.answer.kind}`;
  }
}

function printPlan(plan: BisectPlan): void {
  const a = plan.attribution;
  const end = (e: BisectPlan['good']) => `${e.batch ?? 'commit'} (${short(e.sha)}${e.dirty ? ', dirty' : ''}${e.mainSha && e.mainSha !== e.sha ? `, main twin ${short(e.mainSha)}` : ''})`;
  console.log(fmt.bold(`${plan.surface}: good ${end(plan.good)} to bad ${end(plan.bad)}, ${a.mode} mode`));
  let lit = false;
  for (const c of a.checklist) {
    const first = c.differs && !lit;
    lit ||= c.differs;
    console.log(`  ${first ? fmt.warning('>') : ' '} ${c.class.padEnd(10)} ${c.differs ? c.detail : fmt.muted(c.detail)}`);
  }
  const x = a.answer;
  if (x.kind === 'source') {
    console.log(`answer: source, ${x.confidence}${x.reason ? ` (${x.reason})` : ''}${x.noDeclaredSourceMoved ? '; no declared source moved' : ''}`);
    for (const p of x.narrowedBy) console.log(fmt.muted(`  recorded ${p.batch} at ${short(p.sha)} reads ${p.verdict} (${p.reps} reps)`));
  } else console.log(`answer: ${x.kind}`);
  if (plan.candidates.length) {
    console.log(`candidates (${plan.candidates.length}, oldest first):`);
    for (const c of plan.candidates) console.log(`  ${c.renderClass != null ? `class ${String(c.renderClass).padStart(2)}  ` : ''}${candidateWords(c)}`);
  }
  if (plan.classes) {
    console.log(`render classes (${plan.classes.length}):`);
    for (const c of plan.classes) console.log(`  ${String(c.n).padStart(2)}  ${c.shas.map((s) => (s.startsWith('patch:') ? s.slice(0, 14) : short(s))).join(', ')}${c.skip ? fmt.warning(`  skip: ${c.skip}`) : ''}`);
  } else if (plan.candidates.length > 1) console.log(fmt.muted('render classes: not rendered (--no-render); each candidate counts as its own'));
  // In score mode nothing flipped: the focus freezes are the largest median drops.
  const role = (r: string) => (r === 'control' ? 'control' : a.mode === 'flip' ? 'flipped' : 'largest drop');
  console.log(`freezes: ${plan.freezes.map((f) => `${f.id.slice(0, 8)} ${f.name} (${role(f.role)})`).join(', ') || 'none'}`);
  console.log(fmt.bold(plan.summary));
  if (plan.needsConfirm) console.log(fmt.warning(`${plan.surface} is an agent surface: start needs --yes`));
}

function printState(s: BisectState): void {
  console.log(fmt.bold(`${s.id}: ${s.surface}, ${s.status}, tier ${s.tier}, spent ${formatCost(s.spentUsd)} of ${formatCost(s.budgetUsd)}${s.tmux ? `, tmux ${s.tmux}` : ''}`));
  console.log(`  ${s.range.good} to ${s.range.bad}; ${s.candidates.length} candidate(s)${s.classes ? `, ${s.classes.length} class(es)` : ''}`);
  for (const p of s.probes) {
    const passed = p.reps.filter((r) => r.passed).length;
    console.log(`  ${p.kind.padEnd(15)} ${short(p.sha)}${p.renderClass != null ? ` c${p.renderClass}` : ''}  ${p.verdict.padEnd(7)} ${p.reps.length ? `${passed}/${p.reps.length} passed` : ''}${p.recorded ? fmt.muted(' recorded') : ''}${p.skipReason ? fmt.warning(` ${p.skipReason}`) : ''}`);
  }
  console.log(`answer: ${answerWords(s.answer)}`);
}

const exitOf = (s: BisectState): number => (s.status === 'done' ? 0 : s.status === 'stopped' || s.status === 'budget' ? EXIT_INCOMPLETE : 1);

export async function bisectPlan(surface: string, flags: PlanFlags): Promise<number> {
  const args = argsOf(surface, flags);
  // In --json mode stdout is the plan alone: the render's progress (and anything the tree prints) goes to stderr.
  const restore = console.log;
  if (flags.json) console.log = console.error;
  try {
    const rows = await indexedRuns({ surface });
    const env = flags.render === false ? undefined : treeEnv(surface, { out: (l) => console.error(fmt.muted(l)) });
    const { plan } = await buildPlan(args, { rows }, { env, onRender: (c, batch, ran) => ran && console.error(fmt.muted(`dry render: ${batch}`)) });
    console.log = restore;
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(plan)}\n`);
      return 0;
    }
    printPlan(plan);
    const why = startRefusal(plan) ?? budgetRefusal(plan);
    if (!why) console.log(`\nNext: ./evals bisect start ${surface} --good ${plan.good.batch ?? plan.good.sha} --bad ${plan.bad.batch ?? plan.bad.sha}${plan.needsConfirm ? ' --yes' : ''}`);
    return 0;
  } finally {
    console.log = restore;
  }
}

export async function bisectStart(surface: string, flags: StartFlags): Promise<number> {
  const args = argsOf(surface, flags);
  const id = flags.id ?? newBisectId(surface);
  if (!BISECT_ID_RE.test(id)) throw new Error(`--id ${id}: lowercase letters, digits and dashes only`);
  if (readBisectState(id)) throw new Error(`bisect ${id} already exists: ./evals bisect resume ${id} goes on with it`);
  const env = treeEnv(surface, { out: tty, log: bisectPaths(id).log });
  console.log(`bisect ${id}: ./evals bisect watch ${id} follows it, ./evals bisect stop ${id} cancels it between reps`);
  const s = await runBisect(id, args, env, { yes: flags.yes, noRender: flags.render === false, tmux: tmuxSession(), echo: tty });
  printState(s);
  return exitOf(s);
}

export async function bisectResume(id: string): Promise<number> {
  const s0 = readBisectState(id);
  if (!s0) throw new Error(`no bisect ${id}; ./evals bisect ls lists them`);
  const env = treeEnv(s0.surface, { out: tty, log: bisectPaths(id).log });
  const s = await runBisect(id, { surface: s0.surface }, env, { resume: true, yes: true, tmux: tmuxSession(), echo: tty });
  printState(s);
  return exitOf(s);
}

async function bisectWatch(id: string): Promise<number> {
  let seq = 0;
  for (;;) {
    for (const step of readSteps(id, seq)) {
      console.log(`[${step.seq}] ${step.kind}${step.sha ? ` ${short(step.sha)}` : ''}: ${step.text}`);
      seq = step.seq;
    }
    const s = readBisectState(id);
    if (!s) throw new Error(`no bisect ${id}`);
    if (!LIVE_STATUSES.has(s.status)) {
      console.log(fmt.bold(`${s.status}: ${answerWords(s.answer)}`));
      return exitOf(s);
    }
    await Bun.sleep(2000);
  }
}

const freezeList = (v: string, all: string[]) => [...all, ...v.split(',').map((x) => x.trim()).filter(Boolean)];

function planOptions(c: Command): Command {
  return c
    .option('--good <ref>', 'the good batch or sha (default: the newest earlier batch on the same footing that passed the broken freezes)')
    .option('--bad <ref>', 'the bad batch or sha (default: the newest batch that separated worse or broke a freeze)')
    .option('--freeze <ids>', 'only these freezes (comma separated or repeated, prefix ok)', freezeList, [] as string[])
    .option('--reps <n>', 'reps per probe per freeze (default 3; a split adds 2 once)', positiveNumber('--reps', true))
    .option('--budget <usd>', 'refuse a plan whose bound is over this, and stop when it is spent (default: the bound and a fifth again)', positiveNumber('--budget'))
    .option('--max-minutes <n>', 'start no rep after this many minutes (default 120)', positiveNumber('--max-minutes'))
    .option('--all-commits', 'search every commit in the range, not only those touching what the surface declares')
    .option('--no-render', 'skip the free dry renders (Tier 1): each candidate counts as its own class');
}

export function registerBisect(program: Command): void {
  const bisect = program.command('bisect').description('take a regression on one surface to the source change that caused it: free answers first, then a bounded replay search');
  planOptions(bisect.command('plan <surface>').description('answer from the records, render the candidates dry, and print the most a search could spend (all free)'))
    .option('--json', 'print the plan as JSON (progress goes to stderr)')
    .action(async (surface: string, flags: PlanFlags) => {
      process.exitCode = await bisectPlan(surface, flags);
    });
  planOptions(bisect.command('start <surface>').description('run the replay search inside its budget: controls, probes, confirmation'))
    .option('--yes', 'confirm the spend on an agent surface')
    .option('--id <id>', 'name the bisect (the Evals page names it)')
    .action(async (surface: string, flags: StartFlags) => {
      process.exitCode = await bisectStart(surface, flags);
    });
  bisect
    .command('resume <id>')
    .description('go on with a bisect after a kill, a stop or a crash; reps already on record are not run again')
    .action(async (id: string) => {
      process.exitCode = await bisectResume(id);
    });
  bisect
    .command('status <id>')
    .description("a bisect's state: probes, spend, answer")
    .option('--json', 'the state as JSON')
    .action((id: string, flags: { json?: boolean }) => {
      const s = readBisectState(id);
      if (!s) throw new Error(`no bisect ${id}; ./evals bisect ls lists them`);
      if (flags.json) process.stdout.write(`${JSON.stringify(s)}\n`);
      else printState(s);
    });
  bisect
    .command('watch <id>')
    .description("print a bisect's steps as they land, until it ends")
    .action(async (id: string) => {
      process.exitCode = await bisectWatch(id);
    });
  bisect
    .command('stop <id>')
    .description('cancel a bisect between reps (resume goes on with it)')
    .action((id: string) => {
      if (!requestStop(id)) throw new Error(`no bisect ${id}`);
      console.log(`asked ${id} to stop; it stops before its next rep`);
    });
  bisect
    .command('ls')
    .description('every bisect, newest first')
    .option('--json', 'as JSON')
    .action((flags: { json?: boolean }) => {
      const all = listBisects();
      if (flags.json) return void process.stdout.write(`${JSON.stringify(all)}\n`);
      if (!all.length) console.log('no bisects yet: ./evals bisect plan <surface> --good <batch> --bad <batch>');
      for (const b of all) console.log(`${b.id.padEnd(36)} ${b.status.padEnd(10)} ${(b.outcome ?? '-').padEnd(12)} ${b.culprit ? short(b.culprit) : '-'.padEnd(9)}  ${formatCost(b.spentUsd)} of ${formatCost(b.budgetUsd)}  ${b.good} to ${b.bad}`);
    });
}

// Until main.ts registers it: `bun packages/evals/src/commands/bisect.ts <plan|start|...> ...` runs it as `./evals bisect` would.
if (import.meta.main) {
  const { Command } = await import('commander');
  const program = new Command().name('evals').showHelpAfterError();
  registerBisect(program);
  try {
    await program.parseAsync([process.argv[0]!, process.argv[1]!, 'bisect', ...process.argv.slice(2)]);
  } catch (e) {
    process.stderr.write(`evals: ${e instanceof Error ? (process.env.EVALS_DEBUG ? e.stack : e.message) : String(e)}\n`);
    process.exitCode = 1;
  }
}
