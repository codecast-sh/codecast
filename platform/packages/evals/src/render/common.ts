// What every terminal view shares: a voice per participant, a channel tag,
// the day header, the id column. Colour comes from cli-kit's palette so a
// view rendered for a pipe is plain text with the same layout.

import { makePalette, padEnd, truncate, wrapText, type Palette, type RenderOpts, type Style } from '@platform/cli-kit/render';
import { formatDayOffset, formatTimestamp, shortId } from '@platform/cli-kit/format';

import type { ConvoMessage, Participant } from '../model';
import { ASSISTANT_ID, assignHues } from '../story';

export type { Palette, RenderOpts, Style };
export { formatDayOffset, formatTimestamp, makePalette, padEnd, shortId, truncate, wrapText };

const HUES = [33, 172, 141, 75, 168, 108, 209, 67];

/** The style a participant's name and bubble edge take. The assistant is green everywhere; people rotate through hues. */
export function voices(participants: Participant[], p: Palette): Map<string, Style> {
  const hues = assignHues(participants);
  const m = new Map<string, Style>();
  for (const x of participants) {
    if (x.role === 'assistant') m.set(x.id, (s) => p.bold(p.green(s)));
    else if (x.role === 'system') m.set(x.id, p.dim);
    else if (!p.enabled) m.set(x.id, (s) => s);
    else m.set(x.id, p.fg(HUES[(hues.get(x.id) ?? 0) % HUES.length]!));
  }
  return m;
}

export function nameOf(participants: Participant[], id: string): string {
  if (id === 'system') return 'system';
  return participants.find((x) => x.id === id)?.name ?? id;
}

export function roleWord(role: Participant['role']): string {
  switch (role) {
    case 'owner':
      return 'the owner';
    case 'assistant':
      return 'the assistant';
    case 'paired':
      return 'paired';
    case 'persona':
      return 'persona';
    case 'third-party':
      return 'third party';
    case 'system':
      return 'system';
    default:
      return 'unknown';
  }
}

export const CHANNEL_TAG: Record<string, string> = {
  imessage: 'imsg',
  sms: 'sms',
  whatsapp: 'wa',
  telegram: 'tg',
  app: 'app',
  email: 'mail',
  slack: 'slack',
  persona: 'who',
  scenario: 'beat',
  note: 'note',
  boundary: 'edge',
  run: 'run',
};

export function channelTag(channel: string): string {
  return CHANNEL_TAG[channel] ?? channel.slice(0, 5);
}

/** The header line of one message: `#12 ab12cd34  03-05 14:30  imsg  Ada → the assistant`. */
export function messageHead(m: ConvoMessage, participants: Participant[], p: Palette, voice: Map<string, Style>, opts: { start?: string | null; focus?: boolean } = {}): string {
  const who = voice.get(m.from) ?? ((s: string) => s);
  const from = nameOf(participants, m.from);
  const to = m.to ? nameOf(participants, m.to) : null;
  const when = opts.start ? formatDayOffset(m.at, opts.start) : formatTimestamp(m.at);
  const arrow = m.direction === 'system' ? '' : ` ${p.dim('→')} ${m.room ? p.yellow(`#${m.room}`) : to ? (voice.get(m.to!) ?? ((s: string) => s))(to) : ''}`;
  const status = m.status && !['sent', 'received', 'delivered'].includes(m.status) ? ` ${p.red(m.status)}` : '';
  const id = m.id.includes('-') && m.id.length < 12 ? '' : ` ${p.dim(shortId(m.id))}`;
  const mark = opts.focus ? ` ${p.bold(p.yellow('◀ FROZEN HERE'))}` : '';
  return `${p.dim(`#${m.n}`)}${id}  ${p.dim(when)}  ${padEnd(p.dim(channelTag(m.channel)), 5)} ${who(from)}${arrow}${status}${mark}`;
}

/** The body, wrapped and indented; cut to `lines` unless full. */
export function messageBody(m: ConvoMessage, width: number, lines: number | undefined, p: Palette): string[] {
  const body = wrapText(m.text || (m.direction === 'system' ? '' : '(no text)'), Math.max(30, width - 6));
  const cut = lines && body.length > lines ? [...body.slice(0, lines), p.dim(`… ${body.length - lines} more lines (--full)`)] : body;
  const style = m.direction === 'system' ? p.dim : (s: string) => s;
  return cut.map((l) => `      ${style(l)}`);
}

export function dayHeader(at: string, p: Palette): string {
  const d = new Date(at);
  return p.dim(p.bold(d.toISOString().slice(0, 10)) + ' ' + d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }).toLowerCase());
}

export function verdictWord(pass: boolean | null, score: number | null, p: Palette): string {
  if (pass === null || score === null) return p.dim('unscored');
  const txt = `${pass ? 'PASS' : 'FAIL'} ${score.toFixed(2)}`;
  return pass ? p.green(txt) : p.red(txt);
}

export function bar(value: number, width = 10, p?: Palette): string {
  const n = Math.round(Math.max(0, Math.min(1, value)) * width);
  const s = '█'.repeat(n) + '░'.repeat(width - n);
  if (!p) return s;
  return value < 0.5 ? p.red(s) : value < 0.8 ? p.yellow(s) : p.green(s);
}

export { ASSISTANT_ID };
