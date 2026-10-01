import type { Command } from 'commander';

import type { Conversation, EvalSources, Freeze, ProductionReply, RunDetail, RunSummary } from '../model';
import { renderFreezePage } from '../html/freeze';
import { renderFreezeList, renderFreezeShow, renderReplayResults } from '../render/freeze';
import { renderRunDiff } from '../render/runs';
import { addCommon, json, need, opts, out, UsageError, writePage } from './shared';

async function freezeOf(sources: EvalSources, ref: string): Promise<Freeze> {
  const store = need(sources, 'freezes', 'freeze store');
  const f = await store.get(ref);
  if (!f) throw new UsageError(`no freeze ${ref}`);
  return f;
}

async function replaysOf(sources: EvalSources, f: Freeze): Promise<RunSummary[]> {
  return sources.runs ? sources.runs.list({ freezeId: f.id }) : [];
}

async function replayDetails(sources: EvalSources, f: Freeze): Promise<RunDetail[]> {
  if (!sources.runs) return [];
  const rows = await replaysOf(sources, f);
  const details = await Promise.all(rows.map((r) => sources.runs!.get(r.id)));
  return details.filter((d): d is RunDetail => Boolean(d));
}

async function momentOf(sources: EvalSources, f: Freeze): Promise<Conversation | null> {
  if (!sources.convo) return null;
  const c = await sources.convo.load(f.subject);
  // The world is cut at the moment: nothing after it is part of the freeze.
  const asOf = Date.parse(f.asOf);
  return { ...c, messages: c.messages.filter((m) => Date.parse(m.at) <= asOf) };
}

async function productionOf(sources: EvalSources, f: Freeze, judged: boolean): Promise<ProductionReply | null> {
  if (!sources.productionReply) return null;
  const p = await sources.productionReply(f);
  if (!p) return null;
  if (judged && f.judge && sources.judge && p.messages.length && !p.verdict) p.verdict = await sources.judge.judge(f, p.messages);
  return p;
}

export function registerFreeze(program: Command, sources: EvalSources): void {
  const freeze = program.command('freeze').description('freeze a moment, replay the assistant from it, judge the replies');

  addCommon(freeze.command('create [messageId]').description('freeze the moment the assistant had to act at a message (or --run a production run)'))
    .option('--run <runId>', 'replay a production run from its own trigger')
    .option('--name <text>', 'a name; defaults to who, what woke it, and when')
    .option('--judge <criteria>', 'pass criteria every replay is graded by')
    .option('--notes <text>', 'why this moment matters')
    .option('--tag <tag>', 'a tag (repeatable)', (v: string, all: string[]) => [...all, v], [] as string[])
    .action(async (messageId, flags) => {
      const store = need(sources, 'freezes', 'freeze store');
      const resolver = need(sources, 'freezeResolver', 'freeze resolver');
      if (!messageId && !flags.run) throw new UsageError('a message id or --run <runId> is required');
      const moment = await resolver.resolve({ messageRef: messageId, runRef: flags.run });
      const f = await store.create({ ...moment, name: flags.name ?? moment.name, judge: flags.judge ?? null, notes: flags.notes ?? null, tags: flags.tag });
      if (flags.json) return json(f);
      const p = opts(flags);
      out(renderFreezeShow(f, await momentOf(sources, f), await productionOf(sources, f, false), [], { ...p, radius: 4 }));
    });

  addCommon(freeze.command('list').alias('ls').description('every frozen moment, newest first'))
    .option('-q, --query <text>', 'name, notes or criteria containing this')
    .option('--tag <tag>', 'only this tag')
    .option('--contact <ref>', 'only this subject (id or prefix)')
    .action(async (flags) => {
      const store = need(sources, 'freezes', 'freeze store');
      const rows = await store.list({ q: flags.query, tag: flags.tag, subjectId: flags.contact });
      const withReplays = await Promise.all(
        rows.map(async (f) => {
          const replays = await replaysOf(sources, f);
          const last = replays[0];
          return { ...f, replays: replays.length, lastVerdict: last && last.score !== null ? { pass: last.status === 'pass', score: last.score } : null };
        }),
      );
      if (flags.json) return json(withReplays);
      out(renderFreezeList(withReplays, opts(flags)));
    });

  addCommon(freeze.command('show <id>').description('the moment: the conversation with a FROZEN HERE marker, the production reply, the replay history'))
    .option('--context <n>', 'messages either side of the cut (default 6)', (v) => Number(v), 6)
    .action(async (id, flags) => {
      const f = await freezeOf(sources, id);
      const convo = await momentOf(sources, f);
      const production = await productionOf(sources, f, false);
      const replays = await replaysOf(sources, f);
      if (flags.json) return json({ freeze: f, production, replays });
      out(renderFreezeShow(f, convo, production, replays, { ...opts(flags), radius: flags.context }));
    });

  const replayCmd = (name: string, description: string, horizon: boolean) =>
    addCommon(freeze.command(`${name} <id>`).description(description))
      .option('--reps <n>', 'independent replays (default 1; 3 to 5 shows the variance)', (v) => Number(v), 1)
      .option('--model <id>', 'the model the assistant runs on; the judge is unaffected')
      .option('--dry', 'a scripted model: proves the wiring, spends nothing')
      .option('--notes <text>', 'what you changed, kept on every rep')
      .option('--horizon <hours>', horizon ? 'virtual hours to run forward with personas answering (default 24)' : 'keep going after the reply for this many virtual hours', (v) => Number(v), horizon ? 24 : undefined)
      .option('--open', 'open the freeze page when done')
      .action(async (id, flags) => {
        const f = await freezeOf(sources, id);
        const replayer = need(sources, 'replayer', 'replayer');
        if (!f.judge) out(`unjudged: every rep will report a vacuous pass. Set criteria with ${sources.name} freeze judge ${f.id.slice(0, 8)} "…"`);
        const runs = await replayer.replay(f, { reps: flags.reps, model: flags.model ?? null, dry: Boolean(flags.dry), notes: flags.notes ?? null, horizonHours: flags.horizon ?? null, onLine: (line) => out(line) });
        if (flags.json) return json(runs);
        out('');
        const details = await replayDetails(sources, f);
        const production = await productionOf(sources, f, true);
        out(renderReplayResults(f, details.filter((d) => runs.some((r) => r.id === d.id)), production, opts(flags)));
        if (flags.open) writePage(sources, `freeze-${f.id.slice(0, 8)}.html`, renderFreezePage(f, await momentOf(sources, f), production, details), { open: true });
      });
  replayCmd('replay', 'run the assistant from the moment against the prompts in this tree, N times, and judge each reply', false);
  replayCmd('sim', 'a forward simulation from the moment: the reply, then a day of personas answering', true);

  addCommon(freeze.command('judge <id> <criteria>').description('set the pass criteria; --rejudge regrades every replay and the production reply'))
    .option('--rejudge', 'grade every existing replay again with the new criteria')
    .action(async (id, criteria, flags) => {
      const store = need(sources, 'freezes', 'freeze store');
      const f = await store.update((await freezeOf(sources, id)).id, { judge: criteria });
      out(`judge set on ${f.id.slice(0, 8)}: ${criteria}`);
      if (flags.rejudge) {
        const judge = need(sources, 'judge', 'reply judge');
        const details = await replayDetails(sources, f);
        for (const d of details) {
          const v = await judge.judge(f, d.messages.filter((m) => m.direction === 'out'));
          out(`  ${d.id.slice(0, 30)}  ${v.pass ? 'PASS' : 'FAIL'} ${v.score.toFixed(2)}  ${v.reasoning ?? ''}`);
        }
        const production = await productionOf(sources, f, true);
        if (production?.verdict) out(`  production  ${production.verdict.pass ? 'PASS' : 'FAIL'} ${production.verdict.score.toFixed(2)}  ${production.verdict.reasoning ?? ''}`);
      }
    });

  addCommon(freeze.command('results <id>').description('every replay side by side with its verdict, and the production reply')).action(async (id, flags) => {
    const f = await freezeOf(sources, id);
    const details = await replayDetails(sources, f);
    const production = await productionOf(sources, f, true);
    if (flags.json) return json({ freeze: f, production, replays: details });
    out(renderReplayResults(f, details, production, opts(flags)));
  });

  addCommon(freeze.command('diff <id>').description('two replays against each other'))
    .requiredOption('--run <runId>', 'a replay (twice)', (v: string, all: string[]) => [...all, v], [] as string[])
    .action(async (id, flags) => {
      await freezeOf(sources, id);
      const runs = need(sources, 'runs', 'run source');
      if (flags.run.length !== 2) throw new UsageError('--run A --run B: exactly two');
      const [a, b] = await Promise.all(flags.run.map((r: string) => runs.get(r)));
      if (!a || !b) throw new UsageError('both runs must exist');
      out(renderRunDiff(a, b, opts(flags)));
    });

  addCommon(freeze.command('html <id>').description('the freeze page: the moment, the replies side by side, the checks across replays'))
    .option('--open', 'open it')
    .option('-o, --out <file>', 'where to write it')
    .action(async (id, flags) => {
      const f = await freezeOf(sources, id);
      writePage(sources, `freeze-${f.id.slice(0, 8)}.html`, renderFreezePage(f, await momentOf(sources, f), await productionOf(sources, f, true), await replayDetails(sources, f)), flags);
    });

  addCommon(freeze.command('rm <id>').description('forget a freeze; its replays stay in the run history')).action(async (id) => {
    const store = need(sources, 'freezes', 'freeze store');
    const f = await freezeOf(sources, id);
    out((await store.remove(f.id)) ? `removed ${f.id.slice(0, 8)} ${f.name}` : `nothing removed`);
  });
}
