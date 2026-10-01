import type { Command } from 'commander';

import type { EvalSources, RunDetail } from '../model';
import { renderRunPage } from '../html/run';
import { renderSweepPage } from '../html/sweep';
import { renderMatrixPage } from '../html/matrix';
import { buildMatrix, renderMatrix } from '../render/matrix';
import { renderStory } from '../render/runs';
import { renderEvents, renderHistory, renderRun, renderRunDiff, renderRunList, renderScore } from '../render/runs';
import { addCommon, json, list, need, opts, out, since, UsageError, writePage } from './shared';

async function runOf(sources: EvalSources, ref: string): Promise<RunDetail> {
  const src = need(sources, 'runs', 'run source');
  const r = await src.get(ref);
  if (!r) throw new UsageError(`no run ${ref}`);
  return r;
}

export function registerRuns(program: Command, sources: EvalSources): void {
  const runs = program.command('runs').alias('evals').description('every simulation and eval run: list, one run, its story, its score, diffs, pages');

  const listCmd = addCommon(runs.command('list', { isDefault: true }).description('recent runs, newest first'))
    .option('--scenario <id>', 'one scenario (prefix ok)')
    .option('--since <t>', 'window: 24h, 7d, 2w')
    .option('--status <s>', 'pass, fail, crash, unscored, running')
    .option('--freeze <id>', 'replays of one freeze')
    .option('-n, --limit <n>', 'rows (default 30)', (v) => Number(v), 30)
    .action(async (flags) => {
      const src = need(sources, 'runs', 'run source');
      const rows = await src.list({ scenario: flags.scenario, since: since(flags.since), limit: flags.limit, status: flags.status, freezeId: flags.freeze });
      if (flags.json) return json(rows);
      out(renderRunList(rows, opts(flags)));
    });
  void listCmd;

  addCommon(runs.command('show <run>').description('one run: who, the score, the story, what the boundary caught'))
    .option('--last <n>', 'story lines (default 30)', (v) => Number(v))
    .action(async (ref, flags) => {
      const r = await runOf(sources, ref);
      if (flags.json) return json(r);
      out(renderRun(r, { ...opts(flags), last: flags.last }));
    });

  addCommon(runs.command('story <run>').description('the story alone: everything said by anybody, in virtual time'))
    .option('--channel <kinds>', 'only these rails')
    .option('--from <n>', 'first line', (v) => Number(v))
    .option('--to <n>', 'last line', (v) => Number(v))
    .option('--around <n>', 'centre on line n', (v) => Number(v))
    .option('--last <n>', 'the last n', (v) => Number(v))
    .option('--lines <n>', 'body lines per message', (v) => Number(v))
    .option('--no-system', 'hide beats, silences and notes')
    .action(async (ref, flags) => {
      const r = await runOf(sources, ref);
      if (flags.json) return json(r.messages);
      out(renderStory(r, { ...opts(flags), channels: list(flags.channel), from: flags.from, to: flags.to, around: flags.around, last: flags.last ?? (flags.full ? undefined : 60), lines: flags.lines, system: flags.system }));
    });

  addCommon(runs.command('events <run>').description("the driver's event log"))
    .option('--kind <kinds>', 'only these kinds, comma separated')
    .option('--last <n>', 'the last n', (v) => Number(v))
    .action(async (ref, flags) => {
      const r = await runOf(sources, ref);
      if (flags.json) return json(r.events);
      out(renderEvents(r, { ...opts(flags), kinds: list(flags.kind), last: flags.last }));
    });

  addCommon(runs.command('score <run>').description('the verdict: every gate with its evidence, every judged check with its reasoning')).action(async (ref, flags) => {
    const r = await runOf(sources, ref);
    if (flags.json) return json(r.verdict);
    out([`${r.title}  ${r.id}`, '', ...renderScore(r.verdict, { ...opts(flags), full: true })].join('\n'));
  });

  addCommon(runs.command('diff <a> <b>').description('two runs side by side: what flipped')).action(async (a, b, flags) => {
    const [ra, rb] = await Promise.all([runOf(sources, a), runOf(sources, b)]);
    out(renderRunDiff(ra, rb, opts(flags)));
  });

  addCommon(runs.command('history <scenario>').description('one scenario across runs, with a pass strip'))
    .option('-n, --limit <n>', 'runs (default 20)', (v) => Number(v), 20)
    .action(async (scenario, flags) => {
      const src = need(sources, 'runs', 'run source');
      const rows = await src.list({ scenario, limit: flags.limit });
      if (flags.json) return json(rows);
      out(renderHistory(rows, scenario, opts(flags)));
    });

  addCommon(runs.command('html <run>').description('the page: cast, timeline, story, rooms, score, boundary, events'))
    .option('--open', 'open it')
    .option('-o, --out <file>', 'where to write it (default: report.html beside the evidence)')
    .action(async (ref, flags) => {
      const r = await runOf(sources, ref);
      const html = renderRunPage(r);
      writePage(sources, r.evidenceDir ? `${r.evidenceDir}/report.html` : `run-${r.id}.html`, html, { out: flags.out ?? (r.evidenceDir ? `${r.evidenceDir}/report.html` : undefined), open: flags.open });
    });

  addCommon(runs.command('report').description('one page over many runs: the table, then every run in full'))
    .option('--scenario <id>', 'one scenario')
    .option('--since <t>', 'window (default 24h)')
    .option('--freeze <id>', 'replays of one freeze')
    .option('-n, --limit <n>', 'runs (default 20)', (v) => Number(v), 20)
    .option('--title <text>', 'the page title')
    .option('--open', 'open it')
    .option('-o, --out <file>', 'where to write it')
    .action(async (flags) => {
      const src = need(sources, 'runs', 'run source');
      const rows = await src.list({ scenario: flags.scenario, since: since(flags.since ?? '24h'), limit: flags.limit, freezeId: flags.freeze });
      const details = (await Promise.all(rows.map((r) => src.get(r.id)))).filter((d): d is RunDetail => Boolean(d));
      writePage(sources, `report-${new Date().toISOString().slice(0, 10)}.html`, renderSweepPage(details, { title: flags.title }), flags);
    });

  addCommon(runs.command('matrix').description('every model against every scenario and freeze: pass rate, score, cost and time per turn'))
    .option('--scenario <id>', 'one scenario')
    .option('--since <t>', 'window: 24h, 7d, 2w')
    .option('--freeze <id>', 'replays of one freeze')
    .option('--model <ids>', 'only these models, comma separated')
    .option('-n, --limit <n>', 'runs to read (default 400)', (v) => Number(v), 400)
    .option('--html', 'write the page instead of the table')
    .option('--title <text>', 'the page title')
    .option('--open', 'open the page')
    .option('-o, --out <file>', 'where to write the page')
    .action(async (flags) => {
      const src = need(sources, 'runs', 'run source');
      const wanted = list(flags.model);
      const rows = (await src.list({ scenario: flags.scenario, since: since(flags.since), limit: flags.limit, freezeId: flags.freeze })).filter((r) => !wanted || wanted.includes(r.model ?? ''));
      // The per turn numbers live in each run's detail; reading them is what makes a turn priceable.
      const details = new Map<string, RunDetail>();
      for (const d of await Promise.all(rows.map((r) => src.get(r.id)))) if (d) details.set(d.id, d);
      const matrix = buildMatrix(rows, details);
      if (flags.json) return json(matrix);
      if (flags.html || flags.open || flags.out) {
        writePage(sources, `matrix-${new Date().toISOString().slice(0, 10)}.html`, renderMatrixPage(matrix, { title: flags.title }), flags);
        return;
      }
      out(renderMatrix(matrix, { ...opts(flags), title: flags.title }));
    });
}
