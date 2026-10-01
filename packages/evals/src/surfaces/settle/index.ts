import type { ConvoMessage, GateResult } from '@platform/evals';

import { parseSettleReply, SETTLE_TAIL_MESSAGES, settleRequest, shapeSettleTail, type SettleVerdict } from '../../../../convex/convex/idleSummary';
import { toConvoMessages, type MessageRow } from '../../adapters/convo';
import { readSessionMoment, SESSION_LINE_FORMS, type SessionMoment } from '../../adapters/moment';
import type { Captured, SurfaceImpl } from '../../surface';

// Settle: when a session goes quiet, prod reads its newest rows, shapes them
// (shapeSettleTail) and asks the cheap model who acts next (settleRequest).
// The snapshot is exactly the shaper's input, newest first, so a replay sends
// the bytes prod would send for that moment. A fixture's row may omit the
// stored fields the shaper never reads (timestamp, line, ids).

type SettleRow = Pick<MessageRow, 'role' | 'content'> & Partial<Omit<MessageRow, 'role' | 'content'>>;

export interface SettleSnap {
  /** The rows prod's getMessagesForSummary hands shapeSettleTail: the newest SETTLE_TAIL_MESSAGES, newest first. */
  newestFirst: SettleRow[];
}

export interface SettleLabel {
  verdict: SettleVerdict;
}

const REF_FORMS = `settle@ takes a fixture or a session line, like settle@fixture:<case> or settle@jx7c6zk:142 (${SESSION_LINE_FORMS})`;

/** The request prod posts for this moment. */
export const settleRequestFor = (snap: SettleSnap) => settleRequest(shapeSettleTail(snap.newestFirst));

/** Fixtures carry no clock; their rows read as a minute apart, ending here. */
const FIXTURE_CLOCK = Date.parse('2026-09-01T12:00:00.000Z');

/**
 * A session moment as prod's settle query reads it: the newest
 * SETTLE_TAIL_MESSAGES rows up to the moment, newest first. /cli/read numbers
 * only non-empty rows, so the window can reach a few stored rows further back
 * than prod's; the shaper drops empty rows either way.
 */
export function settleCapture(moment: SessionMoment): Captured {
  const id = moment.conversation.id;
  const snapshot: SettleSnap = { newestFirst: moment.rows.slice(-SETTLE_TAIL_MESSAGES).reverse() };
  return {
    snapshot,
    subject: { kind: 'session', id, title: moment.conversation.title ?? id },
    asOf: new Date(moment.at.timestamp).toISOString(),
    anchor: { kind: 'message', id: moment.at._id },
    name: `settle ${id.slice(0, 7)}:${moment.line}`,
    meta: { conversation_id: id, line: moment.line, ...(moment.conversation.model ? { model: moment.conversation.model } : {}) },
  };
}

const gate = (id: string, pass: boolean, summary: string): GateResult => ({ id, pass, decidedBy: 'mechanical', evidence: { summary } });

const settle: SurfaceImpl = {
  refForms: REF_FORMS,

  async capture(ref) {
    return settleCapture(await readSessionMoment(ref, REF_FORMS));
  },

  async replay(snap: SettleSnap, ctx) {
    const r = await ctx.call(settleRequestFor(snap));
    return { reply: r.text, parsed: parseSettleReply(r.text) };
  },

  gates(_snap: SettleSnap, out, label?: SettleLabel) {
    const verdict = (out.parsed as ReturnType<typeof parseSettleReply> | undefined)?.verdict ?? null;
    const gates = [gate('parse', verdict !== null, verdict ? `VERDICT: ${verdict}` : `no VERDICT line parsed from: ${out.reply.slice(0, 120)}`)];
    if (label?.verdict) gates.push(gate('label-match', verdict === label.verdict, `expected ${label.verdict}, got ${verdict ?? 'nothing'}`));
    return gates;
  },

  describe(snap: SettleSnap): ConvoMessage[] {
    const rows = [...snap.newestFirst].reverse();
    return toConvoMessages(rows.map((r, i) => ({ ...r, line: r.line ?? i + 1, timestamp: r.timestamp ?? FIXTURE_CLOCK - (rows.length - 1 - i) * 60_000 })));
  },

  productionReply: () => null,
};

export default settle;
