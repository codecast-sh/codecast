import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { legacyFile, lockSnapshot } from '../../commands/snapshot';
import { commitLabels } from '../../labels';
import { homePaths } from '../../paths';
import { fillArgv, writeFrozenVerbs, writeServedRead } from '../../served';
import { ORG_EVAL_CACHE, roleHandles, tryJson } from './grade';
import { meta } from './meta';

// The one-time move of the org loop's data out of ~/.cache/org-eval, copy
// only (the archive stays untouched). Per workspace: the hand labels go to
// EVALS_HOME/labels/org-review/<ws>/ with handle-pool.json beside them (every
// role handle any old round proposed or any old served roster held: grade.py's
// phantom pool, which the old rounds no longer carry here), and the newest
// base served dir becomes the snapshot <ws>-<served> in the layout `./evals
// snapshot` writes, read-only. The labels repo is committed and pushed after.
//
//   bun packages/evals/src/surfaces/orgReview/migrate.ts [--no-commit]

/** The served dir each workspace's freeze replays: the base its latest full round ran on. */
export const MIGRATE: Array<{ ws: string; served: string }> = [
  { ws: 'union', served: 'base8' },
  { ws: 'codecast', served: 'base3' },
];
const LABEL_FILE = /^(grade-sets\.json|ground-truth\.md|sample30-labels\..+|extra-labels\.json|final-fixes\.md)$/;

/** Subdirs as Python's glob `*` sees them: no dot entries. */
const dirs = (p: string): string[] => (existsSync(p) ? readdirSync(p).filter((n) => !n.startsWith('.') && statSync(join(p, n)).isDirectory()) : []);

/** grade.py's pool for one workspace: round-*\/*\/proposal.json role changes and served/*\/org-inputs.json rosters. */
export function historicalPool(wsRoot: string): string[] {
  const pool = new Set<string>();
  for (const round of dirs(wsRoot).filter((n) => n.startsWith('round-'))) {
    for (const s of dirs(join(wsRoot, round))) for (const h of roleHandles(tryJson(join(wsRoot, round, s, 'proposal.json')))) pool.add(h);
  }
  for (const s of dirs(join(wsRoot, 'served'))) for (const h of roleHandles(tryJson(join(wsRoot, 'served', s, 'org-inputs.json')))) pool.add(h);
  return [...pool].sort();
}

export interface MigrateResult {
  written: string[];
  kept: string[];
}

export function migrateOrgEval(o: { cache?: string; commit?: boolean } = {}): MigrateResult {
  const cache = o.cache ?? ORG_EVAL_CACHE;
  const home = homePaths();
  const res: MigrateResult = { written: [], kept: [] };
  const put = (dest: string, write: () => void) => {
    if (existsSync(dest)) return void res.kept.push(dest);
    write();
    res.written.push(dest);
  };
  for (const { ws, served } of MIGRATE) {
    const root = join(cache, ws);
    if (!existsSync(root)) continue;
    const labels = join(home.labels, 'org-review', ws);
    mkdirSync(labels, { recursive: true });
    for (const f of readdirSync(root).filter((n) => LABEL_FILE.test(n))) put(join(labels, f), () => cpSync(join(root, f), join(labels, f)));
    put(join(labels, 'handle-pool.json'), () => writeFileSync(join(labels, 'handle-pool.json'), `${JSON.stringify(historicalPool(root), null, 1)}\n`));

    const from = join(root, 'served', served);
    const dest = join(home.snapshots, 'org-review', `${ws}-${served}`);
    put(dest, () => {
      mkdirSync(dest, { recursive: true });
      for (const f of readdirSync(from)) cpSync(join(from, f), join(dest, f));
      const team = String(tryJson(join(from, 'org-inputs.json'))?.workspace?.name ?? ws);
      const argv: string[][] = [];
      for (const template of meta.frozenReads ?? []) {
        const read = fillArgv(template, { team });
        const legacy = legacyFile(read);
        if (!legacy || !existsSync(join(from, legacy))) continue;
        // The served read is the legacy file's bytes, as `./evals snapshot` files a capture.
        writeServedRead(dest, read, readFileSync(join(from, legacy), 'utf8'), 0);
        argv.push(read);
      }
      writeFrozenVerbs(dest, meta.frozenVerbs ?? []);
      const capturedAt = statSync(join(from, 'org-inputs.json')).mtime.toISOString();
      writeFileSync(join(dest, 'captured.json'), JSON.stringify({ argv, values: { team, name: `${ws}-${served}` }, captured_at: capturedAt, gitHead: null, workspace: ws, migrated_from: `~/.cache/org-eval/${ws}/served/${served}` }, null, 2));
      lockSnapshot(dest);
    });
  }
  if (o.commit) commitLabels(home.labels, ['org-review'], 'org-review: labels and handle pool from ~/.cache/org-eval');
  return res;
}

if (import.meta.main) {
  const res = migrateOrgEval({ commit: !process.argv.includes('--no-commit') });
  for (const p of res.written) console.log(`wrote  ${p}`);
  for (const p of res.kept) console.log(`kept   ${p}`);
  console.log(`\nNext: ./evals freeze create ${MIGRATE.map((m) => `org-review@${m.ws}-${m.served}`).join(' and ')}`);
}
