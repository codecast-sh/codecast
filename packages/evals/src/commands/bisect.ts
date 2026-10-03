import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

import type { Command } from 'commander';
import type { BisectAnswer, BisectPlan, BisectState, Candidate } from '@codecast/shared/contracts/evalsApi';
import { fmt } from '@platform/cli-kit/colors';
import { formatCost } from '@platform/cli-kit/format';

import { buildPlan, type PlanArgs } from '../bisect/plan';
import { treeEnv } from '../bisect/probe';
import { budgetRefusal, runBisect, startRefusal } from '../bisect/runner';
import { listSimBisects, newSimBisectId, planSimBisect, readSimBisect, runSimBisect, simAnswerWords, simTreeEnv, type SimBisectPlan, type SimBisectRecord } from '../bisect/simProbe';
import { bisectPaths, BISECT_ID_RE, listBisects, LIVE_STATUSES, newBisectId, readBisectState, readSteps, requestStop } from '../bisect/state';
import { indexedRuns } from '../history/runIndex';
import { surfaceMeta } from '../registry';
import { bisectSignal, reportSignals } from '../signals';
import { EXIT_INCOMPLETE } from './check';
import { positiveNumber } from './verdict';

// `./evals bisect`: take a regression on one surface to the source change
// that caused it (docs/architecture/evals-ui.md section 5). `plan` answers
// from the records for free (Tier 0), renders the candidates dry for free
// (Tier 1) and prints the most a replay search could spend; `start` runs that
// search (controls, probes, confirmation) inside the plan's budget; `resume`
// goes on after a kill or a stop; `status`, `watch`, `stop` and `ls` read and
// steer what is in EVALS_HOME/bisects. The Evals page launches `start` in
// tmux and reads the same folder. With `--sim <artifactDir>` in place of a
// surface, `plan` and `start` take a failing Multiplayer sim run to the
// commit that broke it instead, by deterministic replays that cost nothing
// (bisect/simProbe.ts).

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
  sim?: string;
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
      return `does not reproduce on today's tool and judge, drift not source: ${a.detail}`;
    case 'crashed':
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

/** `--sim` takes the place of a surface, and of the flags that size a paid search. */
function simFlags(surface: string | undefined, f: StartFlags): string | null {
  if (!f.sim) {
    if (!surface) throw new Error('name a surface, or --sim <artifactDir> for a Multiplayer sim failure');
    return null;
  }
  if (surface) throw new Error(`--sim bisects a Multiplayer sim failure; it takes no surface (got ${surface})`);
  const paid = (['freeze', 'reps', 'budget', 'maxMinutes', 'yes'] as const).filter((k) => (k === 'freeze' ? f.freeze?.length : f[k] !== undefined));
  if (paid.length) throw new Error(`--sim replays are deterministic and free: ${paid.map((k) => `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`).join(', ')} ${paid.length === 1 ? 'does' : 'do'} not apply`);
  return f.sim;
}

function printSimPlan(p: SimBisectPlan): void {
  const f = p.failure;
  console.log(fmt.bold(`Multiplayer sim ${f.scenario} [${f.mode} seed ${f.seed}]: ${f.invariant}${f.row ? ` on ${f.row}` : ''}`));
  console.log(`  replays ${f.shrunk ? 'the shrunk' : 'the recorded'} order (${f.deliveries} deliveries) with the harness at ${short(p.harness)}`);
  console.log(`  good ${short(p.good.sha)}${p.good.how === 'history' ? fmt.muted(` (the newest clean session that passed it, ${p.good.session})`) : ''} to bad ${short(p.bad.sha)}${p.bad.patch ? ` + its kept edits ${p.bad.patch.slice(0, 8)}` : p.bad.dirty ? fmt.warning(' (ran on edits its session did not keep)') : ''}`);
  if (p.candidates.length) {
    console.log(`candidates (${p.candidates.length}, oldest first):`);
    for (const c of p.candidates) console.log(`  ${candidateWords(c)}`);
  }
  console.log(fmt.bold(p.summary));
}

function printSimRecord(r: SimBisectRecord): void {
  const p = r.plan;
  console.log(fmt.bold(`${r.id}: Multiplayer sim ${p.failure.scenario}, ${r.status}, ${r.probes.length} of at most ${p.maxProbes} probe(s), $0${r.tmux ? `, tmux ${r.tmux}` : ''}`));
  console.log(`  ${short(p.good.sha)} to ${short(p.bad.sha)}${p.bad.patch ? '+edits' : ''}; ${p.candidates.length} candidate(s)`);
  for (const x of r.probes) console.log(`  ${x.role.padEnd(5)} ${short(x.sha)}${x.patch ? `+${x.patch.slice(0, 8)}` : '         '}  ${x.verdict.padEnd(4)}  ${fmt.muted(`${x.detail} (${Math.round(x.ms / 1000)}s)`)}`);
  console.log(`answer: ${simAnswerWords(r.answer)}`);
}

const simExitOf = (r: SimBisectRecord): number => (r.status === 'done' ? 0 : r.status === 'stopped' ? EXIT_INCOMPLETE : 1);

async function simBisectPlan(artifact: string, flags: PlanFlags): Promise<number> {
  const plan = planSimBisect(artifact, { good: flags.good, bad: flags.bad, allCommits: flags.allCommits });
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(plan)}\n`);
    return 0;
  }
  printSimPlan(plan);
  if (plan.candidates.length) console.log(`\nNext: ./evals bisect start --sim ${plan.failure.artifact} --good ${short(plan.good.sha)}${flags.bad ? ` --bad ${flags.bad}` : ''}${flags.allCommits ? ' --all-commits' : ''}`);
  return 0;
}

async function simBisectStart(artifact: string, flags: StartFlags): Promise<number> {
  const plan = planSimBisect(artifact, { good: flags.good, bad: flags.bad, allCommits: flags.allCommits });
  const id = flags.id ?? newSimBisectId(plan.failure.scenario);
  if (!BISECT_ID_RE.test(id)) throw new Error(`--id ${id}: lowercase letters, digits and dashes only`);
  if (readSimBisect(id) || readBisectState(id)) throw new Error(`bisect ${id} already exists: ./evals bisect resume ${id} goes on with it`);
  console.log(`bisect ${id}: ./evals bisect watch ${id} follows it, ./evals bisect stop ${id} cancels it between probes`);
  const r = await runSimBisect(id, plan, simTreeEnv(plan.failure, plan.harness, { log: (l) => appendFileSync(bisectPaths(id).log, `${l}\n`) }), { tmux: tmuxSession(), echo: tty });
  printSimRecord(r);
  return simExitOf(r);
}

async function simBisectResume(r0: SimBisectRecord): Promise<number> {
  const r = await runSimBisect(r0.id, null, simTreeEnv(r0.plan.failure, r0.plan.harness, { log: (l) => appendFileSync(bisectPaths(r0.id).log, `${l}\n`) }), { tmux: tmuxSession(), echo: tty });
  printSimRecord(r);
  return simExitOf(r);
}

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
  fileFinding(s);
  return exitOf(s);
}

/** A bisect that traced the drop to source files a regression signal once, when it finishes (signals.ts bisectSignal). */
function fileFinding(s: BisectState): void {
  const signal = bisectSignal(s);
  if (signal) for (const line of reportSignals([signal])) console.log(fmt.muted(`signal: ${line}`));
}

export async function bisectResume(id: string): Promise<number> {
  const sim = readSimBisect(id);
  if (sim) return simBisectResume(sim);
  const s0 = readBisectState(id);
  if (!s0) throw new Error(`no bisect ${id}; ./evals bisect ls lists them`);
  const env = treeEnv(s0.surface, { out: tty, log: bisectPaths(id).log });
  const s = await runBisect(id, { surface: s0.surface }, env, { resume: true, yes: true, tmux: tmuxSession(), echo: tty });
  printState(s);
  // A bisect already done when resumed filed its signal when it finished.
  if (s0.status !== 'done') fileFinding(s);
  return exitOf(s);
}

async function bisectWatch(id: string): Promise<number> {
  let seq = 0;
  for (;;) {
    for (const step of readSteps(id, seq)) {
      console.log(`[${step.seq}] ${step.kind}${step.sha ? ` ${short(step.sha)}` : ''}: ${step.text}`);
      seq = step.seq;
    }
    const sim = readSimBisect(id);
    if (sim) {
      if (sim.status !== 'probing') {
        console.log(fmt.bold(`${sim.status}: ${simAnswerWords(sim.answer)}`));
        return simExitOf(sim);
      }
    } else {
      const s = readBisectState(id);
      if (!s) throw new Error(`no bisect ${id}`);
      if (!LIVE_STATUSES.has(s.status)) {
        console.log(fmt.bold(`${s.status}: ${answerWords(s.answer)}`));
        return exitOf(s);
      }
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
    .option('--no-render', 'skip the free dry renders (Tier 1): each candidate counts as its own class')
    .option('--sim <artifactDir>', "in place of a surface: a failing Multiplayer sim run's artifact folder, bisected by free deterministic replays (good defaults to the newest clean session that passed it)");
}

export function registerBisect(program: Command): void {
  const bisect = program.command('bisect').description('take a regression on one surface to the source change that caused it: free answers first, then a bounded replay search');
  planOptions(bisect.command('plan [surface]').description('answer from the records, render the candidates dry, and print the most a search could spend (all free)'))
    .option('--json', 'print the plan as JSON (progress goes to stderr)')
    .action(async (surface: string | undefined, flags: PlanFlags) => {
      const sim = simFlags(surface, flags);
      process.exitCode = sim ? await simBisectPlan(sim, flags) : await bisectPlan(surface!, flags);
    });
  planOptions(bisect.command('start [surface]').description('run the replay search inside its budget: controls, probes, confirmation'))
    .option('--yes', 'confirm the spend on an agent surface')
    .option('--id <id>', 'name the bisect (the Evals page names it)')
    .action(async (surface: string | undefined, flags: StartFlags) => {
      const sim = simFlags(surface, flags);
      process.exitCode = sim ? await simBisectStart(sim, flags) : await bisectStart(surface!, flags);
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
      const sim = readSimBisect(id);
      if (sim) return void (flags.json ? process.stdout.write(`${JSON.stringify(sim)}\n`) : printSimRecord(sim));
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
      const sims = listSimBisects();
      if (!all.length && !sims.length) console.log('no bisects yet: ./evals bisect plan <surface> --good <batch> --bad <batch>');
      for (const b of all) console.log(`${b.id.padEnd(36)} ${b.status.padEnd(10)} ${(b.outcome ?? '-').padEnd(12)} ${b.culprit ? short(b.culprit) : '-'.padEnd(9)}  ${formatCost(b.spentUsd)} of ${formatCost(b.budgetUsd)}  ${b.good} to ${b.bad}`);
      // Multiplayer sim bisects keep sim.json, not state.json; --json stays the eval list the Evals page reads.
      for (const r of sims) console.log(`${r.id.padEnd(36)} ${r.status.padEnd(10)} ${(r.answer?.kind ?? '-').padEnd(12)} ${r.answer?.kind === 'culprit' ? short(r.answer.commit.sha) : '-'.padEnd(9)}  free  ${short(r.plan.good.sha)} to ${short(r.plan.bad.sha)}`);
    });
}
