import type { ConvoMessage, ProductionReply } from '@platform/evals';
import { UsageError } from '@platform/evals/cli';

import {
  fallbackHandoffBrief,
  HANDOFF_HEAD_MESSAGES,
  HANDOFF_SCAN_LIMIT,
  handoffBriefInput,
  handoffBriefRequest,
  shapeHandoffTranscript,
  type HandoffSourceFacts,
} from '../../../../convex/convex/handoff';
import { isRefusalProse, isSummarizableMessage } from '../../../../convex/convex/idleSummary';
import { readConversation, toConvoMessages, toRows, type MessageRow } from '../../adapters/convo';
import { readSessionMoment, SESSION_LINE_FORMS } from '../../adapters/moment';
import { gate, type SurfaceImpl } from '../../surface';

// The `cast handoff` brief replayed from what handoff.briefInput reads: the
// source's newest rows (up to HANDOFF_SCAN_LIMIT) and its facts. prod's own
// shapeHandoffTranscript, handoffBriefInput and handoffBriefRequest build the
// request, so the replay sends what prod would have sent at that moment.

type Row = Pick<MessageRow, 'role' | 'content' | 'timestamp' | 'line'> & { tool_results?: unknown[] };

type Facts = Pick<HandoffSourceFacts, 'title' | 'agent_type' | 'model' | 'thread_state' | 'task_short_id' | 'plan_short_id'>;

export interface HandoffSnap {
  /** The source's rows at the moment, newest first, at most HANDOFF_SCAN_LIMIT. */
  rows: Row[];
  facts: Facts;
  /** A real handoff: the child it started and the brief prod wrote into it. */
  production?: { child: string; at: number; brief: string };
  approximate?: string[];
}

const REF_FORMS = `handoff@ needs a session and line, like handoff@jx7c6zk:142 (${SESSION_LINE_FORMS}), or the child of a real handoff, like handoff@jx7abcd`;

const HANDOFF_HEADER = /^# Handed off from (\S+): (.*)$/m;

export function handoffSurfaceRequest(snap: HandoffSnap) {
  const messages = shapeHandoffTranscript(snap.rows);
  const input = handoffBriefInput(snap.facts, messages);
  // prod writes a fallback brief, with no model call, when nothing is readable.
  return { input, request: messages.length ? handoffBriefRequest(input) : null };
}

/** The parts of a child's first message (composeHandoffPrompt) a freeze needs. */
export function parseHandoffPrompt(text: string): { source: string; title: string; model: string | null; brief: string; task: string | null; plan: string | null } | null {
  const header = HANDOFF_HEADER.exec(text);
  if (!header) return null;
  const ranOn = /^Ran on .*?(?:\((.+)\))?\.$/m.exec(text);
  const brief = /\n## Brief\n\n([\s\S]*?)\n\n## Read more\n/.exec(text);
  return {
    source: header[1]!,
    title: header[2]!.trim(),
    model: ranOn?.[1]?.trim() || null,
    brief: (brief?.[1] ?? text).trim(),
    task: /cast task context (ct-\d+)/.exec(text)?.[1] ?? null,
    plan: /cast plan context (pl-\d+)/.exec(text)?.[1] ?? null,
  };
}

/** The rows briefInput reads at a moment: the newest HANDOFF_SCAN_LIMIT, newest first, tool results reduced to their presence. */
const sourceRows = (oldestFirst: MessageRow[]): Row[] =>
  oldestFirst
    .slice(-HANDOFF_SCAN_LIMIT)
    .reverse()
    .map((r) => ({ role: r.role, content: r.content, timestamp: r.timestamp, line: r.line, ...(r.tool_results?.length ? { tool_results: r.tool_results.map(() => ({})) } : {}) }));

const APPROXIMATE = [
  'the scan window counts the non-empty rows /cli/read returns; prod takes 400 rows of any kind',
  'the title and agent are the session’s now: /cli/read has no history of them',
];

const impl: SurfaceImpl = {
  refForms: REF_FORMS,

  async capture(ref) {
    if (/^[a-z0-9]+$/i.test(ref)) {
      // A bare id: the child of a real handoff. Its first message names the
      // source and holds the brief prod wrote; the source is read as it was
      // when the child started.
      const child = await readConversation(ref, { from: 1, to: 1 });
      const first = child.messages[0];
      const parsed = first ? parseHandoffPrompt(first.content) : null;
      if (!first || !parsed) throw new UsageError(`${ref} is not the child of a handoff (its first message has no "# Handed off from" header): ${REF_FORMS}`);
      const at = Date.parse(first.timestamp);
      const source = await readConversation(parsed.source);
      const rows = toRows(source.messages).filter((r) => r.timestamp < at);
      if (!rows.length) throw new UsageError(`${parsed.source} had no messages when ${ref} started`);
      const snapshot: HandoffSnap = {
        rows: sourceRows(rows),
        facts: {
          title: parsed.title === 'Untitled session' ? null : parsed.title,
          agent_type: source.conversation.agent_type ?? null,
          model: parsed.model,
          thread_state: null,
          task_short_id: parsed.task,
          plan_short_id: parsed.plan,
        },
        production: { child: child.conversation.id, at, brief: parsed.brief },
        approximate: [...APPROXIMATE.slice(0, 1), 'the pinned state is blank: the handoff overwrote it and /cli/read has no history of it'],
      };
      const last = rows[rows.length - 1]!;
      return {
        snapshot,
        subject: { kind: 'session', id: source.conversation.id, title: source.conversation.title ?? source.conversation.id },
        asOf: new Date(last.timestamp).toISOString(),
        anchor: { kind: 'message', id: `${source.conversation.id}:${last.line}` },
        name: `handoff ${source.conversation.id.slice(0, 7)} to ${child.conversation.id.slice(0, 7)}`,
        meta: { conversation_id: source.conversation.id, line: last.line, child_id: child.conversation.id },
      };
    }
    const m = await readSessionMoment(ref, REF_FORMS);
    const snapshot: HandoffSnap = {
      rows: sourceRows(m.rows),
      facts: { title: m.conversation.title ?? null, agent_type: m.conversation.agent_type ?? null, model: null, thread_state: null, task_short_id: null, plan_short_id: null },
      approximate: [...APPROXIMATE, 'model, pinned state and bound task or plan are blank: /cli/read has no history of them'],
    };
    return {
      snapshot,
      subject: { kind: 'session', id: m.conversation.id, title: m.conversation.title ?? m.conversation.id },
      asOf: new Date(m.at.timestamp).toISOString(),
      anchor: { kind: 'message', id: `${m.conversation.id}:${m.line}` },
      name: `handoff ${m.conversation.id.slice(0, 7)}:${m.line}`,
      meta: { conversation_id: m.conversation.id, line: m.line },
    };
  },

  async replay(snap: HandoffSnap, ctx) {
    const { input, request } = handoffSurfaceRequest(snap);
    if (!request) return { reply: fallbackHandoffBrief(input), extra: { brief_source: 'fallback' } };
    const r = await ctx.call(request);
    return { reply: r.text, extra: { brief_source: 'model', transcript_messages: input.messages.length } };
  },

  gates(_snap: HandoffSnap, out) {
    const brief = out.reply.trim();
    return [
      gate('non-empty', brief.length > 0, brief.length ? `${brief.split(/\s+/).length} words` : 'the brief is empty'),
      gate('no-refusal', !isRefusalProse(brief), isRefusalProse(brief) ? `refusal prose: ${brief.slice(0, 120)}` : 'no first-person refusal opener'),
    ];
  },

  describe(snap: HandoffSnap): ConvoMessage[] {
    // What the brief read: the session facts, then the shaped transcript, each
    // turn at the time and line of the row it came from.
    const { input } = handoffSurfaceRequest(snap);
    const readable = [...snap.rows].reverse().filter(isSummarizableMessage);
    const from = (i: number) => (i < HANDOFF_HEAD_MESSAGES || readable.length === input.messages.length ? readable[i] : readable[readable.length - input.messages.length + i])!;
    const facts = [`Title: ${input.title}`, `Agent: ${input.agent}`, input.task_short_id && `Bound task: ${input.task_short_id}`, input.plan_short_id && `Bound plan: ${input.plan_short_id}`, input.thread_state && `Pinned state: ${input.thread_state}`].filter(Boolean).join('\n');
    const first = readable[0];
    return [
      { n: 0, id: 'handoff-facts', at: new Date(first?.timestamp ?? 0).toISOString(), channel: 'session', isGroup: false, direction: 'system', from: 'session', text: `Session facts:\n${facts}` },
      ...toConvoMessages(input.messages.map((m, i) => ({ role: m.role, content: m.content, line: from(i).line, timestamp: from(i).timestamp }))),
    ];
  },

  productionReply(snap: HandoffSnap): ProductionReply | null {
    if (!snap.production) return null;
    return {
      messages: [{ n: 1, id: 'handoff-brief', at: new Date(snap.production.at).toISOString(), channel: 'session', isGroup: false, direction: 'out', from: 'assistant', text: snap.production.brief }],
    };
  },
};

export default impl;
