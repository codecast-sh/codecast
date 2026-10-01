import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Command } from 'commander';

import { redactSecrets } from '../../../cli/src/secretRedaction';
import { homePaths } from '../paths';
import { surfaceMeta } from '../registry';
import { fillArgv, servedReadKey, writeFrozenVerbs, writeServedRead } from '../served';
import { gitHead } from '../state';

// `./evals snapshot <surface> --team T [--name n]`: captures the world an
// agent surface reads into EVALS_HOME/snapshots/<surface>/<name>, so a replay
// is answered from a record and never from a moving workspace. Each read in
// meta.frozenReads runs once through the real `cast`; the guard serves it back
// by the same key (served.ts). Everything is redacted and made read-only.

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
  const aliases = (meta.servedAliases ?? []).map((a) => ({ serve: fillArgv(a.serve, values), from: servedReadKey(fillArgv(a.from, values)) }));
  mkdirSync(join(dir, 'reads'), { recursive: true });
  const captured: string[][] = [];
  for (const argv of reads) {
    const { out, code } = run(argv);
    const text = redactSecrets(out);
    writeServedRead(dir, argv, text, code);
    for (const alias of aliases.filter((a) => a.from === servedReadKey(argv))) writeServedRead(dir, alias.serve, text, code);
    const legacy = legacyFile(argv);
    if (legacy) writeFileSync(join(dir, legacy), text);
    captured.push(argv);
    console.log(`${code === 0 ? 'captured' : `captured (exit ${code})`}  cast ${argv.join(' ')}`);
  }
  writeFrozenVerbs(dir, meta.frozenVerbs ?? []);
  writeFileSync(join(dir, 'captured.json'), JSON.stringify({ argv: captured, values, captured_at: new Date().toISOString(), gitHead: gitHead() }, null, 2));
  lockSnapshot(dir);
  console.log(`\n${dir}\nSaved as ${surface}/${name}. Next: a freeze that uses it (./evals freeze create ${surface}@ prints the ref forms)`);
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
}
