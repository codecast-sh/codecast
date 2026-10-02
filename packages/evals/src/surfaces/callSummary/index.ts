import { spawnSync } from 'node:child_process';

import type { ConvoMessage, ProductionReply } from '@platform/evals';
import { UsageError } from '@platform/evals/cli';

import {
  callSummaryKind,
  callSummaryRequest,
  callSummarySource,
  countWords,
  parseCallSummaryReply,
  SUMMARY_MAX_CHARS,
  SUMMARY_MIN_WORDS,
  type CallSummaryKind,
} from '../../../../convex/convex/transcripts';
import { gate, type SurfaceImpl } from '../../surface';

// A call's summary replayed from its transcript lines. The source text, the
// skip under 40 words and the 60,000 character tail are prod's
// callSummarySource; the prompt is prod's callSummaryRequest; the reply is
// read with prod's parseCallSummaryReply.

export interface CallSummarySnap {
  /** The transcript, one line per segment, oldest first. */
  lines: Array<{ speaker: string; text: string; at?: number }>;
  kind: CallSummaryKind;
  started_at: number;
  ended_at?: number;
  /** A recap of a call still going. */
  rolling?: boolean;
  /** What prod stored for the call, when it had summarized it. */
  production?: { title?: string | null; summary?: string | null; action_items?: string[] };
}

type Parsed = ReturnType<typeof parseCallSummaryReply> | { error: string } | null;

/** A fixture's label: the owner of each action item the call holds, one entry per item (prod's format puts the owner's name first). */
export interface CallSummaryLabel {
  owners?: string[];
}

/** The owner an action item names: the text before its first colon, as prod's prompt asks ("Sam: ship the fix"). */
const ownerOf = (item: string): string => (item.includes(':') ? item.slice(0, item.indexOf(':')).replace(/\s*\([^)]*\)/g, '').trim() : '(no owner)');

const REF_FORMS = 'call-summary@ needs a call id, like call-summary@<callId> (from `cast calls`)';

export function callSummarySurfaceRequest(snap: CallSummarySnap) {
  const source = callSummarySource(snap.lines, snap.kind);
  return source === null ? null : callSummaryRequest(source, { kind: snap.kind, started_at: snap.started_at, ended_at: snap.ended_at, rolling: snap.rolling });
}

/** The text a huddle or recording source is cut from, before the tail rule. */
const fullText = (snap: CallSummarySnap): string => (snap.kind === 'recording' ? snap.lines.map((l) => l.text) : snap.lines.map((l) => `${l.speaker}: ${l.text}`)).join('\n');

/** `cast call <id> --json`, through the real cast and its access checks. */
function readCall(ref: string): any {
  const r = spawnSync('cast', ['call', ref, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new UsageError(`cast call ${ref} --json failed: ${(r.stderr || r.stdout || '').trim().split('\n').pop()}`);
  return JSON.parse(r.stdout);
}

export function callSnapshot(call: any): CallSummarySnap {
  const segments = [...(call.segments ?? [])].sort((a: any, b: any) => Number(a.seq ?? 0) - Number(b.seq ?? 0));
  return {
    lines: segments.map((s: any) => ({ speaker: String(s.speaker_name ?? ''), text: String(s.text ?? ''), ...(typeof s.at === 'number' ? { at: s.at } : {}) })),
    kind: callSummaryKind(String(call.room_key ?? '')),
    started_at: Number(call.started_at),
    ...(call.ended_at ? { ended_at: Number(call.ended_at) } : {}),
    rolling: call.status === 'live',
    ...(call.summary || call.action_items?.length ? { production: { title: call.title ?? null, summary: call.summary ?? null, action_items: call.action_items ?? [] } } : {}),
  };
}

const impl: SurfaceImpl = {
  refForms: REF_FORMS,

  async capture(ref) {
    const call = readCall(ref);
    const snapshot = callSnapshot(call);
    const id = String(call._id);
    return {
      snapshot,
      subject: { kind: 'call', id, title: String(call.title ?? id) },
      asOf: new Date(snapshot.ended_at ?? Date.now()).toISOString(),
      anchor: { kind: 'message', id },
      name: `call-summary ${id.slice(0, 8)}`,
      meta: { call_id: id },
    };
  },

  async replay(snap: CallSummarySnap, ctx) {
    const req = callSummarySurfaceRequest(snap);
    // Under 40 words prod skips the model call; so does the replay.
    if (!req) return { reply: '', parsed: null, extra: { skipped: true } };
    const r = await ctx.call(req);
    let parsed: Parsed;
    try {
      parsed = parseCallSummaryReply(r.text);
    } catch (e) {
      parsed = { error: e instanceof Error ? e.message : String(e) };
    }
    if (!parsed || 'error' in parsed) return { reply: r.text, parsed };
    return { reply: [parsed.title, parsed.summary, ...(parsed.action_items ?? []).map((a) => `- ${a}`)].filter(Boolean).join('\n'), parsed };
  },

  gates(snap: CallSummarySnap, out, label?: CallSummaryLabel) {
    const words = countWords(snap.lines.map((l) => l.text));
    const short = words < SUMMARY_MIN_WORDS;
    const called = out.calls.length > 0;
    const gates = [gate('skip-honored', short !== called, short ? (called ? `${words} words should skip the model, but a call was made` : `${words} words: no call, as prod`) : called ? `${words} words: summarized` : `${words} words should be summarized, but no call was made`)];
    if (!called) return gates;
    const text = fullText(snap);
    const tail = text.slice(-SUMMARY_MAX_CHARS);
    const prompt = out.calls[0]!.request.prompt;
    // The source is exactly the kept tail: everything after the prompt's "Transcript:" line.
    const kept = prompt.endsWith(`Transcript:\n${tail}`);
    gates.push(gate('tail-rule', kept, kept ? (text.length > SUMMARY_MAX_CHARS ? `kept the last ${SUMMARY_MAX_CHARS} of ${text.length} characters` : `the whole ${text.length} characters fit`) : 'the prompt does not end with the transcript tail'));
    const parsed = out.parsed as Parsed;
    const ok = Boolean(parsed && !('error' in parsed) && parsed.summary && Array.isArray(parsed.action_items));
    gates.push(gate('parse', ok, ok ? 'title, summary and action items parse' : parsed && 'error' in parsed ? parsed.error : 'the JSON has no summary or no action_items array'));
    if (ok && label?.owners) {
      const got = (parsed as { action_items: string[] }).action_items.map(ownerOf).sort();
      const want = [...label.owners].sort();
      const same = got.length === want.length && got.every((o, i) => o === want[i]);
      gates.push(gate('owners-credited', same, same ? `one item each for ${want.join(', ')}` : `items credit ${got.join(', ') || 'nobody'}; the call's commitments belong to ${want.join(', ')}`));
    }
    return gates;
  },

  describe(snap: CallSummarySnap): ConvoMessage[] {
    return snap.lines.map((l, i) => ({
      n: i + 1,
      id: `seg-${i + 1}`,
      at: new Date(l.at ?? snap.started_at).toISOString(),
      channel: 'call',
      isGroup: true,
      direction: 'in',
      from: snap.kind === 'recording' ? 'room' : l.speaker,
      text: snap.kind === 'recording' ? l.text : `${l.speaker}: ${l.text}`,
    }));
  },

  productionReply(snap: CallSummarySnap): ProductionReply | null {
    const p = snap.production;
    if (!p) return null;
    const text = [p.title, p.summary, ...(p.action_items ?? []).map((a) => `- ${a}`)].filter(Boolean).join('\n');
    return { messages: [{ n: 1, id: 'stored-summary', at: new Date(snap.ended_at ?? snap.started_at).toISOString(), channel: 'call', isGroup: true, direction: 'out', from: 'assistant', text }] };
  },
};

export default impl;
