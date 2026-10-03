import type { Command } from 'commander';
import { fmt } from '@platform/cli-kit/colors';
import { plural } from '@platform/cli-kit/text';

import { indexedRuns, refreshRunIndex, runIndexPath } from '../history/runIndex';
import { surfaces } from '../registry';

// `./evals index`: bring EVALS_HOME/index/runs.jsonl up to date with the run
// folders. Every reader refreshes it on its own (surfaceRuns per surface, the
// UI's api child in full), so this command is for the first build, a check,
// or a rebuild after the row format changed.

export function registerIndex(program: Command): void {
  program
    .command('index')
    .description('refresh the run index (EVALS_HOME/index/runs.jsonl): one row per run folder, read again only when its run.json, result.json or score.json changed')
    .option('--full', 'read every run folder again, whatever the index holds')
    .option('--surface <id>', 'check only the folders of this surface')
    .option('--json', 'print the rows instead of the summary')
    .action(async (flags: { full?: boolean; surface?: string; json?: boolean }) => {
      if (flags.surface && !surfaces().some((s) => s.id === flags.surface)) throw new Error(`no surface ${flags.surface}; ./evals lists them`);
      const tty = process.stderr.isTTY;
      let shown = 0;
      const r = await refreshRunIndex({
        full: flags.full,
        surface: flags.surface,
        onProgress: (p) => {
          if (p.phase !== 'reading' || !p.total) return;
          const pct = Math.floor((p.done / p.total) * 100);
          if (tty) process.stderr.write(`\r${fmt.muted(`reading ${p.done}/${p.total} run folders`)}`);
          else if (pct >= shown + 10 || p.done === p.total) {
            shown = pct;
            process.stderr.write(`reading ${p.done}/${p.total} run folders\n`);
          }
        },
      });
      if (tty && r.rebuilt) process.stderr.write('\n');
      if (flags.json) {
        for (const row of await indexedRuns({ surface: flags.surface, maxAgeMs: 60_000 })) console.log(JSON.stringify(row));
        return;
      }
      console.log(
        `${fmt.success(plural(r.rows, 'row'))} in ${runIndexPath()}: ${plural(r.scanned, 'folder')} checked, ${r.rebuilt} read${r.removed ? `, ${r.removed} removed` : ''}, ${r.wrote ? 'written' : 'unchanged'} (${(r.ms / 1000).toFixed(1)}s)`,
      );
      if (r.unmappedHeads.length) console.log(fmt.warning(`${plural(r.unmappedHeads.length, 'head')} not in heads.json, so their rows have no main-line twin: run ./evals pin --backfill`));
      for (const p of r.problems.slice(0, 10)) console.log(fmt.error(`${p.id}: ${p.problems.join('; ')}`));
      if (r.problems.length > 10) console.log(fmt.error(`and ${r.problems.length - 10} more folders left out`));
    });
}
