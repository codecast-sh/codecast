import type { Command } from 'commander';
import { fmt } from '@platform/cli-kit/colors';
import { clip, pad, plural } from '@platform/cli-kit/text';

import { resolveCommit } from '../git';
import { homePaths, PIN_REF_PREFIX, treeRoot } from '../paths';
import { backfillPins, type HeadsFile, mapOrphans, pinHeads, recordedHeads } from '../provenance';

// `./evals pin`: keep the commits runs ran on. A rebase can leave a run's
// head on no branch, where `git gc` collects it and the record names nothing,
// so every head is pinned under refs/evals/heads/ (local, never pushed) and
// heads.json maps each head off the main line to its patch-id twin on it.

function printHeads(heads: HeadsFile, runs: Map<string, number>): void {
  const rows = Object.entries(heads.heads).sort(([, a], [, b]) => (b.authoredAt ?? '').localeCompare(a.authoredAt ?? ''));
  console.log(fmt.muted([pad('head', 10), pad('runs', 6), pad('on', 8), pad('main twin', 10), 'subject or reason'].join(' ')));
  for (const [sha, h] of rows) {
    const twin = h.how === 'self' ? 'itself' : (h.mainSha?.slice(0, 9) ?? 'none');
    const note = h.mainSha ? (h.subject ?? '') : (h.reason ?? '');
    const line = [pad(sha.slice(0, 9), 10), pad(String(runs.get(sha) ?? '-'), 6), pad(h.on, 8), pad(twin, 10), clip(note, 90)].join(' ');
    console.log(h.on === 'main' ? line : h.mainSha ? fmt.warning(line) : fmt.error(line));
  }
  const off = rows.filter(([, h]) => h.on !== 'main');
  const unmapped = off.filter(([, h]) => !h.mainSha);
  console.log(
    fmt.muted(
      `${plural(rows.length, 'head')} pinned under ${PIN_REF_PREFIX}; ${off.length} off the main line (${heads.mainLine.map((r) => r.replace(/^refs\/(heads|remotes)\//, '')).join(', ') || 'none'}), ${unmapped.length} with no main-line twin. Map: ${homePaths().heads}`,
    ),
  );
}

export function registerPin(program: Command): void {
  program
    .command('pin [shas...]')
    .description('pin the commits runs ran on under refs/evals/heads/ (local, never pushed) and map heads off the main line to their main-line twins in heads.json')
    .option('--backfill', 'pin every head the run folders record, then remap them all')
    .option('--json', 'print heads.json')
    .action((shas: string[], flags: { backfill?: boolean; json?: boolean }) => {
      const root = treeRoot();
      const named = (shas.length || flags.backfill ? shas : ['HEAD']).map((s) => {
        const sha = resolveCommit(s, root);
        if (!sha) throw new Error(`${s} names no commit in ${root}`);
        return sha;
      });

      let runs: Map<string, number>;
      let heads: HeadsFile;
      let pinned: string[];
      let missing: string[];
      if (flags.backfill) {
        ({ runs, heads, pinned, missing } = backfillPins({ root, extra: named }));
      } else {
        ({ pinned, missing } = pinHeads(named, root));
        heads = mapOrphans(root);
        runs = recordedHeads();
      }
      if (flags.json) return console.log(JSON.stringify(heads, null, 2));
      if (pinned.length) console.log(fmt.success(`pinned ${plural(pinned.length, 'new head')}`));
      if (missing.length) console.log(fmt.error(`gone from this repo, cannot pin: ${missing.map((s) => s.slice(0, 9)).join(', ')}`));
      printHeads(heads, runs);
    });
}
