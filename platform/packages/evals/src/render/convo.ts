// Pure renderers for the conversation views. A conversation prints oldest to
// newest, every message on a numbered header line followed by its body,
// indented; the number is stable for the subject and the 8 character id
// beside it is the handle every other command takes.

import { padEnd, renderNext, renderTable, truncate, type Palette, type RenderOpts } from '@platform/cli-kit/render';
import { formatTimestamp, shortId } from '@platform/cli-kit/format';
import { relativeTime } from '@platform/cli-kit/text';

import type { Conversation, ConvoMessage, ConvoSubject, InboxRow, MessageDetail, Participant, SearchHit } from '../model';
import { channelTag, dayHeader, makePalette, messageBody, messageHead, nameOf, roleWord, voices } from './common';

export interface ConversationViewOpts extends RenderOpts {
  from?: number;
  to?: number;
  /** The last N when no range is given. */
  last?: number;
  around?: number;
  radius?: number;
  /** Body lines per message; `full` shows everything. */
  lines?: number;
  channels?: string[];
  /** Show system lines (runs, decisions, notes). */
  system?: boolean;
  focusId?: string | null;
  /** The instant a run began, when times should read as day offsets. */
  start?: string | null;
  /** The command name for the Next block. */
  cli?: string;
}

export function windowMessages(all: ConvoMessage[], o: ConversationViewOpts): { shown: ConvoMessage[]; hiddenBefore: number; hiddenAfter: number } {
  let rows = all;
  if (o.channels?.length) rows = rows.filter((m) => o.channels!.includes(m.channel) || m.direction === 'system');
  if (!o.system) rows = rows.filter((m) => m.direction !== 'system');
  let shown = rows;
  if (o.around !== undefined) {
    const r = o.radius ?? 6;
    shown = rows.filter((m) => m.n >= o.around! - r && m.n <= o.around! + r);
  } else if (o.from !== undefined || o.to !== undefined) {
    shown = rows.filter((m) => (o.from === undefined || m.n >= o.from) && (o.to === undefined || m.n <= o.to));
  } else if (o.focusId) {
    const at = rows.findIndex((m) => m.id === o.focusId || m.id.startsWith(o.focusId!));
    const r = o.radius ?? 8;
    shown = at >= 0 ? rows.slice(Math.max(0, at - r), at + r + 1) : rows.slice(-(o.last ?? 40));
  } else {
    shown = rows.slice(-(o.last ?? 40));
  }
  const first = shown[0]?.n ?? 0;
  const last = shown[shown.length - 1]?.n ?? 0;
  return { shown, hiddenBefore: rows.filter((m) => m.n < first).length, hiddenAfter: rows.filter((m) => m.n > last).length };
}

export function renderParticipants(participants: Participant[], p: Palette): string[] {
  const voice = voices(participants, p);
  return participants
    .filter((x) => x.role !== 'system')
    .map((x) => {
      const bits = [roleWord(x.role)];
      if (x.relationship && x.relationship !== 'a room') bits.push(x.relationship);
      if (x.disposition) bits.push(x.disposition);
      if (x.rail) bits.push(x.rail);
      const addr = x.addresses.length ? ` ${p.dim(x.addresses.join(', '))}` : '';
      return `  ${(voice.get(x.id) ?? ((s: string) => s))(x.name)}  ${p.dim(bits.join(' · '))}${addr}`;
    });
}

export function renderSubjectHeader(subject: ConvoSubject, participants: Participant[], total: number, p: Palette): string[] {
  const lines = [`${p.bold(p.cyan(subject.title))}  ${p.dim(`${subject.kind} ${shortId(subject.id)}`)}${subject.subtitle ? `  ${p.dim(subject.subtitle)}` : ''}  ${p.dim(`${total} messages`)}`];
  lines.push(...renderParticipants(participants, p));
  return lines;
}

export function renderConversation(c: Conversation, o: ConversationViewOpts): string {
  const p = makePalette(o.color);
  const cli = o.cli ?? 'xrun';
  const voice = voices(c.participants, p);
  const { shown, hiddenBefore, hiddenAfter } = windowMessages(c.messages, o);
  const lines: string[] = [...renderSubjectHeader(c.subject, c.participants, c.total, p), ''];
  if (hiddenBefore) lines.push(p.dim(`  … ${hiddenBefore} earlier (--from ${Math.max(1, (shown[0]?.n ?? 1) - 20)} --to ${shown[0]?.n ?? 1})`), '');
  let day = '';
  for (const m of shown) {
    const d = m.at.slice(0, 10);
    if (d !== day && !o.start) {
      lines.push(dayHeader(m.at, p));
      day = d;
    }
    lines.push(messageHead(m, c.participants, p, voice, { start: o.start, focus: Boolean(o.focusId && (m.id === o.focusId || m.id.startsWith(o.focusId))) }));
    lines.push(...messageBody(m, o.width, o.full ? undefined : (o.lines ?? 6), p));
    lines.push('');
  }
  if (shown.length === 0) lines.push(p.dim('  nothing in this window'), '');
  if (hiddenAfter) lines.push(p.dim(`  … ${hiddenAfter} later (--from ${(shown[shown.length - 1]?.n ?? 0) + 1})`), '');
  const last = shown[shown.length - 1];
  const next: Array<[string, string]> = [];
  if (last) next.push([`${cli} convo msg ${shortId(last.id)}`, 'one message in full, with the run behind it']);
  if (last && last.direction === 'in') next.push([`${cli} freeze create ${shortId(last.id)}`, 'freeze this moment and replay the assistant from it']);
  next.push([`${cli} convo show ${shortId(c.subject.id)} --around ${last?.n ?? 1}`, 'window by message number']);
  if (!o.system) next.push([`${cli} convo show ${shortId(c.subject.id)} --system`, 'with the runs, decisions and notes between']);
  lines.push(...renderNext(next, p));
  return lines.join('\n');
}

export function renderMessage(d: MessageDetail, o: RenderOpts & { cli?: string }): string {
  const p = makePalette(o.color);
  const cli = o.cli ?? 'xrun';
  const m = d.message;
  const lines: string[] = [];
  lines.push(`${p.bold(p.cyan(`#${m.n}`))} ${p.dim(m.id)}  ${p.dim(`in ${d.subject.title} (${d.subject.kind} ${shortId(d.subject.id)})`)}`);
  const fields: Array<[string, string]> = [
    ['at', formatTimestamp(m.at)],
    ['channel', `${m.channel}${m.channelId ? ` ${shortId(m.channelId)}` : ''}${m.isGroup ? ' (group)' : ''}`],
    ['from', `${d.participant?.name ?? m.from}${d.participant ? ` (${roleWord(d.participant.role)})` : ''}`],
    ['to', m.to ?? ''],
    ['status', m.status ?? ''],
    ['run', d.run ? `${shortId(d.run.id)} ${d.run.status}${d.run.costUsd != null ? ` $${d.run.costUsd.toFixed(4)}` : ''}${d.run.steps != null ? ` ${d.run.steps} steps` : ''}` : (m.runId ? shortId(m.runId) : '')],
  ];
  const w = Math.max(...fields.map(([k]) => k.length)) + 2;
  for (const [k, v] of fields) if (v) lines.push(`${padEnd(p.dim(k), w)}${v}`);
  lines.push('');
  lines.push(...messageBody({ ...m, direction: m.direction === 'system' ? 'in' : m.direction }, o.width, undefined, p));
  if (m.media?.length) {
    lines.push('');
    for (const f of m.media) lines.push(`      ${p.dim('attachment')} ${f.name ?? f.kind ?? f.url ?? ''}`);
  }
  if (d.run?.digest) {
    lines.push('', p.dim('what the run said about itself:'));
    lines.push(...messageBody({ ...m, text: d.run.digest, direction: 'system' }, o.width, undefined, p));
  }
  lines.push('');
  const next: Array<[string, string]> = [[`${cli} convo show ${shortId(d.subject.id)} --around ${m.n}`, 'the conversation around it']];
  if (m.direction === 'in') next.push([`${cli} freeze create ${shortId(m.id)}`, 'freeze here and replay the assistant']);
  lines.push(...renderNext(next, p));
  return lines.join('\n');
}

export function renderInbox(rows: InboxRow[], o: RenderOpts & { cli?: string }): string {
  const p = makePalette(o.color);
  const cli = o.cli ?? 'xrun';
  const lines = [`${p.bold(p.cyan('Inbox'))}  ${p.dim(`${rows.length} latest inbound, newest first; ! = nobody replied yet`)}`, ''];
  if (rows.length === 0) lines.push(p.dim('  nothing inbound in this window'));
  lines.push(
    ...renderTable(
      rows,
      [
        { header: '', width: 1, value: (r) => (r.unanswered ? '!' : ''), style: () => p.yellow },
        { header: 'id', width: 8, value: (r) => shortId(r.messageId), style: () => p.dim },
        { header: 'age', width: 4, align: 'right', value: (r) => relativeTime(Date.parse(r.at)) },
        { header: 'ch', width: 5, value: (r) => channelTag(r.channel), style: () => p.dim },
        { header: 'who', width: 26, value: (r) => (r.from === r.subject.title ? r.from : `${r.from} · ${r.subject.title}`) },
        { header: 'said', value: (r) => truncate(r.preview.replace(/\s+/g, ' '), 200) },
      ],
      p,
      o.width,
    ),
  );
  lines.push('');
  const first = rows[0];
  lines.push(
    ...renderNext(
      [
        [`${cli} convo show ${first ? shortId(first.messageId) : '<id>'}`, 'open the conversation focused on that message'],
        [`${cli} convo inbox --unanswered --since 48h`, 'only what nobody answered'],
        [`${cli} freeze create ${first ? shortId(first.messageId) : '<id>'}`, 'freeze the moment the assistant had to act'],
      ],
      p,
    ),
  );
  return lines.join('\n');
}

export function renderSearch(hits: SearchHit[], query: string, o: RenderOpts & { cli?: string }): string {
  const p = makePalette(o.color);
  const cli = o.cli ?? 'xrun';
  const lines = [`${p.bold(p.cyan('Search'))} ${p.dim(`"${query}"`)}  ${p.dim(`${hits.length} hits`)}`, ''];
  if (!hits.length) lines.push(p.dim('  nothing matched'));
  lines.push(
    ...renderTable(
      hits,
      [
        { header: 'id', width: 8, value: (h) => shortId(h.messageId), style: () => p.dim },
        { header: 'when', width: 16, value: (h) => formatTimestamp(h.at), style: () => p.dim },
        { header: 'ch', width: 5, value: (h) => channelTag(h.channel), style: () => p.dim },
        { header: 'who', width: 22, value: (h) => `${h.from} · ${h.subject.title}` },
        { header: 'excerpt', value: (h) => h.excerpt },
      ],
      p,
      o.width,
    ),
  );
  lines.push('', ...renderNext([[`${cli} convo msg ${hits[0] ? shortId(hits[0].messageId) : '<id>'}`, 'the message in full']], p));
  return lines.join('\n');
}

export function renderCandidates(candidates: ConvoSubject[], ref: string, o: RenderOpts & { cli?: string }): string {
  const p = makePalette(o.color);
  const cli = o.cli ?? 'xrun';
  const lines = [`${p.yellow(`"${ref}" matches ${candidates.length} subjects`)}`, ''];
  candidates.forEach((c, i) => lines.push(`  ${p.dim(String(i + 1).padStart(2))}  ${c.title}  ${p.dim(`${c.kind} ${c.id}`)}${c.subtitle ? `  ${p.dim(c.subtitle)}` : ''}`));
  lines.push('', ...renderNext([[`${cli} convo show ${candidates[0] ? shortId(candidates[0].id) : '<id>'}`, 'pick one by id']], p));
  return lines.join('\n');
}

export function renderWho(c: Conversation, o: RenderOpts & { cli?: string }): string {
  const p = makePalette(o.color);
  const cli = o.cli ?? 'xrun';
  const lines = [...renderSubjectHeader(c.subject, c.participants, c.total, p), ''];
  const first = c.messages[0];
  const last = c.messages[c.messages.length - 1];
  if (first && last) lines.push(p.dim(`  from ${formatTimestamp(first.at)} to ${formatTimestamp(last.at)}`), '');
  lines.push(...renderNext([[`${cli} convo show ${shortId(c.subject.id)}`, 'the conversation']], p));
  return lines.join('\n');
}

export { nameOf };
