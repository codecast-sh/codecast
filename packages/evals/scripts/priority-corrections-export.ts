#!/usr/bin/env bun
// Freezes the corrections people wrote on their priorities as eval cases for
// the priorities pass (packages/convex/convex/lib/priorityPass.ts). Each case
// is the priority as its owner saw it when they wrote the correction, their
// words, the window the pass that applied it read (replay it through
// priorityPassEval evalPass), and the priority as the passes since left it: a
// scorer checks the pass did what the correction asked. Only corrections a
// pass has applied are cases. Reads prod through packages/convex/run.sh
// (priorities:exportCases); real content, so cases go to
// EVALS_HOME/priority-corrections/<correction id>.json, never the repo.
// Reruns pick up from the newest applied case on file; a case already frozen
// is kept.
//
//   bun packages/evals/scripts/priority-corrections-export.ts [--since 2026-11-01]

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT, evalsHome } from '../src/paths';

export type CorrectionCase = {
  id: string;
  user_id: string;
  workspace: string;
  created_at: number;
  applied_at: number;
  /** The cursor window of the pass that applied it. */
  window: { from: number; to: number } | null;
  step_key: string | null;
  text: string;
  before: unknown;
  after: unknown;
};

/** When the newest case on file was applied, so a rerun reads only what came after. */
export function newestFrozen(dir: string): number {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    newest = Math.max(newest, (JSON.parse(readFileSync(join(dir, name), 'utf8')) as CorrectionCase).applied_at);
  }
  return newest;
}

/** Writes the cases not already on file; returns how many it wrote. */
export function freezeCases(dir: string, cases: CorrectionCase[]): number {
  mkdirSync(dir, { recursive: true });
  let wrote = 0;
  for (const c of cases) {
    const file = join(dir, `${c.id}.json`);
    if (existsSync(file)) continue;
    writeFileSync(file, `${JSON.stringify(c, null, 2)}\n`);
    wrote++;
  }
  return wrote;
}

function exportCases(since: number): { cases: CorrectionCase[]; more: boolean } {
  const r = Bun.spawnSync([join(REPO_ROOT, 'packages/convex/run.sh'), 'priorities:exportCases', JSON.stringify({ since })], { stdout: 'pipe', stderr: 'inherit' });
  const out = r.stdout.toString();
  if (r.exitCode !== 0) throw new Error(`priorities:exportCases failed (exit ${r.exitCode})`);
  return JSON.parse(out.slice(out.search(/^[{[]/m)));
}

if (import.meta.main) {
  const dir = join(evalsHome(), 'priority-corrections');
  const at = process.argv.indexOf('--since');
  let since = at > 0 ? Date.parse(process.argv[at + 1]) : newestFrozen(dir);
  if (Number.isNaN(since)) throw new Error(`--since takes a date, got "${process.argv[at + 1]}"`);
  let total = 0;
  for (;;) {
    const { cases, more } = exportCases(since);
    total += freezeCases(dir, cases);
    if (!more || !cases.length) break;
    since = cases.at(-1)!.applied_at;
  }
  console.log(`${total} new correction case${total === 1 ? '' : 's'} in ${dir}`);
}
