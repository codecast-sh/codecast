import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Command } from 'commander';
import { fmt } from '@platform/cli-kit/colors';
import type { EvalSources, Freeze } from '@platform/evals';
import { separate, type Separation } from '@platform/evals/analysis';
import { UsageError } from '@platform/evals/cli';

import { freezeMeta, hasSnapshot, loadLabel, loadSnapshot } from '../adapters/resolver';
import {
  applyEdits,
  baselineProblem,
  batchReps,
  checkBatch,
  GUIDANCE_SOURCES,
  GuidanceSources,
  guidanceSha,
  batchRuns,
  inWorktree,
  missingReps,
  objective,
  overBudget,
  priorWeighings,
  proposeEdits,
  readSources,
  recordAttempt,
  renderNow,
  scoredRuns,
  spentOn,
  tally,
  type CaseView,
  type RepView,
} from '../corrections/climb';
import { loadCorrections } from '../corrections/store';
import { homePaths } from '../paths';
import type { GuidanceLabel, GuidanceSnap } from '../surfaces/guidance';

// `./evals climb guidance`: the corrections' freezes are the bar and the other
// guidance freezes are the guards. A share of the corrections is held out,
// pinned on each correction when it is frozen (store.ts splitFor): the
// rewriter never reads them and the rounds never replay them, so the
// final measure on them says whether the rewrite generalizes or only learned
// the cases it read. A baseline at full reps, rounds of rewrite and replay on
// the training share, keeping only what scores better by a margin, then the
// best tree at full reps. The claim is the held-out corrections separated
// better and the guards not worse, each weighed on its own, over complete
// batches; anything less is reported as no claim.

const pct = (x: number): string => `${Math.round(x * 100)}%`;

function tallyLine(reps: RepView[], names: Map<string, string>): string {
  return tally(reps)
    .map((t) => `    ${t.passed}/${t.reps}  ${t.mean.toFixed(2)}  ${t.freeze.slice(0, 8)} ${fmt.muted(names.get(t.freeze) ?? '')}`)
    .join('\n');
}

/** Each freeze's passes in the baseline and the final, side by side, so a verdict over a subset never hides the case that moved. */
function pairLines(base: RepView[], final: RepView[], ids: string[], names: Map<string, string>): string {
  const of = (rs: RepView[], id: string) => tally(rs.filter((r) => r.freeze === id))[0];
  return ids
    .map((id) => {
      const [b, f] = [of(base, id), of(final, id)];
      const moved = b && f && b.passed !== f.passed ? (f.passed > b.passed ? '  up' : '  DOWN') : '';
      return `    ${b ? `${b.passed}/${b.reps}` : '-'} → ${f ? `${f.passed}/${f.reps}` : '-'}  ${id.slice(0, 8)} ${fmt.muted(names.get(id) ?? '')}${moved}`;
    })
    .join('\n');
}

const sepText = (s: Separation): string => (s.kind === 'better' || s.kind === 'worse' ? `separated: ${s.kind} (p=${s.p.toFixed(4)})` : s.kind === 'too-few' ? 'too few samples to separate' : 'not separated');

/** One subset of the final weighed against the same subset of the baseline, with check's own test. */
function weigh(final: RepView[], base: RepView[], ids: string[]): { s: Separation; from: number; to: number } {
  const of = (rs: RepView[]) => rs.filter((r) => ids.includes(r.freeze)).map((r) => r.score);
  const [cur, prev] = [of(final), of(base)];
  return { s: separate(cur, prev), from: prev.reduce((a, b) => a + b, 0) / (prev.length || 1), to: cur.reduce((a, b) => a + b, 0) / (cur.length || 1) };
}

export function registerClimb(program: Command, sources: EvalSources): void {
  program
    .command('climb <surface>')
    .description('rewrite the prompt until the freezes corrections became pass, holding some out and keeping every other freeze as a guard; guidance only')
    .option('--freeze <id>', 'the correction freezes (repeatable, prefix ok); default every freeze tagged correction', (v: string, all: string[]) => [...all, v], [] as string[])
    .option('--rounds <n>', 'rewrite rounds at most', (v) => Number(v), 4)
    .option('--reps <n>', 'reps per training freeze in a round', (v) => Number(v), 3)
    .option('--final-reps <n>', 'reps per freeze in the baseline and the final check', (v) => Number(v), 8)
    .option('--margin <x>', "how much a round must raise the training freezes' mean score to be kept, against draw noise", (v) => Number(v), 0.02)
    .option('--max-usd <usd>', 'the whole climb’s spend: baseline, rounds, rewriter and final', (v) => Number(v), 250)
    .option('--baseline <batch>', 'a complete check of every freeze at --final-reps on the unedited guidance, used instead of running one')
    .option('--propose', 'one rewrite from the --baseline batch, printed and saved as a patch, never replayed: read it before spending on a climb')
    .action(async (surface: string, flags) => {
      if (surface !== 'guidance') throw new UsageError('climb edits the guidance only: ./evals climb guidance');
      if (!flags.propose && !inWorktree()) throw new UsageError('climb rewrites the guidance in place: run it from a worktree of its own, never the shared main checkout');
      const all = (await sources.freezes!.list()).filter((f) => freezeMeta(f).surface === 'guidance' && hasSnapshot(f));
      const corrections = flags.freeze.length ? all.filter((f) => flags.freeze.some((p: string) => f.id.startsWith(p))) : all.filter((f) => f.tags?.includes('correction'));
      if (!corrections.length) throw new UsageError('no correction freezes here: ./evals corrections find, then ./evals corrections freeze');
      const guards = all.filter((f) => !corrections.includes(f));
      // The split is pinned on each correction when it is frozen, never decided here, so no climb can hold out a freeze an earlier one trained on.
      const splitOf = new Map(loadCorrections().filter((c) => c.freezeId).map((c) => [c.freezeId!, c.split]));
      const unpinned = corrections.filter((f) => !splitOf.get(f.id));
      if (unpinned.length) throw new UsageError(`${unpinned.length} correction freeze(s) have no pinned split (${unpinned.map((f) => f.id.slice(0, 8)).join(', ')}): ./evals corrections freeze pins it when it freezes`);
      const train = corrections.filter((f) => splitOf.get(f.id) === 'train');
      const heldOut = corrections.filter((f) => splitOf.get(f.id) === 'held-out');
      if (!train.length) throw new UsageError('no correction freeze is pinned to train: the rewriter would have nothing to read');
      const names = new Map(all.map((f) => [f.id, f.name]));
      const ids = (fs: Freeze[]) => fs.map((f) => f.id);
      const everyId = [...ids(corrections), ...ids(guards)];
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dir = join(homePaths().root, 'climb', stamp);
      mkdirSync(dir, { recursive: true });
      const tree = new GuidanceSources(readSources());
      writeFileSync(join(dir, 'original.json'), JSON.stringify(tree.original));
      writeFileSync(join(dir, 'split.json'), JSON.stringify({ train: ids(train), heldOut: ids(heldOut), guards: ids(guards) }, null, 1));
      const start = renderNow();
      console.log(`climbing guidance: ${train.length} correction freeze(s) to train on, ${heldOut.length} held out, ${guards.length} guard(s); record in ${dir}`);
      const prior = priorWeighings(ids(heldOut));
      if (prior.length) console.log(fmt.warning(`these held-out freezes were already weighed by ${prior.length} earlier climb(s), ${prior.filter((a) => a.claim).length} of them a claim: each climb is one more draw at the same test (EVALS_HOME/climb/attempts.jsonl)`));
      const attempt = (final: string | null, claim: boolean, why: string) => recordAttempt({ stamp, base, final, train: ids(train), heldOut: ids(heldOut), claim, why });

      let spent = 0;
      const room = () => Math.max(0, flags.maxUsd - spent);
      const run = async (fs: string[], batch: string, reps: number, extra: string[] = []) => {
        if (room() <= 0) return { complete: false, runs: [] as Awaited<ReturnType<typeof scoredRuns>> };
        checkBatch(fs, batch, reps, ['--budget', room().toFixed(2), ...extra]);
        spent += spentOn(await batchRuns(batch));
        const runs = await scoredRuns(batch);
        const missing = missingReps(runs, fs, reps);
        if (missing.length) console.log(fmt.warning(`batch ${batch} is incomplete (${missing.length} freeze(s) short of ${reps} reps): it is no claim`));
        return { complete: missing.length === 0, runs };
      };

      const base = flags.baseline ?? `climb-${stamp}-base`;
      if (flags.baseline) {
        const problem = baselineProblem(await scoredRuns(base), everyId, flags.finalReps, guidanceSha(start.text));
        if (problem) throw new UsageError(`--baseline ${base} ${problem}`);
      } else {
        console.log(fmt.bold(`\nbaseline: every guidance freeze at ${flags.finalReps} reps, batch ${base}`));
        if (!(await run(everyId, base, flags.finalReps)).complete) {
          console.log(`\nthe baseline is incomplete: no climb. The record: ${dir}`);
          attempt(null, false, 'baseline incomplete');
          return;
        }
      }
      const baseAll = await batchReps(base);
      const baseTrain = baseAll.filter((r) => train.some((t) => t.id === r.freeze));
      console.log(`\nbaseline on the training corrections: ${pct(objective(baseTrain))}\n${tallyLine(baseTrain, names)}`);

      const caseOf = (reps: RepView[]): CaseView[] =>
        train.map((f) => {
          const snap = loadSnapshot(f).snap as GuidanceSnap;
          const label = (loadLabel(f) ?? { want: [] }) as GuidanceLabel;
          return { freeze: f, request: snap.request, want: label.want ?? [], avoid: label.avoid ?? [], reps: reps.filter((r) => r.freeze === f.id) };
        });

      if (flags.propose) {
        if (!flags.baseline) throw new UsageError('--propose rewrites from a recorded batch: name it with --baseline <batch>');
        const proposal = await proposeEdits({ guidance: start, cases: caseOf(baseTrain), history: [], dir: join(dir, 'propose', 'rewriter') });
        const { files, refused } = applyEdits(tree.original, proposal.edits);
        writeFileSync(join(dir, 'proposal.json'), JSON.stringify({ ...proposal, refused }, null, 2));
        // The patch is made in a scratch copy of the sources' text, so the tree is never touched.
        const patch = GUIDANCE_SOURCES.map((p) => diffOf(p, tree.original[p]!, files[p]!)).join('');
        writeFileSync(join(dir, 'proposal.patch'), patch);
        console.log(`\n${proposal.diagnosis}\n\n${patch}\n${proposal.edits.length - refused.length} edit(s)${refused.length ? `; refused: ${refused.map((r) => r.why.split(':')[0]).join('; ')}` : ''}. Not measured, and not in the tree: git apply ${join(dir, 'proposal.patch')}, then a climb or a check weighs it.`);
        return;
      }
      if (baseTrain.every((r) => r.pass)) {
        console.log('\nevery training correction passes on the guidance as it stands: the miss is not in this prompt (docs/prompting.md P9 step 2). Nothing to climb.');
        attempt(null, false, 'every training correction already passes');
        return;
      }

      // Whatever stops the climb, the guidance goes back to how it was found unless a measured rewrite is left on purpose.
      let keep = false;
      const restore = () => {
        try {
          tree.restore();
        } catch (e) {
          console.log(fmt.error(`left the guidance as it is: ${(e as Error).message}`));
        }
      };
      const onSignal = () => {
        restore();
        process.exit(130);
      };
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
      try {
        let best = { round: 0, score: objective(baseTrain), reps: baseTrain, files: tree.original };
        const history: string[] = [];
        for (let round = 1; round <= flags.rounds && room() > 0; round++) {
          const roundDir = join(dir, `round-${round}`);
          const proposal = await proposeEdits({ guidance: renderNow(), cases: caseOf(best.reps), history, dir: join(roundDir, 'rewriter') });
          spent += proposal.costUsd;
          const { files, refused } = applyEdits(best.files, proposal.edits);
          writeFileSync(join(roundDir, 'proposal.json'), JSON.stringify({ ...proposal, refused }, null, 2));
          console.log(fmt.bold(`\nround ${round}: ${proposal.edits.length - refused.length} edit(s)${refused.length ? `, ${refused.length} refused` : ''}`));
          console.log(fmt.muted(proposal.diagnosis.split('\n').map((l) => `  ${l}`).join('\n')));
          for (const r of refused) history.push(`round ${round}, refused: "${r.edit.find.slice(0, 120)}": ${r.why}`);
          if (refused.length === proposal.edits.length) continue;
          tree.write(files);
          const over = overBudget(renderNow(), start);
          if (over) {
            tree.write(best.files);
            history.push(`round ${round}, refused before replay: ${over}`);
            console.log(`round ${round}: refused before replay, ${over}`);
            continue;
          }
          const batch = `climb-${stamp}-r${round}`;
          const { complete } = await run(ids(train), batch, flags.reps, ['--against', base]);
          const reps = (await batchReps(batch)).filter((r) => train.some((t) => t.id === r.freeze));
          const score = objective(reps);
          const kept = complete && score >= best.score + flags.margin;
          const applied = proposal.edits.filter((e) => !refused.some((r) => r.edit === e));
          history.push(`round ${round}, ${kept ? 'kept' : 'reverted'} (training corrections ${pct(best.score)} → ${pct(score)}${complete ? '' : ', incomplete'}): ${applied.map((e) => JSON.stringify(e.replace.slice(0, 300))).join(' ; ')}`);
          console.log(`round ${round}: training corrections ${pct(score)} (best ${pct(best.score)}, kept at +${pct(flags.margin)}${complete ? '' : ', incomplete'}), ${kept ? 'kept' : 'reverted'}\n${tallyLine(reps, names)}`);
          if (kept) best = { round, score, reps, files };
          else tree.write(best.files);
          if (kept && reps.every((r) => r.pass)) break;
        }
        writeFileSync(join(dir, 'history.txt'), history.join('\n'));
        if (best.round === 0) {
          console.log(`\nno round beat the baseline; the guidance is as it was. Spent $${spent.toFixed(2)}. The record: ${dir}`);
          attempt(null, false, 'no round beat the baseline');
          return;
        }

        const final = `climb-${stamp}-final`;
        console.log(fmt.bold(`\nfinal: the round ${best.round} guidance on every freeze at ${flags.finalReps} reps, weighed against ${base}`));
        const { complete } = await run(everyId, final, flags.finalReps, ['--against', base]);
        const finalAll = await batchReps(final);
        const held = weigh(finalAll, baseAll, ids(heldOut));
        const guard = weigh(finalAll, baseAll, ids(guards));
        const trained = weigh(finalAll, baseAll, ids(train));
        console.log(`\n  held out  ${pct(held.from)} → ${pct(held.to)}  ${sepText(held.s)}`);
        console.log(`  guards    ${pct(guard.from)} → ${pct(guard.to)}  ${sepText(guard.s)}\n${pairLines(baseAll, finalAll, ids(guards), names)}`);
        console.log(`  trained   ${pct(trained.from)} → ${pct(trained.to)}  ${sepText(trained.s)}  (the rewriter read these: no claim)`);
        console.log(`\nheld out, base → final\n${pairLines(baseAll, finalAll, ids(heldOut), names)}`);
        const claim = complete && held.s.kind === 'better' && guard.s.kind !== 'worse';
        const why = claim ? 'held-out better, guards not worse' : !complete ? 'final incomplete' : held.s.kind !== 'better' ? 'held-out not better' : 'guards worse';
        writeFileSync(join(dir, 'verdict.json'), JSON.stringify({ base, final, complete, heldOut: held, guards: guard, trained, claim, why, spentUsd: spent }, null, 2));
        attempt(final, claim, why);
        console.log(
          claim
            ? fmt.success(`\nclaim: the held-out corrections separated better and the guards are not worse. The guidance in this tree is the round ${best.round} rewrite (git diff ${GUIDANCE_SOURCES.join(' ')}).`)
            : fmt.warning(`\nno claim: ${!complete ? 'the final is incomplete' : held.s.kind !== 'better' ? 'the held-out corrections did not separate better' : 'the guards are worse'}. The guidance in this tree is the round ${best.round} rewrite, left for reading; the record is ${dir}.`),
        );
        console.log(`Spent $${spent.toFixed(2)} of $${flags.maxUsd}. Next: read the diff, then UPDATE_GOLDEN=1 bun test src/install.golden.test.ts in packages/cli.`);
        keep = true;
      } finally {
        if (!keep) restore();
      }
    });
}

/** A unified diff of one source file's text, made outside the tree. */
function diffOf(path: string, before: string, after: string): string {
  if (before === after) return '';
  const tmp = join(homePaths().scratch, 'climb-diff', `${Date.now()}`);
  mkdirSync(join(tmp, 'a'), { recursive: true });
  mkdirSync(join(tmp, 'b'), { recursive: true });
  writeFileSync(join(tmp, 'a', 'f'), before);
  writeFileSync(join(tmp, 'b', 'f'), after);
  const out = spawnSync('git', ['diff', '--no-index', '--', 'a/f', 'b/f'], { cwd: tmp, encoding: 'utf8' }).stdout;
  return out.replaceAll('a/f', `a/${path}`).replaceAll('b/f', `b/${path}`);
}
