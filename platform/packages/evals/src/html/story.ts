// The pieces a page builds a conversation from: the cast, the timeline
// strip, one bubble, the lane chips. Shared by the run page, the
// conversation page and the freeze page, so a message looks the same
// wherever it is read.

import type { ConvoMessage, Participant } from '../model';
import { ACCENT, dayOffset, esc, hueOf } from './page';

const ROLE_WORD: Record<Participant['role'], string> = {
  owner: 'the owner',
  assistant: 'the assistant',
  paired: 'paired',
  persona: 'persona',
  'third-party': 'third party',
  system: 'system',
  unknown: 'unknown',
};

export function renderCast(participants: Participant[], counts: Map<string, number>): string {
  const cards = participants
    .filter((p) => p.role !== 'system')
    .map((p) => {
      const hue = hueOf(participants, p.id);
      const meta = [p.relationship && p.relationship !== 'a room' ? p.relationship : null, p.disposition ? `${p.disposition}` : null, p.rail].filter(Boolean).join(' · ');
      const n = counts.get(p.id) ?? 0;
      return `<div class="who ${p.role === 'assistant' ? 'assistant' : ''}" style="--hue:${hue}">
  <div class="name"><i></i>${esc(p.name)}<span style="margin-left:auto;font-family:var(--mono);font-size:11px;color:var(--faint)">${n ? `${n} said` : 'silent'}</span></div>
  <div class="role">${esc(p.relationship === 'a room' ? 'room' : ROLE_WORD[p.role])}</div>
  ${meta ? `<div class="meta">${esc(meta)}</div>` : ''}
  ${p.addresses.length ? `<div class="addr">${esc(p.addresses.join(' · '))}</div>` : ''}
  ${p.goal ? `<details><summary>private goal (evidence only)</summary><blockquote>${esc(p.goal)}</blockquote></details>` : ''}
</div>`;
    });
  return `<div class="cast">${cards.join('')}</div>`;
}

export function messageCounts(messages: ConvoMessage[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of messages) if (x.direction !== 'system') m.set(x.from, (m.get(x.from) ?? 0) + 1);
  return m;
}

/** A strip over the run's horizon, one mark per line said, coloured by who said it. */
export function renderStrip(messages: ConvoMessage[], participants: Participant[], start: string, horizonMs: number): string {
  if (!messages.length || !start) return '';
  const t0 = Date.parse(start);
  const end = Math.max(horizonMs, ...messages.map((m) => Date.parse(m.at) - t0), 3_600_000);
  const days: string[] = [];
  for (let d = 0; d * 86_400_000 <= end; d++) {
    days.push(`<div class="day" style="left:${((d * 86_400_000) / end) * 100}%"><span>d${String(d).padStart(2, '0')}</span></div>`);
  }
  const marks = messages.map((m) => {
    const x = Math.max(0, Math.min(100, ((Date.parse(m.at) - t0) / end) * 100));
    const cls = m.direction === 'out' ? 'out' : m.direction === 'in' ? 'in' : 'sys';
    const hollow = m.meta?.kind === 'persona_silent' ? ' hollow' : '';
    const hue = m.direction === 'system' ? hueOf(participants, m.from) : hueOf(participants, m.from);
    const who = participants.find((p) => p.id === m.from)?.name ?? m.from;
    return `<div class="mark ${cls}${hollow}" style="left:${x.toFixed(2)}%;--hue:${hue}" title="${esc(`${dayOffset(m.at, start)} ${who}: ${m.text.slice(0, 120)}`)}"></div>`;
  });
  return `<div class="strip">${days.join('')}${marks.join('')}</div>
<div class="legend"><span>● people, upper row</span><span style="color:${ACCENT}">● the assistant, lower row</span><span>○ chose silence</span><span>· beats and notes</span></div>`;
}

export function lanesOf(messages: ConvoMessage[]): string[] {
  const lanes = new Set<string>();
  for (const m of messages) lanes.add(m.direction === 'system' ? 'beats' : m.channel);
  return [...lanes];
}

export function renderChips(group: string, lanes: string[]): string {
  return `<div class="chips" data-filter="${esc(group)}"><button class="chip on" data-lane="all">everything</button>${lanes.map((l) => `<button class="chip" data-lane="${esc(l)}">${esc(l)}</button>`).join('')}</div>`;
}

const CLAMP_CHARS = 700;

export function renderBubble(m: ConvoMessage, participants: Participant[], start: string | null, group: string, opts: { showRoom?: boolean } = {}): string {
  const lane = m.direction === 'system' ? 'beats' : m.channel;
  const when = dayOffset(m.at, start);
  if (m.direction === 'system') {
    const kind = String(m.meta?.kind ?? '');
    const cls = kind === 'scenario_step' ? 'beat' : kind === 'persona_silent' || kind === 'persona_scheduled' ? 'silent' : kind === 'boundary_blocked' || kind === 'job_failed' ? 'bad' : '';
    return `<div class="sys ${cls}" data-lane-of="${esc(group)}" data-lane="${esc(lane)}"><span class="t">${esc(when)}</span>${esc(m.text)}</div>`;
  }
  const hue = hueOf(participants, m.from);
  const who = participants.find((p) => p.id === m.from)?.name ?? m.from;
  const to = m.to ? (participants.find((p) => p.id === m.to)?.name ?? m.to) : null;
  const long = m.text.length > CLAMP_CHARS;
  const status = m.status && !['sent', 'received', 'delivered'].includes(m.status) ? `<span class="st">${esc(m.status)}</span>` : '';
  const room = m.room && opts.showRoom !== false ? `<span class="room">#${esc(m.room)}</span>` : '';
  return `<div class="msg ${m.direction}" data-lane-of="${esc(group)}" data-lane="${esc(lane)}" style="--hue:${hue}" id="m-${esc(m.id)}">
  <span class="dot"></span>
  <div class="bubble">
    <div class="head"><b>${esc(who)}</b>${to && !m.room ? `<span>→ ${esc(to)}</span>` : ''}${room}<span>${esc(m.channel)}</span><span>${esc(when)}</span>${status}<span style="opacity:.6">#${m.n}</span></div>
    <div class="body${long ? ' clamp' : ''}">${esc(m.text || '(no text)')}</div>${long ? '<div class="more">show all</div>' : ''}
  </div>
</div>`;
}

export function renderFeed(messages: ConvoMessage[], participants: Participant[], start: string | null, group: string, opts: { focusId?: string | null; dayHeaders?: boolean } = {}): string {
  const out: string[] = [];
  let day = '';
  for (const m of messages) {
    const d = m.at.slice(0, 10);
    if (opts.dayHeaders && d !== day) {
      out.push(`<div class="day-h">${esc(new Date(m.at).toISOString().slice(0, 10))} ${esc(new Date(m.at).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }))}</div>`);
      day = d;
    }
    out.push(renderBubble(m, participants, start, group));
    if (opts.focusId && (m.id === opts.focusId || m.id.startsWith(opts.focusId))) out.push(`<div class="frozen">FROZEN HERE · the world is cut at this instant</div>`);
  }
  if (!messages.length) out.push('<div class="card">Nothing was said.</div>');
  return `<div class="story">${out.join('')}</div>`;
}

/** Messages grouped by the room, or by the person on the other end of a private thread. */
export function renderRooms(messages: ConvoMessage[], participants: Participant[], start: string | null): string {
  const groups = new Map<string, { title: string; hueId: string; rows: ConvoMessage[] }>();
  for (const m of messages) {
    if (m.direction === 'system') continue;
    const other = m.direction === 'out' ? m.to : m.from;
    const key = m.room ? `room:${m.room}` : `dm:${other ?? '?'}:${m.channel}`;
    const title = m.room ? `#${m.room}` : `${participants.find((p) => p.id === other)?.name ?? other ?? '?'} · ${m.channel}`;
    const g = groups.get(key) ?? { title, hueId: m.room ? (participants.find((p) => p.name === m.room)?.id ?? other ?? '') : other ?? '', rows: [] };
    g.rows.push(m);
    groups.set(key, g);
  }
  if (!groups.size) return '';
  const cards = [...groups.values()].map(
    (g) => `<div class="room" style="--hue:${hueOf(participants, g.hueId)}"><div class="rh"><b>${esc(g.title)}</b><span class="n">${g.rows.length} messages</span></div><div class="rb">${g.rows.map((m) => renderBubble(m, participants, start, `room-${g.title}`, { showRoom: false })).join('')}</div></div>`,
  );
  return `<div class="rooms">${cards.join('')}</div>`;
}
