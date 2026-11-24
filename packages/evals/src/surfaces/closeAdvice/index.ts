import { existsSync, readFileSync } from 'node:fs';

import type { CloseAdvice, CloseVerdict } from '@codecast/shared/contracts/closeKind';
import type { ConvoMessage, Score } from '@platform/evals';
import { UsageError } from '@platform/evals/cli';

import { closeAdviceRequest, gatherCloseAdviceInput, parseCloseAdvice } from '../../../../convex/convex/closeAdvice';
import { toConvoMessages } from '../../adapters/convo';
import { gate, type Captured, type SurfaceImpl } from '../../surface';

// Close advice (`cast advise-close`): whether closing a quiet session loses
// anything. The snapshot is every document prod's gatherCloseAdviceInput reads
// for one conversation, frozen with the instant it was asked. A replay runs
// that gather over the frozen documents, the inbox's own classifier included
// (prod's gather runs it), so whatever decides without a model call in prod
// decides here too, and only the residue posts prod's
// closeAdviceRequest; the reply is read with prod's parseCloseAdvice.
//
// Freezing: session refs are not supported (the gather reads rows no CLI route
// returns); freezes come from moment files (or fixtures) only.

export interface CloseAdviceSnap {
  /** The instant the advice was asked (epoch ms): the gather's `now`. */
  now: number;
  conv_id: string;
  /** Table name to the documents the gather may read (conversations, messages, managed_sessions, agent_tasks, users, …). A table held empty was captured empty. */
  docs: Record<string, Array<Record<string, any>>>;
  /**
   * What the moment did not capture, each with why. A read of such a table
   * answers empty and a get of such an id answers null, as if prod held
   * nothing there; any other table or id the gather reaches throws, so a
   * moment can never place differently from prod without saying where.
   */
  uncaptured?: { tables?: Record<string, string>; ids?: Record<string, string> };
  /** Tables captured only in part, each with what is missing: reads answer from what is there. */
  partial?: Record<string, string>;
}

export interface CloseAdviceLabel {
  verdict: CloseVerdict;
  why?: string;
}

const REF_FORMS = 'close-advice@ takes a moment file, like close-advice@file:<moment.json> ({now, conv_id, docs, uncaptured?, partial?}: the documents the gather reads, and what it did not capture)';

/** Why a session ref cannot be frozen here (the header says what would fix it). */
export const NO_SESSION_CAPTURE = 'close-advice freezes come from moment files; a session-ref capture needs a server route that does not exist yet — see the surface\'s header';

/** Convex orders an index by its fields, then by creation; the gather reads messages newest first by timestamp. */
const ORDER_KEY: Record<string, string> = { messages: 'timestamp' };

/** A read-only db over the frozen documents: the get/query/withIndex/eq/order/first/take/collect the gather calls. It throws on a table or id the moment neither holds nor declares uncaptured. */
export function frozenDb(snap: Pick<CloseAdviceSnap, 'docs' | 'uncaptured'>) {
  const { docs } = snap;
  const all = Object.values(docs).flat();
  const uncapturedTables = snap.uncaptured?.tables ?? {};
  const uncapturedIds = snap.uncaptured?.ids ?? {};
  return {
    async get(id: string) {
      const hit = all.find((d) => d._id === id);
      if (hit) return hit;
      if (id in uncapturedIds) return null;
      throw new Error(`the moment holds no document ${id}: capture it, or declare it in uncaptured.ids with why`);
    },
    query(table: string) {
      if (!(table in docs) && !(table in uncapturedTables)) throw new Error(`the moment did not capture table ${table}: capture it, or declare it in uncaptured.tables with why`);
      const eqs: Array<[string, unknown]> = [];
      let desc = false;
      const rows = () => {
        const key = ORDER_KEY[table] ?? '_creationTime';
        const r = (docs[table] ?? []).filter((d) => eqs.every(([f, v]) => String(d[f]) === String(v)));
        r.sort((a, b) => (a[key] ?? 0) - (b[key] ?? 0));
        return desc ? r.reverse() : r;
      };
      const chain = {
        withIndex(_name: string, range: (q: any) => unknown) {
          const q = { eq: (f: string, v: unknown) => (eqs.push([f, v]), q) };
          range(q);
          return chain;
        },
        order(o: string) {
          desc = o === 'desc';
          return chain;
        },
        first: async () => rows()[0] ?? null,
        take: async (n: number) => rows().slice(0, n),
        collect: async () => rows(),
      };
      return chain;
    },
  };
}

export async function convOf(snap: CloseAdviceSnap, db: ReturnType<typeof frozenDb>) {
  const conv = await db.get(snap.conv_id);
  if (!conv) throw new Error(`the snapshot holds no conversation ${snap.conv_id}`);
  return conv;
}

/** Prod's gather over the frozen moment: the advice that decides without a call, or the request the model gets. Every child counts as readable. */
export async function closeAdviceInputFor(snap: CloseAdviceSnap) {
  const db = frozenDb(snap);
  return gatherCloseAdviceInput({ db }, await convOf(snap, db), snap.now, async () => true);
}

const ownMessages = (snap: CloseAdviceSnap) => (snap.docs.messages ?? []).filter((m) => String(m.conversation_id) === String(snap.conv_id)).sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

/** A moment file as the capture reads it: {now, conv_id, docs}, `now` in epoch ms or ISO. */
export function closeAdviceCapture(path: string): Captured {
  if (!existsSync(path)) throw new UsageError(`no moment file ${path}`);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Omit<CloseAdviceSnap, 'now'> & { now: number | string };
  const now = typeof raw.now === 'string' ? Date.parse(raw.now) : raw.now;
  if (!Number.isFinite(now) || !raw.conv_id || !raw.docs) throw new UsageError(`${path} is not a moment: it needs now, conv_id and docs`);
  const snapshot: CloseAdviceSnap = { now, conv_id: raw.conv_id, docs: raw.docs, ...(raw.uncaptured ? { uncaptured: raw.uncaptured } : {}), ...(raw.partial ? { partial: raw.partial } : {}) };
  const conv = (raw.docs.conversations ?? []).find((c) => c._id === raw.conv_id);
  if (!conv) throw new UsageError(`${path} holds no conversation ${raw.conv_id}`);
  const short = conv.short_id ?? String(raw.conv_id).slice(0, 7);
  const newest = ownMessages(snapshot).at(-1);
  return {
    snapshot,
    subject: { kind: 'session', id: raw.conv_id, title: conv.title ?? short },
    asOf: new Date(now).toISOString(),
    anchor: { kind: 'message', id: newest?._id ?? `conversation:${raw.conv_id}` },
    name: `close-advice ${short}`,
    meta: { conversation_id: raw.conv_id, short_id: short },
  };
}

type Parsed = CloseAdvice | null;

const closeAdvice: SurfaceImpl = {
  refForms: REF_FORMS,

  async capture(ref) {
    if (!ref.startsWith('file:')) throw new UsageError(`${NO_SESSION_CAPTURE}. ${REF_FORMS}`);
    return closeAdviceCapture(ref.slice('file:'.length));
  },

  async replay(snap: CloseAdviceSnap, ctx) {
    const input = await closeAdviceInputFor(snap);
    // The placement, the Close facts or a settle verdict decide on their own: prod makes no call, and neither does the replay.
    if ('advice' in input) return { reply: `VERDICT: ${input.advice.verdict}\nREASON: ${input.advice.reason}`, parsed: input.advice, extra: { decided_by: input.advice.decided_by } };
    const r = await ctx.call(closeAdviceRequest(input.facts, input.tail));
    return { reply: r.text, parsed: parseCloseAdvice(r.text) };
  },

  gates(_snap: CloseAdviceSnap, out, label?: CloseAdviceLabel) {
    const advice = out.parsed as Parsed | undefined;
    const verdict = advice?.verdict ?? null;
    const gates = [gate('parse', verdict !== null, verdict ? `VERDICT: ${verdict} (${advice!.decided_by})` : `no close | needs_you verdict parsed from: ${out.reply.slice(0, 120)}`)];
    if (!label?.verdict) return gates;
    // The worst failure: a session that still owed the person something, advised closed.
    if (label.verdict === 'needs_input') gates.push(gate('no-unsafe-close', verdict !== 'close', verdict === 'close' ? `unsafe close: it still owes the person${label.why ? ` (${label.why})` : ''}; advice said close: ${advice!.reason}` : `kept for the person (${verdict ?? 'nothing'})`));
    gates.push(gate('label-match', verdict === label.verdict, `expected ${label.verdict}, got ${verdict ?? 'nothing'}`));
    return gates;
  },

  summarize(scores: Score[]): string[] {
    const failed = (s: Score, id: string) => s.gates.some((g) => g.id === id && !g.pass);
    const unsafe = scores.filter((s) => failed(s, 'no-unsafe-close')).length;
    const unparsed = scores.filter((s) => failed(s, 'parse')).length;
    const missed = scores.filter((s) => failed(s, 'label-match') && !failed(s, 'no-unsafe-close') && !failed(s, 'parse')).length;
    return [`unsafe closes ${unsafe} · kept but closeable ${missed} · unparsed ${unparsed} · of ${scores.length} reps`];
  },

  describe(snap: CloseAdviceSnap): ConvoMessage[] {
    return toConvoMessages(ownMessages(snap).map((m, i) => ({ _id: m._id, role: m.role, content: m.content ?? '', line: i + 1, timestamp: m.timestamp })));
  },

  productionReply: () => null,
};

export default closeAdvice;
