/**
 * The story of a run, and who is in it.
 *
 * A run leaves events and sends behind; a reader wants voices. This turns
 * them into participants with roles and a single timeline of what everybody
 * said, with the beats and silences between, so the terminal and the page
 * render one shape for a scenario with one person and one with a room of
 * three.
 *
 * A roster written by the harness (`roster.json`, or a `roster` event) is
 * the truth when it exists. Without one the cast is derived: the owner is
 * whoever the front door admitted as owner, the assistant is whoever sent,
 * a paired person is one the front door admitted as paired, and everybody
 * else is named by their address.
 */

import type { Audience, ConvoMessage, Participant, ParticipantRole, RunEvent, RunSend } from './model';

export const ASSISTANT_ID = 'assistant';

/** The hue index a participant renders with, by role and order. The assistant is always the accent and never a hue. */
export function assignHues(participants: Participant[]): Map<string, number> {
  const hues = new Map<string, number>();
  let next = 0;
  for (const p of participants) {
    if (p.role === 'assistant' || p.role === 'system') continue;
    hues.set(p.id, next++);
  }
  return hues;
}

export interface Roster {
  owner?: { id?: string; name?: string; addresses?: string[]; address?: string; rail?: string | null } | null;
  assistant?: { name?: string; addresses?: string[] } | null;
  personas?: Array<{ id: string; name: string; relationship?: string | null; rail?: string | null; address?: string; addresses?: string[]; disposition?: string | null; goal?: string | null; role?: ParticipantRole }>;
  rooms?: Array<{ id: string; title?: string | null; address?: string; rail?: string | null; members?: string[] }>;
}

const rosterEvent = (events: RunEvent[]): Roster | null => {
  const ev = events.find((e) => e.kind === 'roster');
  return ev ? (ev.payload as Roster) : null;
};

const addressesOf = (p: { address?: string; addresses?: string[] }): string[] => [...(p.addresses ?? []), ...(p.address ? [p.address] : [])].filter((a, i, all) => all.indexOf(a) === i);

const inboundIdentity = (payload: Record<string, unknown>): string | null => (typeof payload.identity === 'string' ? payload.identity : null);

/**
 * Who is in the run. Roster first, then everything the events and sends
 * reveal, in the order people first appear.
 */
export function deriveParticipants(events: RunEvent[], sends: RunSend[], roster?: Roster | null): Participant[] {
  const r = roster ?? rosterEvent(events);
  const out: Participant[] = [];
  const byAddress = new Map<string, Participant>();
  const add = (p: Participant): Participant => {
    out.push(p);
    for (const a of p.addresses) byAddress.set(a, p);
    return p;
  };
  const find = (address: string | null | undefined): Participant | undefined => (address ? byAddress.get(address) : undefined);

  add({ id: ASSISTANT_ID, name: r?.assistant?.name ?? 'the assistant', role: 'assistant', addresses: r?.assistant?.addresses ?? [] });
  if (r?.owner) add({ id: r.owner.id ?? 'owner', name: r.owner.name ?? 'the owner', role: 'owner', addresses: addressesOf(r.owner), rail: r.owner.rail ?? null });
  for (const p of r?.personas ?? []) {
    add({ id: p.id, name: p.name, role: p.role ?? 'persona', addresses: addressesOf(p), rail: p.rail ?? null, relationship: p.relationship ?? null, disposition: p.disposition ?? null, goal: p.goal ?? null });
  }
  for (const room of r?.rooms ?? []) {
    add({ id: room.id, name: room.title ?? room.id, role: 'unknown', addresses: addressesOf(room), rail: room.rail ?? null, relationship: 'a room' });
  }

  let strangers = 0;
  for (const e of events) {
    if (e.kind !== 'inbound_injected') continue;
    const from = typeof e.payload.from === 'string' ? e.payload.from : null;
    if (!from || find(from)) continue;
    const identity = inboundIdentity(e.payload);
    if (identity === 'owner') add({ id: 'owner', name: 'the owner', role: 'owner', addresses: [from], rail: typeof e.payload.kind === 'string' ? e.payload.kind : null });
    else if (identity === 'paired') add({ id: `paired-${from}`, name: `paired ${from}`, role: 'paired', addresses: [from], rail: typeof e.payload.kind === 'string' ? e.payload.kind : null });
    else add({ id: `person-${++strangers}`, name: from, role: identity === 'restricted' ? 'third-party' : 'unknown', addresses: [from], rail: typeof e.payload.kind === 'string' ? e.payload.kind : null });
  }
  for (const s of sends) {
    if (!s.to || find(s.to)) continue;
    const role: ParticipantRole = s.audience === 'owner' ? 'owner' : s.audience === 'paired' ? 'paired' : s.audience === 'third-party' ? 'third-party' : 'unknown';
    if (s.audience === 'room' || s.isGroup) add({ id: `room-${s.to}`, name: s.to, role: 'unknown', addresses: [s.to], rail: s.rail, relationship: 'a room' });
    else add({ id: role === 'owner' ? 'owner' : `${role}-${s.to}`, name: role === 'owner' ? 'the owner' : s.to, role, addresses: [s.to], rail: s.rail });
  }
  return out;
}

const participantByAddress = (participants: Participant[]): Map<string, Participant> => {
  const m = new Map<string, Participant>();
  for (const p of participants) for (const a of p.addresses) m.set(a, p);
  return m;
};

const roomOf = (participants: Participant[], address: string | null | undefined): Participant | null => {
  if (!address) return null;
  const p = participants.find((x) => x.relationship === 'a room' && x.addresses.includes(address));
  return p ?? null;
};

/** Which sends and inbound events count as an OUT line: a persona hearing is derived from these too. */
export function buildStory(events: RunEvent[], sends: RunSend[], participants: Participant[]): ConvoMessage[] {
  const byAddress = participantByAddress(participants);
  const rows: Array<Omit<ConvoMessage, 'n'> & { seq: number }> = [];
  const personaName = (id: unknown): string => {
    const p = participants.find((x) => x.id === id);
    return p?.name ?? String(id ?? 'somebody');
  };

  for (const s of sends) {
    const room = s.isGroup || s.audience === 'room' ? roomOf(participants, s.to) : null;
    const to = s.to ? (byAddress.get(s.to)?.id ?? s.to) : null;
    rows.push({
      seq: s.seq,
      id: s.messageId ?? `send-${s.seq}`,
      at: s.at,
      channel: s.rail ?? s.label ?? 'unknown',
      channelId: s.channelId ?? null,
      room: room?.name ?? null,
      isGroup: Boolean(s.isGroup || s.audience === 'room'),
      direction: 'out',
      from: ASSISTANT_ID,
      to,
      text: s.text,
      status: 'sent',
      runId: s.runId ?? null,
      meta: { audience: s.audience, label: s.label ?? null, seq: s.seq },
    });
  }
  const sentSeqs = new Set(sends.map((s) => s.seq));
  for (const e of events) {
    const q = e.payload;
    switch (e.kind) {
      case 'inbound_injected': {
        const from = typeof q.from === 'string' ? q.from : '';
        const to = typeof q.to === 'string' ? q.to : null;
        const room = to && to !== from ? roomOf(participants, to) : null;
        rows.push({
          seq: e.seq,
          id: `in-${e.seq}`,
          at: e.virtualAt,
          channel: typeof q.kind === 'string' ? q.kind : 'unknown',
          room: room?.name ?? null,
          isGroup: Boolean(room),
          direction: 'in',
          from: byAddress.get(from)?.id ?? from,
          to: room ? room.id : ASSISTANT_ID,
          text: typeof q.text === 'string' ? q.text : '',
          status: q.accepted === false ? 'refused' : 'received',
          meta: { identity: q.identity ?? null, wakes: Array.isArray(q.wakes) ? q.wakes.length : 0 },
        });
        break;
      }
      case 'send_captured': {
        // A capture the sends list already carries is the same line; one the
        // list dropped (no recipient the boundary could read) is still worth
        // a system line, because something left the process.
        if (sentSeqs.has(e.seq)) break;
        const detail = (q.detail ?? {}) as Record<string, unknown>;
        if (typeof detail.text === 'string' || typeof detail.to === 'string') break;
        rows.push({ seq: e.seq, id: `cap-${e.seq}`, at: e.virtualAt, channel: String(q.label ?? 'boundary'), isGroup: false, direction: 'system', from: 'system', text: `${String(q.method ?? '')} ${String(q.url ?? '')} caught at ${String(q.label ?? 'the boundary')}`, meta: { kind: e.kind } });
        break;
      }
      case 'persona_silent':
        rows.push({ seq: e.seq, id: `silent-${e.seq}`, at: e.virtualAt, channel: 'persona', isGroup: Boolean(q.room), room: q.room ? (roomOf(participants, String(q.room))?.name ?? String(q.room)) : null, direction: 'system', from: String(q.persona ?? 'somebody'), text: `${personaName(q.persona)} said nothing: ${String(q.reason ?? 'no reason given')}`, meta: { kind: e.kind, persona: q.persona, reason: q.reason, decidedBy: q.decidedBy } });
        break;
      case 'persona_scheduled':
        rows.push({ seq: e.seq, id: `sched-${e.seq}`, at: e.virtualAt, channel: 'persona', isGroup: false, direction: 'system', from: String(q.persona ?? 'somebody'), text: `${personaName(q.persona)} will answer in ${Number(q.delayHours ?? 0).toFixed(1)}h (${String(q.reason ?? '')})`, meta: { kind: e.kind, persona: q.persona, delayHours: q.delayHours } });
        break;
      case 'scenario_step':
        rows.push({ seq: e.seq, id: `beat-${e.seq}`, at: e.virtualAt, channel: 'scenario', isGroup: false, direction: 'system', from: 'system', text: String(q.label ?? 'a beat'), meta: { kind: e.kind } });
        break;
      case 'note':
        rows.push({ seq: e.seq, id: `note-${e.seq}`, at: e.virtualAt, channel: 'note', isGroup: false, direction: 'system', from: 'system', text: String(q.text ?? ''), meta: { kind: e.kind, ...q } });
        break;
      case 'job_failed':
        rows.push({ seq: e.seq, id: `fail-${e.seq}`, at: e.virtualAt, channel: 'run', isGroup: false, direction: 'system', from: 'system', text: `a run failed: ${String(q.error ?? '')}`, status: 'failed', meta: { kind: e.kind, runId: q.runId } });
        break;
      case 'boundary_blocked':
        rows.push({ seq: e.seq, id: `block-${e.seq}`, at: e.virtualAt, channel: 'boundary', isGroup: false, direction: 'system', from: 'system', text: `BLOCKED ${String(q.method ?? '')} ${String(q.url ?? q.host ?? '')}: a host on no rule`, status: 'failed', meta: { kind: e.kind } });
        break;
      default:
        break;
    }
  }
  rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.seq - b.seq);
  // A beat that fires on a grid ("the machine looks for work", every four
  // minutes) is one line saying how often, not a page of the same sentence.
  const collapsed: typeof rows = [];
  for (const row of rows) {
    const prev = collapsed[collapsed.length - 1];
    if (prev && prev.direction === 'system' && row.direction === 'system' && prev.text === row.text && prev.meta?.kind === row.meta?.kind) {
      prev.meta = { ...prev.meta, repeats: Number(prev.meta?.repeats ?? 1) + 1, lastAt: row.at };
      continue;
    }
    collapsed.push({ ...row, meta: { ...row.meta } });
  }
  return collapsed.map((row, i) => {
    const { seq: _seq, ...rest } = row;
    const repeats = Number(rest.meta?.repeats ?? 1);
    return { n: i + 1, ...rest, text: repeats > 1 ? `${rest.text} (×${repeats}, until ${String(rest.meta?.lastAt ?? '').slice(11, 16)})` : rest.text };
  });
}

export const AUDIENCE_WORDS: Record<Audience, string> = {
  owner: 'the owner',
  paired: 'somebody the owner paired',
  room: 'a room',
  'third-party': 'a third party',
  unknown: 'an address with no channel',
};
