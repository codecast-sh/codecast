import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
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

/** The first words (or "w1 w2") the guard refuses to read live when no capture answers them. */
export function writeFrozenVerbs(dir: string, verbs: string[]): void {
  writeFileSync(join(dir, 'frozen'), `${verbs.join('\n')}\n`);
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
