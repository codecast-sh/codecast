import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import type { Command } from 'commander';
import type { EvalSources, Freeze, RunSummary } from '@platform/evals';
import { fmt } from '@platform/cli-kit/colors';
import { formatCost } from '@platform/cli-kit/format';
import type { EvalFlip, EvalResult, EvalRunSet, EvalSurfaceResult } from '@codecast/shared/contracts/evalResult';

import { describeFreeze, hasSnapshot } from '../adapters/resolver';
import { codecastRunSource, surfaceRuns } from '../adapters/runs';
import { homePaths, REPO_ROOT, treeRoot } from '../paths';
import { surfaces } from '../registry';
import { changedSince, dirtySurfaces, gitHead, mergeBase } from '../state';
import { median, separate } from '../stats';
import type { SurfaceMeta } from '../surface';
import { majority, runCheck, scoreOrZero } from './check';
import { pickSurfaces } from './stale';

// `./evals line`: the line's eval station (design LE8). It names the surfaces
// a branch touches since it left --base, runs `check` on each twice (once in
// a detached worktree at the merge base, once in this tree), and writes
// eval-result.json: per surface the separation of the branch's scores from
// the base's, the gates that failed, whether the proven freezes now pass, and
// the freezes whose verdict flipped with both replies. A touched surface with
// no freeze to replay is skipped, and says so: there is nothing to measure it
// by. Exit 0 only when every proven freeze passes, no gate fails, nothing
// crashed and nothing separates worse.

export interface LineFlags {
  base: string;
  surfaces?: string;
  freeze?: string[];
  reps?: number;
  model?: string;
  budget?: number;
  out?: string;
  dry?: boolean;
}

const surfaceOf = (f: Freeze): string => String((f.meta as { surface?: string } | undefined)?.surface ?? '');
const git = (cwd: string, args: string[]): string => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${(r.stderr || '').trim()}`);
  return r.stdout;
};

/**
 * Which surfaces to run: the ones named, else the ones the branch touches,
 * plus the surface of every proven freeze, which must run whatever moved.
 */
export function lineSurfaces(base: string, named: string[], proven: Freeze[], root = treeRoot()): SurfaceMeta[] {
  const picked = named.length ? pickSurfaces(named) : changedSince(surfaces(), base, root).changed;
  const extra = proven.map(surfaceOf).filter((id) => !picked.some((m) => m.id === id));
  return [...picked, ...(extra.length ? pickSurfaces([...new Set(extra)]) : [])];
}

const tsFile = (p: string): string | undefined => [`${p}.ts`, p, join(p, 'index.ts')].find((c) => existsSync(c) && statSync(c).isFile());

/**
 * In the base worktree, a tool file (anything under src but src/surfaces)
 * keeps the base's prod module when the base exports every value it takes
 * from it, and otherwise reads this checkout's copy, so a helper the tool
 * gained since the base cannot crash the base run. Surface adapters are never
 * touched: the prod code they reach is what the base run measures. Returns
 * the imports it pointed back here.
 */
export function pinMissingImports(pkg: string, wt: string, own: string): string[] {
  const scanner = new Bun.Transpiler({ loader: 'ts' });
  const src = join(pkg, 'src');
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return p === join(src, 'surfaces') ? [] : walk(p);
      return e.name.endsWith('.ts') ? [p] : [];
    });
  const pinned: string[] = [];
  for (const file of walk(src)) {
    const text = readFileSync(file, 'utf8');
    const next = text.replace(/(import|export)\s*\{([^}]*)\}\s*from\s*'(\.[^']*)'/g, (whole, _kw: string, names: string, spec: string) => {
      const at = resolve(dirname(file), spec);
      if (!relative(pkg, at).startsWith('..')) return whole;
      const values = names.split(',').map((n) => n.trim()).filter((n) => n && !n.startsWith('type ')).map((n) => n.split(/\s+as\s+/)[0]!);
      const target = tsFile(at);
      if (target && values.every((v) => scanner.scan(readFileSync(target, 'utf8')).exports.includes(v))) return whole;
      const ours = tsFile(join(own, relative(wt, at)));
      if (!ours) return whole;
      pinned.push(`${relative(pkg, file)}: ${relative(own, ours)}`);
      return whole.replace(`'${spec}'`, `'${ours}'`);
    });
    if (next !== text) writeFileSync(file, next);
  }
  return pinned;
}

/**
 * The base side: a detached worktree at the merge base, and the root its
 * `check` runs from. The eval tool and the freezes are this tree's on both
 * sides, so the two runs grade alike and see the same moments; a surface
 * adapter the base already had stays the base's, since it is part of what the
 * change moves. node_modules are borrowed. When a test points the tree at a
 * scratch repo, the tool runs from this checkout against it, as every other
 * command does there.
 */
function prepareBaseTree(sha: string): { wt: string; tool: string } {
  mkdirSync(homePaths().scratch, { recursive: true });
  const wt = mkdtempSync(join(homePaths().scratch, 'line-base-'));
  git(treeRoot(), ['worktree', 'add', '--detach', '-f', wt, sha]);
  const pkg = join(wt, 'packages', 'evals');
  for (const part of ['freezes', 'fixtures']) {
    const from = join(treeRoot(), 'packages', 'evals', part);
    if (existsSync(from)) cpSync(from, join(pkg, part), { recursive: true, force: true });
  }
  if (resolve(treeRoot()) !== resolve(REPO_ROOT)) return { wt, tool: REPO_ROOT };
  const own = join(REPO_ROOT, 'packages', 'evals');
  for (const part of ['src', 'package.json', 'tsconfig.json']) if (existsSync(join(own, part))) cpSync(join(own, part), join(pkg, part), { recursive: true, force: true });
  if (git(wt, ['ls-tree', sha, '--', 'packages/evals/src/surfaces']).trim()) git(wt, ['checkout', sha, '--', 'packages/evals/src/surfaces']);
  const pinned = pinMissingImports(pkg, wt, REPO_ROOT);
  if (pinned.length) console.log(fmt.muted(`the base lacks helpers the eval tool uses; read from this checkout: ${pinned.join(', ')}`));
  const borrow = (rel: string) => {
    const from = join(REPO_ROOT, rel, 'node_modules');
    const to = join(wt, rel, 'node_modules');
    if (existsSync(from) && existsSync(join(wt, rel)) && !existsSync(to)) symlinkSync(from, to);
  };
  borrow('.');
  for (const dir of ['packages', 'platform/packages']) if (existsSync(join(REPO_ROOT, dir))) for (const name of readdirSync(join(REPO_ROOT, dir))) borrow(join(dir, name));
  return { wt, tool: wt };
}

/**
 * Which surfaces the base can load at all, before its `check` runs: an adapter
 * that needs a prod seam the base lacks would otherwise take every surface in
 * the batch down with it. Returns the load error per surface that failed.
 */
function baseLoadErrors(wt: string, tool: string, ids: string[]): Map<string, string> {
  const registry = join(tool, 'packages', 'evals', 'src', 'registry.ts');
  const script = `const { loadSurface } = await import(${JSON.stringify(registry)}); const out = {}; for (const id of process.env.LINE_IDS.split(',')) { try { await loadSurface(id); } catch (e) { out[id] = String(e?.message ?? e).split('\\n')[0]; } } console.log(JSON.stringify(out));`;
  const r = spawnSync('bun', ['-e', script], { cwd: wt, encoding: 'utf8', env: { ...process.env, CODECAST_EVALS_REPO_ROOT: wt, LINE_IDS: ids.join(',') } });
  const tidy = (msg: string) => msg.split(`${wt}/`).join('');
  try {
    return new Map(Object.entries(JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as Record<string, string>).map(([id, msg]) => [id, tidy(msg)]));
  } catch {
    const why = tidy((r.stderr || r.stdout || `exit ${r.status}`).trim().split('\n').find(Boolean) ?? `exit ${r.status}`);
    return new Map(ids.map((id) => [id, why]));
  }
}

function dropBaseTree(wt: string): void {
  try {
    git(treeRoot(), ['worktree', 'remove', '--force', wt]);
  } catch {
    rmSync(wt, { recursive: true, force: true });
    spawnSync('git', ['worktree', 'prune'], { cwd: treeRoot() });
  }
}

const checkArgs = (ids: string[], batch: string, flags: LineFlags): string[] => [
  'check',
  ...ids,
  '--batch',
  batch,
  '--no-state',
  ...(flags.reps != null ? ['--reps', String(flags.reps)] : []),
  ...(flags.model ? ['--model', flags.model] : []),
  ...(flags.budget != null ? ['--budget', String(flags.budget)] : []),
  ...(flags.dry ? ['--dry'] : []),
  '--notes',
  'line base run',
];

function runSet(batch: string, runs: RunSummary[]): EvalRunSet | null {
  if (!runs.length) return null;
  const scores = runs.map(scoreOrZero);
  return { batch, reps: runs.length, passed: runs.filter((r) => r.status === 'pass').length, median: median(scores), mean: scores.reduce((s, x) => s + x, 0) / scores.length, costUsd: runs.reduce((s, r) => s + r.costUsd, 0) };
}

const clip = (s: string, n = 600): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What the reader needs to see a flip: the moment, one reply from each side with the verdict it got, and why. */
async function flipOf(f: Freeze, direction: EvalFlip['direction'], base: RunSummary[], branch: RunSummary[]): Promise<EvalFlip> {
  const runs = codecastRunSource();
  // A representative rep per side: one whose verdict matches that side's majority.
  const pick = (rs: RunSummary[], pass: boolean) => rs.find((r) => (r.status === 'pass') === pass) ?? rs[0];
  const [before, after] = await Promise.all([pick(base, direction === 'broke'), pick(branch, direction === 'fixed')].map((r) => (r ? runs.get(r.id) : null)));
  const replyOf = (d: typeof before) => clip(d?.messages.filter((m) => m.direction === 'out').map((m) => m.text).join('\n\n') || d?.error || '(no reply)');
  const moment = await describeFreeze(f).catch(() => null);
  const lastIn = moment?.filter((m) => m.direction === 'in').pop()?.text;
  const verdict = after?.verdict;
  const judged = verdict?.checks.find((c) => c.id === 'criteria')?.reasoning;
  const gates = verdict?.gates.filter((g) => !g.pass).map((g) => `${g.id}: ${g.evidence.summary}`).join('; ');
  return {
    freeze: f.id,
    name: f.name,
    direction,
    input: clip(lastIn ? `${f.name}: ${lastIn}` : f.name, 400),
    before: replyOf(before),
    after: replyOf(after),
    note: clip(gates || judged || (verdict ? `score ${verdict.score.toFixed(2)}` : 'no verdict'), 400),
  };
}

/** Base against branch for one surface, from the two run sets in EVALS_HOME. */
export async function compareSurface(meta: SurfaceMeta, freezes: Freeze[], proven: Freeze[], batches: { base: string; branch: string }, baseFailure?: string): Promise<EvalSurfaceResult> {
  const all = await surfaceRuns(meta.id);
  const of = (batch: string) => all.filter((r) => r.batch === batch && r.status !== 'unscored');
  const base = of(batches.base);
  const branch = of(batches.branch);
  const sep = separate(branch.map(scoreOrZero), base.map(scoreOrZero));
  const before = majority(base);
  const after = majority(branch);
  const flips: EvalFlip[] = [];
  for (const f of freezes) {
    const a = before.get(f.id);
    const b = after.get(f.id);
    if (a === undefined || b === undefined || a === b) continue;
    flips.push(await flipOf(f, b ? 'fixed' : 'broke', base.filter((r) => r.freezeId === f.id), branch.filter((r) => r.freezeId === f.id)));
  }
  const gatesFailed = [...new Set(branch.flatMap((r) => r.gatesFailed))];
  const crashes = branch.filter((r) => r.status === 'crash').length;
  const provenHere = proven.filter((f) => surfaceOf(f) === meta.id).map((f) => ({ freeze: f.id, passes: after.get(f.id) === true }));
  const reasons = [
    // Without a base run set nothing can be called worse and no miss was shown: fail closed.
    ...(base.length ? [] : [baseFailure ?? 'no base reps were scored']),
    ...(branch.length ? [] : ['no branch reps were scored']),
    ...provenHere.filter((p) => !p.passes).map((p) => `proven freeze ${p.freeze.slice(0, 8)} still fails`),
    ...(gatesFailed.length ? [`gates failed: ${gatesFailed.join(', ')}`] : []),
    ...(crashes ? [`${crashes} rep(s) crashed`] : []),
    ...(sep.kind === 'worse' ? [`separated worse than the base (p=${sep.p.toFixed(4)})`] : []),
  ];
  return {
    surface: meta.id,
    title: meta.title,
    separation: sep.kind,
    p: 'p' in sep ? sep.p : null,
    base: runSet(batches.base, base),
    branch: runSet(batches.branch, branch),
    gatesFailed,
    crashes,
    proven: provenHere,
    flips,
    ok: reasons.length === 0,
    reasons,
  };
}

export async function runLine(flags: LineFlags, sources: EvalSources): Promise<number> {
  const store = sources.freezes!;
  const all = await store.list();
  const proven = (flags.freeze ?? []).map((p) => {
    const hits = all.filter((f) => f.id.startsWith(p));
    if (hits.length !== 1) throw new Error(`--freeze ${p} matches ${hits.length} freezes`);
    return hits[0]!;
  });
  const named = (flags.surfaces ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const sha = mergeBase(flags.base);
  const metas = lineSurfaces(flags.base, named, proven);
  const freezesOf = (id: string) => all.filter((f) => surfaceOf(f) === id);
  // Nothing to replay, nothing to measure by: the surface is skipped, visibly,
  // rather than failed forever. A proven freeze always runs, snapshot or not.
  const skipped = new Map(
    metas
      .filter((m) => !proven.some((f) => surfaceOf(f) === m.id) && !freezesOf(m.id).some(hasSnapshot))
      .map((m) => {
        const away = freezesOf(m.id).length;
        return [m.id, `no freezes to replay${away ? ` (${away} here lack their snapshot)` : ''}; make one with ./evals freeze create ${m.id}@<ref>`];
      }),
  );
  const ids = metas.map((m) => m.id).filter((id) => !skipped.has(id));
  const stamp = new Date().toISOString();
  const batches = { base: `${stamp}~line-base`, branch: `${stamp}~line-branch` };
  const out = resolve(flags.out ?? 'eval-result.json');
  const result: EvalResult = {
    version: 1,
    base: { ref: flags.base, sha },
    head: { sha: gitHead(), dirty: dirtySurfaces(metas).size > 0 },
    createdAt: stamp,
    dry: Boolean(flags.dry),
    reps: flags.reps ?? Math.max(0, ...metas.map((m) => m.reps.check)),
    surfaces: [],
    ok: true,
    costUsd: 0,
  };

  const baseFailure = new Map<string, string>();
  if (ids.length) {
    console.log(fmt.bold(`base ${flags.base} (${sha.slice(0, 9)}): ${ids.join(', ')}`));
    const { wt, tool } = prepareBaseTree(sha);
    try {
      for (const [id, err] of baseLoadErrors(wt, tool, ids)) baseFailure.set(id, `the base cannot load the ${id} adapter: ${err}`);
      for (const why of baseFailure.values()) console.log(fmt.warning(why));
      const ready = ids.filter((id) => !baseFailure.has(id));
      if (ready.length) {
        const r = spawnSync('bun', [join(tool, 'packages', 'evals', 'src', 'index.ts'), ...checkArgs(ready, batches.base, flags)], { cwd: wt, stdio: 'inherit', env: { ...process.env, CODECAST_EVALS_REPO_ROOT: wt } });
        if (r.status !== 0) {
          const exit = r.status ?? r.signal ?? r.error?.message;
          const scored = new Map(await Promise.all(ready.map(async (id) => [id, (await surfaceRuns(id)).filter((x) => x.batch === batches.base && x.status !== 'unscored').length] as const)));
          const total = [...scored.values()].reduce((a, b) => a + b, 0);
          // check exits 1 on a scored fail too; only a surface left without reps means the process died.
          for (const [id, n] of scored) if (!n) baseFailure.set(id, `the base check crashed (exit ${exit}) before scoring a ${id} rep; no base to compare with`);
          console.log(
            total
              ? fmt.muted(`the base check exited ${exit} after scoring ${total} rep(s); a scored fail on a proven freeze is the miss the branch must fix`)
              : fmt.error(`the base check crashed (exit ${exit}) before scoring any rep; no base reps, see its output above`),
          );
        }
      }
    } finally {
      dropBaseTree(wt);
    }
    console.log(fmt.bold(`\nbranch (${result.head.sha.slice(0, 9)}${result.head.dirty ? ', with the checkout' : ''}): ${ids.join(', ')}`));
    await runCheck(ids, { reps: flags.reps, model: flags.model, budget: flags.budget, dry: flags.dry, batch: batches.branch, state: false, notes: 'line branch run' }, sources);
  }
  for (const meta of metas) {
    const why = skipped.get(meta.id);
    result.surfaces.push(
      why
        ? { surface: meta.id, title: meta.title, separation: 'too-few', p: null, base: null, branch: null, gatesFailed: [], crashes: 0, proven: [], flips: [], ok: true, reasons: [], skipped: why }
        : await compareSurface(meta, freezesOf(meta.id), proven, batches, baseFailure.get(meta.id)),
    );
  }
  result.ok = result.surfaces.every((s) => s.ok);
  result.costUsd = result.surfaces.reduce((s, x) => s + (x.base?.costUsd ?? 0) + (x.branch?.costUsd ?? 0), 0);
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);

  console.log('');
  if (!metas.length) console.log(`no surface's sources differ from ${flags.base}; nothing to run`);
  for (const s of result.surfaces) {
    if (s.skipped) {
      console.log(`${fmt.warning('skip')} ${s.surface}  ${s.skipped}`);
      continue;
    }
    const sep = s.separation === 'too-few' ? 'too few reps to separate' : `${s.separation}${s.p != null ? ` (p=${s.p.toFixed(4)})` : ''}`;
    console.log(`${s.ok ? fmt.success('ok  ') : fmt.error('FAIL')} ${s.surface}  ${sep}  medians ${s.base?.median?.toFixed(2) ?? '-'} -> ${s.branch?.median?.toFixed(2) ?? '-'}  flips ${s.flips.length}`);
    for (const r of s.reasons) console.log(`       ${r}`);
  }
  console.log(`\n${result.ok ? 'pass' : 'fail'}  ${formatCost(result.costUsd)}  wrote ${out}`);
  return result.ok ? 0 : 1;
}

export function registerLine(program: Command, sources: EvalSources): void {
  program
    .command('line')
    .description('the line eval station: check the surfaces a branch touches on its base and on the branch, write eval-result.json')
    .requiredOption('--base <ref>', 'the branch point, e.g. origin/main (its merge base with HEAD is used)')
    .option('--surfaces <ids>', 'comma separated (default: the surfaces whose sources differ from the base)')
    .option('--freeze <id>', 'a proven freeze, failing on the base, that must pass on the branch (repeatable, prefix ok)', (v: string, all: string[]) => [...all, v], [] as string[])
    .option('--reps <n>', 'reps per freeze per side (default: the surface meta)', (v) => Number(v))
    .option('--model <id>', 'ablate the model under test on both sides')
    .option('--budget <usd>', 'per side, as check', (v) => Number(v))
    .option('--out <file>', 'where to write the result', 'eval-result.json')
    .option('--dry', 'canned model output on both sides: proves the wiring, spends nothing')
    .action(async (flags: LineFlags) => {
      process.exitCode = await runLine(flags, sources);
    });
}
