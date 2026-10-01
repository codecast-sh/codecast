import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Command } from 'commander';
import { renderScore } from '@platform/evals/render';
import { renderOpts } from '@platform/cli-kit/render';

import { codecastFreezeStore } from '../adapters/freezes';
import { loadSurface } from '../registry';

// `./evals grade <surface> <dir>`: grade an output dir that already exists
// (an old org round) with the surface's own grader, without replaying.

export function registerGrade(program: Command): void {
  program
    .command('grade <surface> <dir>')
    .description("grade an existing output dir with the surface's gates and checks (org-review only)")
    .option('--label <file>', 'the label JSON to grade against')
    .option('--freeze <id>', "the freeze whose labels and snapshot grade the dir (default: the one the dir's run.json names)")
    .option('--json', 'machine readable output')
    .action(async (surface: string, dir: string, flags: { label?: string; freeze?: string; json?: boolean }) => {
      const impl = await loadSurface(surface);
      if (!impl.grade) throw new Error(`${surface} has no grader for an existing dir; ./evals check ${surface} replays and grades instead`);
      if (!existsSync(dir)) throw new Error(`no dir ${dir}`);
      const label = flags.label ? JSON.parse(readFileSync(flags.label, 'utf8')) : undefined;
      const ref = flags.freeze ?? (existsSync(join(dir, 'run.json')) ? (JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as { freezeId?: string }).freezeId : undefined);
      const freeze = ref ? await codecastFreezeStore().get(ref) : null;
      if (ref && !freeze) throw new Error(`no freeze ${ref}`);
      const score = impl.grade(dir, label, freeze ?? undefined);
      if (flags.json) return console.log(JSON.stringify(score, null, 2));
      console.log(renderScore(score, renderOpts({ full: true })).join('\n'));
      if (!score.pass) process.exitCode = 1;
    });
}
