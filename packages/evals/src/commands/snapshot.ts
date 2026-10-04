import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Command } from 'commander';

import { redactSecrets } from '../../../cli/src/secretRedaction';
import { homePaths } from '../paths';
import { surfaceMeta } from '../registry';
import { EVERY_READ, fillAliases, fillArgv, readFrozenVerbs, servedReadKey, writeCut, writeFrozenVerbs, writeServedRead } from '../served';
import type { SurfaceMeta } from '../surface';
import { gitHead } from '../state';

// `./evals snapshot <surface> --team T [--name n]`: captures the world an
// agent surface reads into EVALS_HOME/snapshots/<surface>/<name>, so a replay
// is answered from a record and never from a moving workspace. Each read in
// meta.frozenReads runs once through the real `cast`; the guard serves it back
// by the same key (served.ts). Everything is redacted and made read-only.
// A surface with meta.cut also captures the records those reads name, freezes
// every other read and pins git history at the capture (cutSnapshot).

/** The legacy names the guard has always served org reads from (old served/ dirs keep working). */
export const LEGACY: Array<[string, string]> = [
  ['org inputs', 'org-inputs.json'],
  ['org health', 'org-health.json'],
  ['org ls', 'org-ls.json'],
];

/** The legacy file a read is also kept under, if it is one of LEGACY's. */
export const legacyFile = (argv: string[]): string | undefined => LEGACY.find(([w]) => argv.slice(0, 2).join(' ') === w)?.[1];

/** Makes every file of a snapshot read-only, so a run cannot rewrite the record it is graded on. */
export function lockSnapshot(dir: string): void {
  for (const entry of new Bun.Glob('**/*').scanSync({ cwd: dir, onlyFiles: true })) chmodSync(join(dir, entry), 0o444);
}

export function parseValues(args: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('--')) throw new Error(`snapshot takes --key value pairs, not "${a}"`);
    const eq = a.indexOf('=');
    if (eq > 0) values[a.slice(2, eq)] = a.slice(eq + 1);
    else values[a.slice(2)] = args[++i] ?? '';
  }
  return values;
}

export function runSnapshot(surface: string, args: string[], run: (argv: string[]) => { out: string; code: number } = liveCast): string {
  const meta = surfaceMeta(surface);
  if (!meta) throw new Error(`no surface ${surface}`);
  if (!meta.frozenReads?.length) throw new Error(`${surface} reads nothing through cast: snapshot is for the agent surfaces`);
  const values = parseValues(args);
  const name = values.name || `${values.team ?? surface}-${new Date().toISOString().slice(0, 10)}`;
  const dir = join(homePaths().snapshots, surface, name);
  if (existsSync(dir)) throw new Error(`${dir} exists; snapshots are immutable, pick another --name`);
  // Every placeholder is checked before anything runs, so a missing flag leaves no half snapshot.
  const reads = meta.frozenReads.map((template) => fillArgv(template, values));
  const aliases = fillAliases(meta.servedAliases, values).map((a) => ({ serve: a.serve, from: servedReadKey(a.from) }));
  mkdirSync(join(dir, 'reads'), { recursive: true });
  const capturedAt = new Date().toISOString();
  const captured: Array<{ argv: string[]; out: string }> = [];
  for (const argv of reads) {
    const { out, code } = run(argv);
    const text = redactSecrets(out);
    writeServedRead(dir, argv, text, code);
    for (const alias of aliases.filter((a) => a.from === servedReadKey(argv))) writeServedRead(dir, alias.serve, text, code);
    const legacy = legacyFile(argv);
    if (legacy) writeFileSync(join(dir, legacy), text);
    captured.push({ argv, out: text });
    console.log(`${code === 0 ? 'captured' : `captured (exit ${code})`}  cast ${argv.join(' ')}`);
  }
  const follow = meta.cut?.follow(captured) ?? [];
  for (const f of follow) {
    const { out, code } = run(f.argv);
    writeServedRead(dir, f.argv, redactSecrets(out), code, { prefix: f.prefix });
  }
  if (follow.length) console.log(`captured ${follow.length} record reads the org reads name`);
  writeFrozenVerbs(dir, meta.frozenVerbs ?? []);
  writeFileSync(join(dir, 'captured.json'), JSON.stringify({ argv: captured.map((c) => c.argv), followed: follow.length, values, captured_at: capturedAt, gitHead: gitHead() }, null, 2));
  cutSnapshot(dir, meta, captured, { at: capturedAt });
  lockSnapshot(dir);
  console.log(`\n${dir}\nSaved as ${surface}/${name}. Next: a freeze that uses it (./evals freeze create ${surface}@ prints the ref forms)`);
  return dir;
}

/** The commit a repository's default branch stands at: now, or with `before`, its last first-parent commit before then. */
export function pinRoot(root: string, before?: string): string | null {
  const git = (...args: string[]) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (git('rev-parse', '--git-dir').status !== 0) return null;
  const head = git('symbolic-ref', '-q', 'refs/remotes/origin/HEAD').stdout.trim() || ['refs/remotes/origin/main', 'refs/remotes/origin/master', 'HEAD'].find((r) => git('rev-parse', '-q', '--verify', r).status === 0)!;
  const r = before ? git('rev-list', '-1', '--first-parent', `--before=@${Math.floor(Date.parse(before) / 1000)}`, head) : git('rev-parse', head);
  return r.stdout.trim() || null;
}

/**
 * Makes a snapshot the world at `at` (meta.cut): every read it does not hold
 * is frozen, and git history is cut there, each local root the capture names
 * pinned (now, or for a snapshot captured before cuts existed, at its last
 * commit before `at`). No-op for a surface without a cut.
 */
export function cutSnapshot(dir: string, meta: Pick<SurfaceMeta, 'cut' | 'frozenVerbs'>, captured: Array<{ argv: string[]; out: string }>, o: { at: string; derive?: boolean }): void {
  if (!meta.cut) return;
  const pins: Record<string, string> = {};
  for (const root of meta.cut.gitRoots(captured)) {
    const sha = existsSync(root) ? pinRoot(root, o.derive ? o.at : undefined) : null;
    if (sha) pins[root] = sha;
  }
  writeFrozenVerbs(dir, [...new Set([...(meta.frozenVerbs ?? []), ...readFrozenVerbs(dir), EVERY_READ])]);
  writeCut(dir, { at: o.at, pins });
}

/** `./evals snapshot-cut <surface> <name...>`: cuts a snapshot captured before cuts existed at its own capture time; the reads it lacks stay refused. */
export function backfillCut(surface: string, name: string): string {
  const meta = surfaceMeta(surface);
  if (!meta?.cut) throw new Error(`${surface} has no cut: only a surface with meta.cut stands at its capture`);
  const dir = join(homePaths().snapshots, surface, name);
  const info = JSON.parse(readFileSync(join(dir, 'captured.json'), 'utf8')) as { argv?: string[][]; captured_at?: string };
  if (!info.captured_at) throw new Error(`${dir}/captured.json has no captured_at to cut at`);
  const captured = (info.argv ?? []).map((argv) => ({ argv, out: readFileSync(join(dir, 'reads', `${servedReadKey(argv)}.out`), 'utf8') }));
  for (const f of ['frozen', 'cut']) if (existsSync(join(dir, f))) chmodSync(join(dir, f), 0o644);
  cutSnapshot(dir, meta, captured, { at: info.captured_at, derive: true });
  lockSnapshot(dir);
  return dir;
}

function liveCast(argv: string[]): { out: string; code: number } {
  const r = spawnSync('cast', argv, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { out: r.stdout ?? '', code: r.status ?? 1 };
}

export function registerSnapshot(program: Command): void {
  program
    .command('snapshot <surface> [args...]')
    .description("capture the world an agent surface reads (--team T, --trigger tr-N, --name n) into EVALS_HOME/snapshots, read-only")
    .allowUnknownOption()
    .action((surface: string, args: string[]) => {
      runSnapshot(surface, args);
    });
  program
    .command('snapshot-cut <surface> <names...>')
    .description('cut snapshots captured before cuts existed at their capture: freeze every read they lack and pin git history there')
    .action((surface: string, names: string[]) => {
      for (const name of names) {
        const dir = backfillCut(surface, name);
        console.log(`${dir}\n${readFileSync(join(dir, 'cut'), 'utf8')}`);
      }
    });
}
