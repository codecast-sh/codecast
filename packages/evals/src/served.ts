import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The key a served read is filed under: sha256 over each argument followed
 * by \x1f. The guard (packages/cli/scripts/prompt-dry-run-bin/cast) computes
 * the same with `printf '%s\x1f' "$@" | shasum -a 256`, so a read `snapshot`
 * captured is the read a replay is answered with.
 */
export function servedReadKey(argv: string[]): string {
  return createHash('sha256')
    .update(argv.map((a) => `${a}\x1f`).join(''))
    .digest('hex');
}

/** Files one read in a served dir where the guard looks for it: reads/<key>.out, and its exit code beside it. */
export function writeServedRead(dir: string, argv: string[], out: string, code: number): void {
  const key = servedReadKey(argv);
  mkdirSync(join(dir, 'reads'), { recursive: true });
  writeFileSync(join(dir, 'reads', `${key}.out`), out);
  writeFileSync(join(dir, 'reads', `${key}.exit`), `${code}\n`);
}

/** The `frozen` line that freezes every read: a synthetic world answers from its record or not at all. */
export const EVERY_READ = '*';

/** The first words (or "w1 w2") the guard refuses to read live when no capture answers them; EVERY_READ freezes all. */
export function writeFrozenVerbs(dir: string, verbs: string[]): void {
  writeFileSync(join(dir, 'frozen'), `${verbs.join('\n')}\n`);
}

/** What writeFrozenVerbs filed in a served dir. */
export function readFrozenVerbs(dir: string): string[] {
  const path = join(dir, 'frozen');
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];
}

/**
 * A surface's served aliases with their placeholders filled: each `serve`
 * argv answers with what its `from` argv captured. A capture needs every
 * value (fillArgv throws); a fixture seat skips the aliases it has no value
 * for (a workspace agent has no role, so its bare `cast brief` is its own).
 */
export function fillAliases(aliases: Array<{ serve: string[]; from: string[] }> | undefined, values: Record<string, string>, opts: { skipUnfilled?: boolean } = {}): Array<{ serve: string[]; from: string[] }> {
  const filled = (t: string[]) => t.every((part) => [...part.matchAll(/\{(\w+)\}/g)].every((m) => values[m[1]!] !== undefined));
  return (aliases ?? []).filter((a) => !opts.skipUnfilled || (filled(a.serve) && filled(a.from))).map((a) => ({ serve: fillArgv(a.serve, values), from: fillArgv(a.from, values) }));
}

/** An argv template with its {placeholders} filled; a missing value is an error naming it. */
export function fillArgv(template: string[], values: Record<string, string>): string[] {
  return template.map((part) =>
    part.replace(/\{(\w+)\}/g, (_, k: string) => {
      const v = values[k];
      if (v === undefined) throw new Error(`--${k} is required: the read ${template.join(' ')} names {${k}}`);
      return v;
    }),
  );
}
