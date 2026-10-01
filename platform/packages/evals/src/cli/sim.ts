import type { Command } from 'commander';

import type { EvalSources } from '../model';
import { renderRunPage } from '../html/run';
import { renderRun } from '../render/runs';
import { renderScenarios } from '../render/sim';
import { addCommon, json, list, need, opts, out, UsageError, writePage } from './shared';

export function registerSim(program: Command, sources: EvalSources): void {
  const sim = program.command('sim').description('run a scenario against the whole product with simulated people');

  addCommon(sim.command('scenarios').alias('ls').description('the scenario library in this tree')).action(async (flags) => {
    const launcher = need(sources, 'sims', 'simulation launcher');
    const rows = await launcher.scenarios();
    if (flags.json) return json(rows);
    out(renderScenarios(rows, opts(flags)));
  });

  addCommon(sim.command('run <scenario>').description('run one scenario, stream it, then show the run and write its page'))
    .option('--seed <n>', 'same seed, same run (default 11)', (v) => Number(v), 11)
    .option('--dry', 'a scripted model and judge: proves the wiring, spends nothing')
    .option('--model <id>', 'the model the assistant runs on; the judge is unaffected')
    .option('--open', 'open the page when done')
    .option('--quiet', 'only the summary at the end')
    .action(async (scenario, flags) => {
      const launcher = need(sources, 'sims', 'simulation launcher');
      const known = await launcher.scenarios();
      if (!known.some((s) => s.id === scenario)) throw new UsageError(`no scenario ${scenario}; ${sources.name} sim scenarios lists them`);
      const { exitCode, runId } = await launcher.run(scenario, { seed: flags.seed, dry: Boolean(flags.dry), model: flags.model ?? null, onLine: (line) => (flags.quiet ? undefined : out(line)) });
      if (!runId) {
        out(`the run left no evidence (exit ${exitCode})`);
        process.exitCode = exitCode || 1;
        return;
      }
      const r = await need(sources, 'runs', 'run source').get(runId);
      if (!r) throw new UsageError(`the run wrote evidence but ${runId} cannot be read back`);
      if (flags.json) return json(r);
      out('');
      out(renderRun(r, { ...opts(flags), last: 20 }));
      writePage(sources, `${r.evidenceDir}/report.html`, renderRunPage(r), { out: r.evidenceDir ? `${r.evidenceDir}/report.html` : undefined, open: flags.open });
      if (exitCode) process.exitCode = exitCode;
    });

  addCommon(sim.command('sweep').description('every scenario once, in parallel, and one page at the end'))
    .option('--only <ids>', 'these scenarios, comma separated')
    .option('--seed <n>', 'a seed (repeatable)', (v: string, all: number[]) => [...all, Number(v)], [] as number[])
    .option('--dry', 'scripted model and judge')
    .option('--model <id>', 'the model the assistant runs on; the judge is unaffected')
    .option('--parallel <n>', 'runs at a time (default 3)', (v) => Number(v), 3)
    .option('--open', 'open the page when done')
    .action(async (flags) => {
      const launcher = need(sources, 'sims', 'simulation launcher');
      if (!launcher.sweep) throw new UsageError(`${sources.name} has no sweep wired`);
      const { exitCode, runIds } = await launcher.sweep({ only: list(flags.only), seeds: flags.seed.length ? flags.seed : undefined, dry: Boolean(flags.dry), model: flags.model ?? null, parallel: flags.parallel, onLine: (line) => out(line) });
      if (flags.json) return json({ exitCode, runIds });
      if (runIds.length && sources.runs) {
        const { renderSweepPage } = await import('../html/sweep');
        const details = (await Promise.all(runIds.map((id) => sources.runs!.get(id)))).filter((d): d is NonNullable<typeof d> => Boolean(d));
        writePage(sources, `sweep-${new Date().toISOString().replace(/[:.]/g, '-')}.html`, renderSweepPage(details, { dry: Boolean(flags.dry) }), { open: flags.open });
      }
      if (exitCode) process.exitCode = exitCode;
    });
}
