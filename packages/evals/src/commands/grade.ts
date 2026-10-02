import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { Command } from 'commander';
import type { Score } from '@platform/evals';
import { renderScore } from '@platform/evals/render';
import { renderOpts } from '@platform/cli-kit/render';

import { readAgentRun, readCallRun } from '../adapters/dryRun';
import { codecastFreezeStore } from '../adapters/freezes';
import { routeGates, scoreOf } from '../adapters/replay';
import { loadSnapshot } from '../adapters/resolver';
import { surfaceRuns } from '../adapters/runs';
import type { RunJson } from '../layout';
import { homePaths } from '../paths';
import { loadSurface, surfaceMeta, surfaces } from '../registry';
import type { AgentResult, CallResult } from '../surface';

// `./evals grade <surface> <dir>`: grade an output dir that already exists
// (an old org round) with the surface's own grader, without replaying.
// `./evals rescore`: grade a replay rep's route gates again from the files its
// harness runs wrote, so a gate fixed after a run reaches the stored score.

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
 * The first score is kept beside it as score.before-rescore.json.
 */
export async function rescoreRun(runDir: string): Promise<{ before: Score; after: Score } | null> {
  const stored = readJson(join(runDir, 'score.json')) as (Score & Record<string, unknown>) | null;
  const run = readJson(join(runDir, 'run.json')) as RunJson | null;
  if (!stored || !run || run.dry) return null;
  const meta = surfaces().find((m) => basename(runDir).startsWith(`${m.id}-`));
  if (!meta) throw new Error(`${basename(runDir)} names no known surface`);
  const impl = await loadSurface(meta.id);
  const freeze = impl.allowedRefusals ? await codecastFreezeStore().get(run.freezeId) : null;
  const allowedHere = freeze && impl.allowedRefusals ? impl.allowedRefusals(loadSnapshot(freeze).snap) : [];
  const fresh = routeGates(meta, harnessRunsOf(runDir, run.model), allowedHere);
  const gates = [...fresh, ...stored.gates.filter((g) => !ROUTE_GATES.has(g.id))];
  const after = scoreOf(gates, stored.checks, stored.judgeModel ? { costUsd: stored.judgeCostUsd ?? 0, model: stored.judgeModel } : null);
  const keep = join(runDir, 'score.before-rescore.json');
  if (!existsSync(keep)) copyFileSync(join(runDir, 'score.json'), keep);
  writeFileSync(join(runDir, 'score.json'), JSON.stringify({ ...after, scenario: stored.scenario, title: stored.title, seed: stored.seed }, null, 2));
  return { before: stored, after };
}

export function registerRescore(program: Command): void {
  program
    .command('rescore [runs...]')
    .description("grade replay reps' route gates again from their harness files and rewrite score.json (a gate fixed after the run)")
    .option('--batch <id>', "every rep of this check's run set")
    .option('--surface <id>', 'with --batch: only this surface')
    .action(async (ids: string[], flags: { batch?: string; surface?: string }) => {
      const root = homePaths().runs;
      const names = ids.map((id) => basename(id));
      if (flags.batch) {
        const metas = flags.surface ? [surfaceMeta(flags.surface)].filter((m) => m != null) : surfaces();
        for (const m of metas) for (const r of await surfaceRuns(m.id)) if (r.batch === flags.batch) names.push(r.id);
      }
      if (!names.length) throw new Error('name the reps to rescore, or --batch <id>');
      let changed = 0;
      for (const name of names) {
        const r = await rescoreRun(join(root, name));
        if (!r) {
          console.log(`${name}  skipped: no score (a stop or a dry rep)`);
          continue;
        }
        const failed = (s: Score) => s.gates.filter((g) => !g.pass).map((g) => g.id).join(',') || 'none';
        if (r.before.score !== r.after.score || r.before.pass !== r.after.pass) changed++;
        console.log(`${name}  ${r.before.score.toFixed(3)} -> ${r.after.score.toFixed(3)}  ${r.after.pass ? 'pass' : 'fail'}  gates failed: ${failed(r.before)} -> ${failed(r.after)}`);
      }
      console.log(`${names.length} rep(s) graded again, ${changed} changed`);
    });
}
