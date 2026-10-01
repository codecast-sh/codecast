import type { Command } from 'commander';

import { loadSurface } from '../registry';

// `./evals capture <surface> <runDir>`: the presentation capture, attended
// only (it needs the founder's Chrome and localhost:3200). org-review is the
// only surface with one in Phase 1.

export function registerCapture(program: Command): void {
  program
    .command('capture <surface> <runDir>')
    .description('presentation capture of a run, attended only (org-review in Phase 1)')
    .action(async (surface: string, runDir: string) => {
      const impl = await loadSurface(surface);
      if (!impl.capturePresentation) throw new Error(`${surface} has no presentation capture`);
      await impl.capturePresentation(runDir);
    });
}
