import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { Command } from 'commander';
import { mapLimit } from '@codecast/shared/async';
import type { CheckResult, Score } from '@platform/evals';
import { renderScore } from '@platform/evals/render';
import { renderOpts } from '@platform/cli-kit/render';

import { readAgentRun, readCallRun } from '../adapters/dryRun';
import { codecastFreezeStore } from '../adapters/freezes';
import { criteriaCheck, judgeMomentOf, rejudgeStored, storedReply } from '../adapters/judge';
import { routeGates, scoreOf } from '../adapters/replay';
import { hasSnapshot, loadSnapshot } from '../adapters/resolver';
import { surfaceRuns } from '../adapters/runs';
import { scoreVersionName, type RunJson } from '../layout';
import { homePaths } from '../paths';
import { loadSurface, surfaceMeta, surfaces } from '../registry';
import { addSpend } from '../state';
import type { AgentResult, CallResult, SurfaceImpl } from '../surface';
import { positiveNumber } from './verdict';

// `./evals grade <surface> <dir>`: grade an output dir that already exists
// (an old org round) with the surface's own grader, without replaying.
// `./evals rescore`: grade a replay rep's route gates again from the files its
// harness runs wrote, so a gate fixed after a run reaches the stored score,
// and a rep found to have run outside its world becomes a crash. With
// --rejudge it also asks today's judge again, so a run set judged before a
// judge change can be weighed on the same ruler as one judged after.

export function registerGrade(program: Command): void {
  program
    .command('grade <surface> <dir>')
    .description("grade an existing output dir with the surface's gates and checks (org-review only)")
    .option('--label <file>', 'the label JSON to grade against')
    .option('--freeze <id>', "the freeze whose labels and snapshot grade the dir (default: the one the dir's run.json names)")
    .option('--json', 'machine readable output')
    .action(async (surface: string, dir: string, flags: { label?: string; freeze?: string; json?: boolean }) => {
      const impl = await loadSurface(surface);
      if (!impl.grade) throw new Error(`${surface} has no grader for an existing dir; ./evals check ${surface} replays and grades instead`);
      if (!existsSync(dir)) throw new Error(`no dir ${dir}`);
      const label = flags.label ? JSON.parse(readFileSync(flags.label, 'utf8')) : undefined;
      const ref = flags.freeze ?? (existsSync(join(dir, 'run.json')) ? (JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as { freezeId?: string }).freezeId : undefined);
      const freeze = ref ? await codecastFreezeStore().get(ref) : null;
      if (ref && !freeze) throw new Error(`no freeze ${ref}`);
      const score = impl.grade(dir, label, freeze ?? undefined);
      if (flags.json) return console.log(JSON.stringify(score, null, 2));
      console.log(renderScore(score, renderOpts({ full: true })).join('\n'));
      if (!score.pass) process.exitCode = 1;
    });
}

const readJson = (path: string): any => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);
const exitOf = (dir: string): number => Number((existsSync(join(dir, 'exit.txt')) ? readFileSync(join(dir, 'exit.txt'), 'utf8') : '1').trim() || 1);
const numbered = (dir: string, prefix: string): string[] =>
  readdirSync(dir)
    .filter((n) => new RegExp(`^${prefix}\\d+$`).test(n))
    .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));

/** A rep's harness runs read back from its folder, as the replay held them: callN/run and agentN/agent. */
export function harnessRunsOf(runDir: string, model: string): { calls: CallResult[]; agents: AgentResult[] } {
  const calls = numbered(runDir, 'call').map((n) => readCallRun(readJson(join(runDir, n, 'request.json')), join(runDir, n, 'run'), exitOf(join(runDir, n, 'run')), 0));
  const agents = numbered(runDir, 'agent').map((n) => {
    const sub = join(runDir, n, 'agent');
    const turns = 1 + readdirSync(join(runDir, n)).filter((f) => /^then\d+\.md$/.test(f)).length;
    return readAgentRun(sub, String(readJson(join(sub, 'args.json'))?.model ?? model), turns, exitOf(sub), 0);
  });
  return { calls, agents };
}

const ROUTE_GATES = new Set(['model-as-pinned', 'ok', 'prod-budget', 'frozen-reads', 'no-unexpected-writes']);

/**
 * Grade one rep's route gates again and rewrite its score.json. The
 * surface's own gates, its checks and the judge's verdict are kept as they
 * were scored; only what routeGates reads from the harness files is redone.
 * A rep whose harness runs now read as a harness failure (dryRun.ts: the
 * model never answered, or the agent's cast reached the real CLI) becomes
 * the crash a fresh run would have recorded: no score.json, its result ended
 * `failed`, so `check --batch` runs it again. The first score is kept beside
 * it as score.before-rescore.json, and every score a rescore writes is also
 * kept as its own version, score.<stamp of its scoredAt>.json.
 *
 * `rejudge` grades the judged check again with today's judge prompt and the
 * freeze's criteria, and takes the check's floor from the freeze's tags as
 * they stand (criteriaCheck, as a fresh rep builds it): the reply its stored
 * judge prompt held, against the
 * moment judgeMomentOf renders from the freeze's snapshot today, so every rep
 * of a comparison, whichever arm it ran in, is graded against one moment. The
 * first judged score and judge run are kept beside the new ones as
 * score.before-rejudge.json and judge.before-rejudge/.
 */
export async function rescoreRun(runDir: string, opts: { rejudge?: boolean } = {}): Promise<{ before: Score; after: Score | null; crash?: string } | null> {
  const stored = readJson(join(runDir, 'score.json')) as (Score & Record<string, unknown>) | null;
  const run = readJson(join(runDir, 'run.json')) as RunJson | null;
  if (!stored || !run || run.dry) return null;
  const meta = surfaces().find((m) => basename(runDir).startsWith(`${m.id}-`));
  if (!meta) throw new Error(`${basename(runDir)} names no known surface`);
  const impl = await loadSurface(meta.id);
  const harnessRuns = harnessRunsOf(runDir, run.model);
  const keep = join(runDir, 'score.before-rescore.json');
  if (!existsSync(keep)) copyFileSync(join(runDir, 'score.json'), keep);
  const failed = [...harnessRuns.calls.map((c, i) => [`call${i + 1}`, c] as const), ...harnessRuns.agents.map((a, i) => [`agent${i + 1}`, a] as const)].find(([, r]) => r.harnessFailure);
  if (failed) {
    const crash = `${failed[0]} cannot grade the prompt: ${failed[1].harnessFailure}`;
    const result = readJson(join(runDir, 'result.json')) ?? {};
    writeFileSync(join(runDir, 'result.json'), JSON.stringify({ ...result, endedBecause: 'failed', stopReason: crash }, null, 2));
    writeFileSync(join(runDir, 'run.log'), `${crash}\n${existsSync(join(runDir, 'run.log')) ? readFileSync(join(runDir, 'run.log'), 'utf8') : ''}`);
    rmSync(join(runDir, 'score.json'));
    return { before: stored, after: null, crash };
  }
  const freeze = impl.allowedRefusals ? await codecastFreezeStore().get(run.freezeId) : null;
  const allowedHere = freeze && impl.allowedRefusals ? impl.allowedRefusals(loadSnapshot(freeze).snap) : [];
  const fresh = routeGates(meta, harnessRuns, allowedHere);
  const gates = [...fresh, ...stored.gates.filter((g) => !ROUTE_GATES.has(g.id))];
  const judged = opts.rejudge ? await rejudgeRun(runDir, impl, run.freezeId, stored) : null;
  const checks = judged ? stored.checks.map((c) => (c.id === 'criteria' ? judged.check : c)) : stored.checks;
  const judge = judged ?? (stored.judgeModel ? { costUsd: stored.judgeCostUsd ?? 0, model: stored.judgeModel } : null);
  const after = scoreOf(gates, checks, judge);
  const text = JSON.stringify({ ...after, scenario: stored.scenario, title: stored.title, seed: stored.seed }, null, 2);
  writeFileSync(join(runDir, 'score.json'), text);
  // Every rescore and rejudge is kept as its own version, so no middle one is lost to the next.
  writeFileSync(join(runDir, scoreVersionName(after.scoredAt)), text);
  return { before: stored, after };
}

/** The judged check of one rep graded again (see rescoreRun); null when the rep was never judged or its judge prompt is not one this judge can read. */
async function rejudgeRun(runDir: string, impl: SurfaceImpl, freezeId: string | undefined, stored: Score): Promise<{ check: CheckResult; costUsd: number; model: string } | null> {
  const promptPath = join(runDir, 'judge', 'prompt.md');
  if (!stored.checks.some((c) => c.id === 'criteria') || !freezeId || !existsSync(promptPath)) return null;
  const prompt = readFileSync(promptPath, 'utf8');
  const f = await codecastFreezeStore().get(freezeId);
  if (!f?.judge || !hasSnapshot(f) || !storedReply(prompt)) return null;
  const next = join(runDir, 'judge.rejudge');
  rmSync(next, { recursive: true, force: true });
  const v = await rejudgeStored(f, judgeMomentOf(impl, loadSnapshot(f).snap, f.asOf), prompt, next);
  if (!v) return null;
  addSpend(v.costUsd);
  const keep = join(runDir, 'score.before-rejudge.json');
  if (!existsSync(keep)) writeFileSync(keep, JSON.stringify(stored, null, 2));
  if (existsSync(join(runDir, 'judge.before-rejudge'))) rmSync(join(runDir, 'judge'), { recursive: true, force: true });
  else renameSync(join(runDir, 'judge'), join(runDir, 'judge.before-rejudge'));
  renameSync(next, join(runDir, 'judge'));
  return { check: criteriaCheck(f, v), costUsd: v.costUsd, model: v.model };
}

export function registerRescore(program: Command): void {
  program
    .command('rescore [runs...]')
    .description("grade replay reps' route gates again from their harness files and rewrite score.json (a gate fixed after the run)")
    .option('--batch <id>', "every rep of this check's run set")
    .option('--surface <id>', 'with --batch: only this surface')
    .option('--rejudge', "also grade the judged check again with today's judge and moment, on the reply each rep's judge saw (spends a judge call per rep)")
    .option('--parallel <n>', 'reps graded at once', positiveNumber('--parallel', true), 1)
    .action(async (ids: string[], flags: { batch?: string; surface?: string; rejudge?: boolean; parallel: number }) => {
      const root = homePaths().runs;
      const names = ids.map((id) => basename(id));
      if (flags.batch) {
        const metas = flags.surface ? [surfaceMeta(flags.surface)].filter((m) => m != null) : surfaces();
        for (const m of metas) for (const r of await surfaceRuns(m.id)) if (r.batch === flags.batch) names.push(r.id);
      }
      if (!names.length) throw new Error('name the reps to rescore, or --batch <id>');
      let changed = 0;
      const criteria = (sc: Score) => sc.checks.find((c) => c.id === 'criteria')?.score;
      // A rep whose judge call fails keeps the score it had; the rest still run.
      const results = await mapLimit(names, flags.parallel, (name) => rescoreRun(join(root, name), { rejudge: flags.rejudge }).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))));
      let errors = 0;
      names.forEach((name, i) => {
        const r = results[i];
        if (r instanceof Error) {
          errors++;
          console.log(`${name}  unchanged: ${r.message}`);
          return;
        }
        if (!r) {
          console.log(`${name}  skipped: no score (a stop, a crash or a dry rep)`);
          return;
        }
        const failed = (s: Score) => s.gates.filter((g) => !g.pass).map((g) => g.id).join(',') || 'none';
        if (!r.after || r.before.score !== r.after.score || r.before.pass !== r.after.pass) changed++;
        const judged = flags.rejudge && r.after && criteria(r.before) != null ? `  judged ${criteria(r.before)!.toFixed(2)} -> ${criteria(r.after)!.toFixed(2)}` : '';
        if (!r.after) console.log(`${name}  ${r.before.score.toFixed(3)} -> crash  ${r.crash}`);
        else console.log(`${name}  ${r.before.score.toFixed(3)} -> ${r.after.score.toFixed(3)}  ${r.after.pass ? 'pass' : 'fail'}  gates failed: ${failed(r.before)} -> ${failed(r.after)}${judged}`);
      });
      console.log(`${names.length - errors} rep(s) graded again, ${changed} changed${errors ? `, ${errors} left as they were (run them again by name)` : ''}`);
      if (errors) process.exitCode = 1;
    });
}
