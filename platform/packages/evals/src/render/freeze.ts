// Pure renderers for the freeze views: the list, one moment with the world
// cut at it, the replays side by side, and two replays against each other.

import { renderFields, renderNext, renderTable, truncate, wrapText, type RenderOpts } from '@platform/cli-kit/render';
import { formatCost, formatTimestamp, shortId } from '@platform/cli-kit/format';
import { relativeTime } from '@platform/cli-kit/text';

import type { Conversation, Freeze, ProductionReply, RunDetail, RunSummary } from '../model';
import { makePalette, nameOf, verdictWord } from './common';

/** "2h ago", or "just now": relativeTime says "now" for the first minute, and "now ago" is not a phrase. */
export const age = (iso: string): string => {
  const t = relativeTime(Date.parse(iso));
  return t === 'now' ? 'just now' : `${t} ago`;
};
import { renderConversation, type ConversationViewOpts } from './convo';
import { renderScore } from './runs';

export function renderFreezeList(rows: Array<Freeze & { replays?: number; lastVerdict?: { pass: boolean; score: number } | null }>, o: RenderOpts & { cli?: string }): string {
  const p = makePalette(o.color);
  const cli = o.cli ?? 'xrun';
  const lines = [`${p.bold(p.cyan('Freezes'))}  ${p.dim(`${rows.length} frozen moments, newest first`)}`, ''];
  if (!rows.length) lines.push(p.dim(`  none yet: ${cli} convo inbox, pick a moment, ${cli} freeze create <messageId>`));
  lines.push(
    ...renderTable(
      rows,
      [
        { header: 'id', width: 8, value: (f) => shortId(f.id), style: () => p.dim },
        { header: 'age', width: 4, align: 'right', value: (f) => relativeTime(Date.parse(f.createdAt)) },
        { header: 'as of', width: 16, value: (f) => formatTimestamp(f.asOf), style: () => p.dim },
        { header: 'judge', width: 5, value: (f) => (f.judge ? 'yes' : ''), style: (f) => (f.judge ? p.green : p.dim) },
        { header: 'reps', width: 4, align: 'right', value: (f) => (f.replays ? String(f.replays) : '') },
        { header: 'last', width: 9, value: (f) => (f.lastVerdict ? `${f.lastVerdict.pass ? 'PASS' : 'FAIL'} ${f.lastVerdict.score.toFixed(2)}` : ''), style: (f) => (f.lastVerdict?.pass ? p.green : p.red) },
        { header: 'name', value: (f) => `${f.name}${f.tags.length ? `  [${f.tags.join(', ')}]` : ''}` },
      ],
      p,
      o.width,
    ),
  );
  lines.push('', ...renderNext([[`${cli} freeze show ${rows[0] ? shortId(rows[0].id) : '<id>'}`, 'the moment'], [`${cli} freeze replay ${rows[0] ? shortId(rows[0].id) : '<id>'} --reps 3`, 'replay it against this tree']], p));
  return lines.join('\n');
}

export function renderFreezeHeader(f: Freeze, o: RenderOpts): string[] {
  const p = makePalette(o.color);
  const lines = [`${p.bold(p.cyan(f.name))}  ${p.dim(`freeze ${f.id}`)}`];
  lines.push(
    ...renderFields(
      [
        ['subject', `${f.subject.title} (${f.subject.kind} ${shortId(f.subject.id)})`],
        ['anchor', `${f.anchor.kind} ${f.anchor.id}`],
        ['as of', formatTimestamp(f.asOf)],
        ['trigger', f.trigger ? `${f.trigger.type}${f.trigger.data ? ` ${truncate(JSON.stringify(f.trigger.data), 60)}` : ''}` : ''],
        ['created', `${formatTimestamp(f.createdAt)} (${age(f.createdAt)})`],
        ['tags', f.tags.join(', ')],
        ['notes', f.notes ?? ''],
      ],
      p,
    ),
  );
  if (f.judge) lines.push('', p.dim('judge criteria'), ...wrapText(f.judge, o.width - 4).map((l) => `  ${l}`));
  else lines.push('', p.yellow(`unjudged: set criteria with freeze judge ${shortId(f.id)} "the reply must …"`));
  return lines;
}

export function renderFreezeShow(f: Freeze, convo: Conversation | null, production: ProductionReply | null, replays: RunSummary[], o: ConversationViewOpts): string {
  const p = makePalette(o.color);
  const cli = o.cli ?? 'xrun';
  const lines = [...renderFreezeHeader(f, o), ''];
  if (convo) {
    lines.push(p.dim('the moment, with the world cut where the marker is'));
    lines.push(...renderConversation(convo, { ...o, focusId: f.anchor.kind === 'message' ? f.anchor.id : null, radius: o.radius ?? 6 }).split('\n').filter((l) => !l.startsWith('Next:') && !l.startsWith('  xrun ') && !l.startsWith(`  ${cli} `)).map((l) => (l ? `  ${l}` : l)));
  }
  if (production) {
    lines.push(p.dim('what production said next'));
    if (!production.messages.length) lines.push(p.dim('  nothing: no reply is on record after this moment'));
    for (const m of production.messages) {
      lines.push(`  ${p.dim(formatTimestamp(m.at))} ${p.bold(p.green('assistant'))} → ${m.to ?? '?'}`);
      lines.push(...wrapText(m.text, o.width - 8).map((l) => `      ${l}`));
    }
    if (production.verdict) lines.push(`  ${verdictWord(production.verdict.pass, production.verdict.score, p)}${production.verdict.reasoning ? `  ${p.dim(truncate(production.verdict.reasoning, o.width - 20))}` : ''}`);
    lines.push('');
  }
  lines.push(p.dim(`replays (${replays.length})`));
  if (!replays.length) lines.push(p.dim('  none yet'));
  for (const r of replays) lines.push(`  ${p.dim(r.id)}  ${p.dim(age(r.createdAt))}  ${verdictWord(r.status === 'pass' || r.status === 'fail' ? r.status === 'pass' : null, r.score, p)}  ${r.sends} sends  ${formatCost(r.costUsd)}${r.notes ? `  ${p.dim(r.notes)}` : ''}${r.model ? `  ${p.dim(r.model)}` : ''}`);
  lines.push('');
  lines.push(
    ...renderNext(
      [
        [`${cli} freeze replay ${shortId(f.id)} --reps 3`, 'run the assistant from here, three times, against this tree'],
        [`${cli} freeze judge ${shortId(f.id)} "the reply must …"`, f.judge ? 'change the criteria (--rejudge regrades every replay)' : 'set the criteria every replay is graded by'],
        [`${cli} freeze results ${shortId(f.id)}`, 'every replay side by side'],
        [`${cli} freeze sim ${shortId(f.id)} --horizon 24`, 'keep going: personas answer, a day unfolds'],
      ],
      p,
    ),
  );
  return lines.join('\n');
}

export function renderReplayResults(f: Freeze, runs: RunDetail[], production: ProductionReply | null, o: RenderOpts & { cli?: string }): string {
  const p = makePalette(o.color);
  const cli = o.cli ?? 'xrun';
  const lines = [`${p.bold(p.cyan(f.name))}  ${p.dim(`${runs.length} replays`)}`, ''];
  if (f.judge) lines.push(p.dim('criteria: ') + truncate(f.judge.replace(/\s+/g, ' '), o.width - 12), '');
  const block = (title: string, verdict: { pass: boolean; score: number; reasoning?: string | null } | null, texts: Array<{ to: string | null; text: string }>, extra = ''): string[] => {
    const out = [`${p.bold(title)}  ${verdict ? verdictWord(verdict.pass, verdict.score, p) : p.dim('unjudged')}${extra ? `  ${p.dim(extra)}` : ''}`];
    if (!texts.length) out.push(p.dim('    said nothing'));
    for (const t of texts) out.push(`    ${p.dim('→')} ${p.dim(t.to ?? '?')}`, ...wrapText(t.text, o.width - 8).map((l) => `      ${l}`));
    if (verdict?.reasoning) out.push(...wrapText(verdict.reasoning, o.width - 8).map((l) => `      ${p.dim(l)}`));
    out.push('');
    return out;
  };
  if (production) lines.push(...block('production', production.verdict ?? null, production.messages.map((m) => ({ to: m.to ?? null, text: m.text }))));
  for (const r of runs) {
    const judged = r.verdict?.checks.find((c) => c.id === 'criteria' || c.id === 'judge') ?? null;
    const verdict = r.verdict ? { pass: r.verdict.pass, score: r.verdict.score, reasoning: judged?.reasoning ?? null } : null;
    lines.push(...block(`${r.id} · ${age(r.createdAt)}`, verdict, r.messages.filter((m) => m.direction === 'out').map((m) => ({ to: m.to ? nameOf(r.participants, m.to) : null, text: m.text })), [r.notes, r.model, formatCost(r.costUsd), r.gatesFailed.length ? `gates: ${r.gatesFailed.join(', ')}` : ''].filter(Boolean).join(' · ')));
  }
  lines.push(...renderNext([[`${cli} freeze diff ${shortId(f.id)} --run ${runs[0] ? runs[0].id : 'A'} --run ${runs[1] ? runs[1].id : 'B'}`, 'two replays against each other'], [`${cli} runs show ${runs[0] ? runs[0].id : '<run>'}`, 'one replay in full']], p));
  return lines.join('\n');
}

export { renderScore };
