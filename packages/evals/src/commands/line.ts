import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import type { Command } from 'commander';
import type { EvalSources, Freeze, RunSummary } from '@platform/evals';
import { fmt } from '@platform/cli-kit/colors';
import { formatCost } from '@platform/cli-kit/format';
import type { EvalRep, EvalRepsFile, EvalRepsFreeze, EvalRepsSide, EvalRepsSurface } from '@codecast/shared/contracts/evalResult';

import { describeFreeze, hasSnapshot } from '../adapters/resolver';
import { repPassed } from '../adapters/replay';
import { codecastRunSource, surfaceRuns } from '../adapters/runs';
import { homePaths, REPO_ROOT, treeRoot } from '../paths';
import { REPLAY_INPUTS } from '../provenance';
import { surfaces } from '../registry';
import { changedSince, dirtySurfaces, gitHead, mergeBase } from '../state';
import { buildEvalResult, evalResultLines } from '../evalResult';
import type { SurfaceMeta } from '../surface';
import { runCheck } from './check';
import { positiveNumber, scoreOrZero } from './verdict';
import { pickSurfaces } from './stale';

// `./evals line`: the line's eval station (design LE8). It names the surfaces
// a branch touches since it left --base, runs `check` on each twice (once in
// a detached worktree at the merge base, once in this tree), writes the reps
// as reps.json (line-profile.md LP4, the file every project's eval writes),
// and builds eval-result.json from it with buildEvalResult, the builder
// `cast line eval-result` runs for every other project: per surface the
// separation of the branch's scores from the base's, the gates that failed,
// whether the proven freezes now pass, and the freezes whose verdict flipped
// with both replies. A touched surface with
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
  repsOut?: string;
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
 * keeps the base's prod module, or the base's surface module, when the base
 * exports every value it takes from it, and otherwise reads this checkout's
 * copy, so a helper the tool gained since the base cannot crash the base run
 * (today's `label` command reads orgReview's grade module, which older
 * commits lack parts of; today's index reads `@codecast/shared/contracts/
 * evalsApi`, which they lack whole). A package import is followed the way bun
 * resolves it in the tree, so it needs the tree's node_modules in place
 * (borrowNodeModules): an installed package is this checkout's install either
 * way and stays, a workspace package is the commit's copy and is held to the
 * same rule as a relative helper. Surface adapters are never touched: the
 * prod code they reach is what the base run measures. Returns the imports it
 * pointed back here.
 */
export function pinMissingImports(pkg: string, wt: string, own: string): string[] {
  const scanner = new Bun.Transpiler({ loader: 'ts' });
  // Real paths throughout: bun resolves a package import to one, and the tree's node_modules links lead out of the tree.
  const tree = realpathSync(wt);
  const here = realpathSync(own);
  const tool = join(tree, relative(wt, pkg));
  const src = join(tool, 'src');
  const surfaces = join(src, 'surfaces');
  const inside = (dir: string, p: string) => !relative(dir, p).startsWith('..');
  // The file an import leads to from a folder: a relative one by path, a package one as bun resolves it there.
  const lead = (spec: string, dir: string): string | undefined => {
    if (spec.startsWith('.')) return tsFile(resolve(dir, spec));
    try {
      return Bun.resolveSync(spec, dir);
    } catch {
      return undefined;
    }
  };
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return p === surfaces ? [] : walk(p);
      return e.name.endsWith('.ts') ? [p] : [];
    });
  const pinned: string[] = [];
  for (const file of walk(src)) {
    const text = readFileSync(file, 'utf8');
    const next = text.replace(/(import|export)\s*\{([^}]*)\}\s*from\s*'([^']+)'/g, (whole, _kw: string, names: string, spec: string) => {
      const values = names.split(',').map((n) => n.trim()).filter((n) => n && !n.startsWith('type ')).map((n) => n.split(/\s+as\s+/)[0]!);
      // Bun drops an import of types alone, so it never loads.
      if (!values.length) return whole;
      const target = lead(spec, dirname(file));
      // Tool files read each other as they are, and an installed package is this checkout's; a surface module or a workspace package is the commit's, so a tool import of it can come up short.
      if (target && (!inside(tree, target) || (inside(tool, target) && !inside(surfaces, target)))) return whole;
      if (target && values.every((v) => scanner.scan(readFileSync(target, 'utf8')).exports.includes(v))) return whole;
      const ours = lead(spec, join(here, relative(tree, dirname(file))));
      if (!ours) return whole;
      pinned.push(`${relative(tool, file)}: ${relative(here, ours)}`);
      return whole.replace(`'${spec}'`, `'${ours}'`);
    });
    if (next !== text) writeFileSync(file, next);
  }
  return pinned;
}

/** A tree prepareTreeAt made: the worktree, and the root its `check` runs from. */
export interface TreeAt {
  wt: string;
  /** The root `check` runs from: the worktree, or this checkout when a test points the tree at a scratch repo. */
  tool: string;
}

/**
 * A detached worktree at `sha` under EVALS_HOME/scratch, and the root its
 * `check` runs from: the line's base side and every bisect probe. The eval
 * tool and the freezes are this tree's, so every tree grades alike and sees
 * the same moments; a surface adapter the commit already had stays the
 * commit's, since it is part of what the change moves. node_modules are
 * borrowed. With `patch`, a dirty rep's edits are applied on top (git apply,
 * the replayed moments left out: they are this tree's). When a test points
 * the tree at a scratch repo, the tool runs from this checkout against it,
 * as every other command does there.
 */
export function prepareTreeAt(sha: string, o: { patch?: string; prefix?: string } = {}): TreeAt {
  mkdirSync(homePaths().scratch, { recursive: true });
  const wt = mkdtempSync(join(homePaths().scratch, o.prefix ?? 'line-base-'));
  try {
    git(treeRoot(), ['worktree', 'add', '--detach', '-f', wt, sha]);
    const pkg = join(wt, 'packages', 'evals');
    for (const part of ['freezes', 'fixtures']) {
      const from = join(treeRoot(), 'packages', 'evals', part);
      if (existsSync(from)) cpSync(from, join(pkg, part), { recursive: true, force: true });
    }
    const applyPatch = () => {
      if (o.patch) git(wt, ['apply', '--whitespace=nowarn', ...REPLAY_INPUTS.map((p) => `--exclude=${p}/*`), o.patch]);
    };
    if (resolve(treeRoot()) !== resolve(REPO_ROOT)) {
      applyPatch();
      return { wt, tool: REPO_ROOT };
    }
    const own = join(REPO_ROOT, 'packages', 'evals');
    for (const part of ['src', 'package.json', 'tsconfig.json']) if (existsSync(join(own, part))) cpSync(join(own, part), join(pkg, part), { recursive: true, force: true });
    if (git(wt, ['ls-tree', sha, '--', 'packages/evals/src/surfaces']).trim()) git(wt, ['checkout', sha, '--', 'packages/evals/src/surfaces']);
    // The patch lands on the commit's own surfaces and prod code, which is what it was taken against.
    applyPatch();
    // Borrowed first: the pin follows package imports through the tree's node_modules.
    borrowNodeModules(REPO_ROOT, wt);
    const pinned = pinMissingImports(pkg, wt, REPO_ROOT);
    if (pinned.length) console.log(fmt.muted(`${sha.slice(0, 9)} lacks helpers the eval tool uses; read from this checkout: ${pinned.join(', ')}`));
    return { wt, tool: wt };
  } catch (e) {
    dropBaseTree(wt);
    throw e;
  }
}

/**
 * Give a worktree this checkout's installed packages without reading this
 * checkout's own code. Each package's node_modules (the root's, packages/*,
 * platform/packages/*) becomes a real folder of links to this checkout's
 * entries, except a workspace link (`@codecast/convex`, `@platform/evals`: an
 * entry that resolves inside this checkout but outside any node_modules),
 * which points at the same package inside the worktree when the commit has
 * it. Linking the whole folder would hand every import of `@codecast/*` the
 * checkout's working copy, so a tree at an old commit would run today's
 * convex and shared code, other sessions' unsaved edits included.
 */
export function borrowNodeModules(root: string, wt: string): void {
  const realRoot = realpathSync(root);
  const own = (entry: string): string => {
    try {
      const real = realpathSync(entry);
      const rel = relative(realRoot, real);
      if (rel.startsWith('..') || rel.split(sep).includes('node_modules')) return entry;
      return existsSync(join(wt, rel)) ? join(wt, rel) : entry;
    } catch {
      return entry;
    }
  };
  const borrow = (rel: string) => {
    const from = join(root, rel, 'node_modules');
    const to = join(wt, rel, 'node_modules');
    if (!existsSync(from) || !existsSync(join(wt, rel)) || existsSync(to)) return;
    mkdirSync(to);
    for (const name of readdirSync(from)) {
      if (!name.startsWith('@')) {
        symlinkSync(own(join(from, name)), join(to, name));
        continue;
      }
      mkdirSync(join(to, name));
      for (const sub of readdirSync(join(from, name))) symlinkSync(own(join(from, name, sub)), join(to, name, sub));
    }
  };
  borrow('.');
  for (const dir of ['packages', 'platform/packages']) if (existsSync(join(root, dir))) for (const name of readdirSync(join(root, dir))) borrow(join(dir, name));
}

/**
 * Which surfaces a tree can load at all, before its `check` runs: an adapter
 * that needs a prod seam the commit lacks would otherwise take every surface
 * in the batch down with it. Returns the load error per surface that failed.
 */
export function baseLoadErrors(wt: string, tool: string, ids: string[]): Map<string, string> {
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

/** Remove a tree prepareTreeAt made, and its worktree entry. */
export function dropBaseTree(wt: string): void {
  try {
    git(treeRoot(), ['worktree', 'remove', '--force', wt]);
  } catch {
    rmSync(wt, { recursive: true, force: true });
    spawnSync('git', ['worktree', 'prune'], { cwd: treeRoot() });
  }
}

/** What a `check` run in a prepared tree is told. It never moves the cadence state: the tree is not the checkout. */
export interface TreeCheck {
  reps?: number;
  model?: string;
  budget?: number;
  dry?: boolean;
  notes: string;
  freeze?: string[];
  cadence?: string;
  stopFile?: string;
  maxMinutes?: number;
}

/** The `check` argv for a prepared tree (after the tool's index.ts). */
export const checkArgs = (ids: string[], batch: string, o: TreeCheck): string[] => [
  'check',
  ...ids,
  '--batch',
  batch,
  '--no-state',
  ...(o.freeze ?? []).flatMap((f) => ['--freeze', f]),
  ...(o.reps != null ? ['--reps', String(o.reps)] : []),
  ...(o.model ? ['--model', o.model] : []),
  ...(o.budget != null ? ['--budget', String(o.budget)] : []),
  ...(o.dry ? ['--dry'] : []),
  ...(o.cadence ? ['--cadence', o.cadence] : []),
  ...(o.stopFile ? ['--stop-file', o.stopFile] : []),
  ...(o.maxMinutes != null ? ['--max-minutes', String(o.maxMinutes)] : []),
  '--notes',
  o.notes,
];

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One scored run as a reps.json rep: its verdict, its reply, and the judge's note (or the failed gates). */
async function repOf(r: RunSummary, runs: ReturnType<typeof codecastRunSource>): Promise<EvalRep> {
  const d = await runs.get(r.id).catch(() => null);
  const verdict = d?.verdict;
  const gates = verdict?.gates.filter((g) => !g.pass).map((g) => `${g.id}: ${g.evidence.summary}`).join('; ');
  const judged = verdict?.checks.find((c) => c.id === 'criteria')?.reasoning;
  return {
    passed: repPassed(r),
    score: scoreOrZero(r),
    reply: clip(d?.messages.filter((m) => m.direction === 'out').map((m) => m.text).join('\n\n') || d?.error || '', 4000),
    judge_note: clip(gates || judged || (verdict ? `score ${verdict.score.toFixed(2)}` : ''), 1000),
    cost_usd: r.costUsd,
    ...(r.status === 'crash' ? { error: clip(d?.error || 'crashed', 1000) } : {}),
    ...(r.gatesFailed.length ? { gates_failed: r.gatesFailed } : {}),
  };
}

/**
 * One surface's reps from the two run sets in EVALS_HOME, in the reps.json
 * shape every project's eval writes (line-profile.md LP4). The verdict is
 * buildEvalResult's, the same for codecast as for any project.
 */
export async function repsSurface(meta: SurfaceMeta, freezes: Freeze[], proven: Freeze[], batches: { base: string; branch: string }, shas: { base: string; head: string }, baseFailure?: string): Promise<EvalRepsSurface> {
  const all = await surfaceRuns(meta.id);
  const runs = codecastRunSource();
  const of = (batch: string, id: string) => all.filter((r) => r.batch === batch && r.status !== 'unscored' && r.freezeId === id);
  const side = async (batch: string, sha: string, rs: RunSummary[]): Promise<EvalRepsSide | null> => (rs.length ? { batch, sha, reps: await Promise.all(rs.map((r) => repOf(r, runs))) } : null);
  const out: EvalRepsFreeze[] = [];
  for (const f of freezes) {
    const isProven = proven.some((p) => p.id === f.id);
    const base = of(batches.base, f.id);
    const branch = of(batches.branch, f.id);
    if (!base.length && !branch.length && !isProven) continue;
    const moment = await describeFreeze(f).catch(() => null);
    out.push({
      freeze: f.id,
      name: f.name,
      kind: isProven ? 'miss' : 'guard',
      proven: isProven,
      input: clip(moment?.filter((m) => m.direction === 'in').pop()?.text ?? '', 1500),
      base: await side(batches.base, shas.base, base),
      branch: await side(batches.branch, shas.head, branch),
    });
  }
  return { surface: meta.id, title: meta.title, route: null, freezes: out, ...(baseFailure ? { base_failure: baseFailure } : {}) };
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
  const repsOut = resolve(flags.repsOut ?? join(dirname(out), 'reps.json'));
  const repsFile: EvalRepsFile = {
    version: 1,
    base: { ref: flags.base, sha },
    head: { sha: gitHead(), dirty: dirtySurfaces(metas).size > 0 },
    created_at: stamp,
    dry: Boolean(flags.dry),
    reps: flags.reps ?? Math.max(0, ...metas.map((m) => m.reps.check)),
    surfaces: [],
    gates_failed: [],
    gate: null,
    cost_usd: 0,
  };

  const baseFailure = new Map<string, string>();
  if (ids.length) {
    console.log(fmt.bold(`base ${flags.base} (${sha.slice(0, 9)}): ${ids.join(', ')}`));
    const { wt, tool } = prepareTreeAt(sha);
    try {
      for (const [id, err] of baseLoadErrors(wt, tool, ids)) baseFailure.set(id, `the base cannot load the ${id} adapter: ${err}`);
      for (const why of baseFailure.values()) console.log(fmt.warning(why));
      const ready = ids.filter((id) => !baseFailure.has(id));
      if (ready.length) {
        const r = spawnSync('bun', [join(tool, 'packages', 'evals', 'src', 'index.ts'), ...checkArgs(ready, batches.base, { reps: flags.reps, model: flags.model, budget: flags.budget, dry: flags.dry, notes: 'line base run' })], { cwd: wt, stdio: 'inherit', env: { ...process.env, CODECAST_EVALS_REPO_ROOT: wt } });
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
    console.log(fmt.bold(`\nbranch (${repsFile.head.sha.slice(0, 9)}${repsFile.head.dirty ? ', with the checkout' : ''}): ${ids.join(', ')}`));
    await runCheck(ids, { reps: flags.reps, model: flags.model, budget: flags.budget, dry: flags.dry, batch: batches.branch, state: false, notes: 'line branch run' }, sources);
  }
  for (const meta of metas) {
    const why = skipped.get(meta.id);
    repsFile.surfaces.push(
      why
        ? { surface: meta.id, title: meta.title, route: null, freezes: [], skipped: why }
        : await repsSurface(meta, freezesOf(meta.id), proven, batches, { base: sha, head: repsFile.head.sha }, baseFailure.get(meta.id)),
    );
  }
  repsFile.cost_usd = repsFile.surfaces.flatMap((s) => s.freezes).flatMap((f) => [...(f.base?.reps ?? []), ...(f.branch?.reps ?? [])]).reduce((a, r) => a + r.cost_usd, 0);
  writeFileSync(repsOut, `${JSON.stringify(repsFile, null, 2)}\n`);
  const result = buildEvalResult(repsFile);
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);

  console.log('');
  if (!metas.length) console.log(`no surface's sources differ from ${flags.base}; nothing to run`);
  for (const l of evalResultLines(result, { ok: fmt.success, fail: fmt.error, skip: fmt.warning })) console.log(l);
  console.log(`\n${result.ok ? 'pass' : 'fail'}  ${formatCost(result.costUsd)}  wrote ${out} (reps ${repsOut})`);
  return result.ok ? 0 : 1;
}

export function registerLine(program: Command, sources: EvalSources): void {
  program
    .command('line')
    .description('the line eval station: check the surfaces a branch touches on its base and on the branch, write eval-result.json')
    .requiredOption('--base <ref>', 'the branch point, e.g. origin/main (its merge base with HEAD is used)')
    .option('--surfaces <ids>', 'comma separated (default: the surfaces whose sources differ from the base)')
    .option('--freeze <id>', 'a proven freeze, failing on the base, that must pass on the branch (repeatable, prefix ok)', (v: string, all: string[]) => [...all, v], [] as string[])
    .option('--reps <n>', 'reps per freeze per side (default: the surface meta)', positiveNumber('--reps', true))
    .option('--model <id>', 'ablate the model under test on both sides')
    .option('--budget <usd>', 'per side, as check', positiveNumber('--budget'))
    .option('--out <file>', 'where to write the result', 'eval-result.json')
    .option('--reps-out <file>', 'where to write the reps the result is built from (default: reps.json beside --out)')
    .option('--dry', 'canned model output on both sides: proves the wiring, spends nothing')
    .action(async (flags: LineFlags) => {
      process.exitCode = await runLine(flags, sources);
    });
}
