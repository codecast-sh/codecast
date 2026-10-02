import type { ConvoMessage } from '@platform/evals';
import { UsageError } from '@platform/evals/cli';

import {
  askAnswerRequest,
  askTerms,
  askTermsRequest,
  citationTargets,
  citedLines,
  parseTermsReply,
  questionTerms,
  readRows,
  selectAskContext,
  toAskLine,
  type AskMessage,
} from '../../../../convex/convex/lib/sessionAsk';
import { citationSpans, spanLines } from '../../../../convex/convex/lib/sessionAskCitations';
import { readConversation, toRows, type MessageRow } from '../../adapters/convo';
import { readSessionMoment, SESSION_LINE_FORMS } from '../../adapters/moment';
import { gate, type SurfaceImpl } from '../../surface';

// `cast read <id> --ask "<question>"` replayed as prod runs it: the terms
// call, then the answer over the lines prod's own readRows, selectAskContext
// and buildAskPrompt choose with those terms. The terms reply decides which
// lines match, so the snapshot holds the asked-about session's rows, not a
// selection, and every rep makes both calls.

type Row = Pick<MessageRow, '_id' | 'role' | 'content' | 'timestamp' | 'line' | 'tool_calls' | 'tool_results'>;

export interface AskSnap {
  question: string;
  /** The asked-about session's title, as the prompt prints it. */
  title: string;
  /** The asked-about session's rows when the question was asked, oldest first, each non-empty. */
  rows: Row[];
  /** Where the question was asked, for a real `cast read --ask`. */
  asked_in?: { conversation: string; line: number };
  approximate?: string[];
}

export interface AskParsed {
  /** What parseTermsReply took from the terms call. */
  modelTerms: string[];
  terms: string[];
  /** Every message number the answer cites, and the ones it was shown. */
  cited: number[];
  shown: number[];
  /** The cited numbers that resolve to a shown line (prod's citationTargets). */
  resolved: number[];
  /** The citations that name a line the model was not shown (citationCheck). */
  invented: string[];
  /** Lines inside a cited range that were not shown, between two ends that were. */
  unshownInRanges: number;
}

/**
 * A citation is real when every line it names on its own was shown: a single
 * message, or both ends of a range. A range between two shown lines may pass
 * over lines the budget left out (the prompt marks them "not shown"); those
 * are counted, not called invented.
 */
export function citationCheck(answer: string, shownLines: number[]): Pick<AskParsed, 'invented' | 'unshownInRanges'> {
  const shown = new Set(shownLines);
  const spans = citationSpans(answer);
  const real = spans.filter((s) => shown.has(s.from) && shown.has(s.to));
  return {
    invented: spans.filter((s) => !real.includes(s)).map((s) => `msg ${s.from}${s.to === s.from ? '' : `–${s.to}`}`),
    unshownInRanges: real.reduce((n, s) => n + spanLines(s).filter((l) => !shown.has(l)).length, 0),
  };
}

/** The judge reads the question with a selection made from the question's own words, in this many characters. */
export const JUDGE_CONTEXT_CHARS = 60_000;

const REF_FORMS = `ask@ needs the session line holding a \`cast read <id> --ask "<question>"\` call, like ask@jx7c6zk:142 (${SESSION_LINE_FORMS})`;

const asMessage = (r: Row): AskMessage & { _id: string } => ({
  _id: r._id,
  role: r.role as AskMessage['role'],
  content: r.content,
  timestamp: r.timestamp,
  tool_calls: r.tool_calls?.map((c) => ({ id: c.id, name: String(c.name ?? ''), input: typeof c.input === 'string' ? c.input : JSON.stringify(c.input ?? {}) })),
  tool_results: r.tool_results,
});

/** The text of every Bash command and the prose of a message, where an `--ask` call can sit. */
function commandsOf(row: Row): string[] {
  const out = [row.content];
  for (const c of row.tool_calls ?? []) {
    const raw = typeof c.input === 'string' ? c.input : JSON.stringify(c.input ?? {});
    try {
      const parsed = JSON.parse(raw) as { command?: unknown };
      out.push(typeof parsed.command === 'string' ? parsed.command : raw);
    } catch {
      out.push(raw);
    }
  }
  return out;
}

/**
 * The first `cast read [<id>] ... --ask "<question>"` in some shell text:
 * the session it asks about (null for the asking session itself, the way
 * `cast read --ask` and `cast read self --ask` read it) and the question.
 */
export function parseAskCall(text: string): { target: string | null; question: string } | null {
  const m = /\bcast read((?:\s+(?!--ask\b)[^\s|;&]+)*)\s+--ask\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(text);
  if (!m) return null;
  const question = m[2] !== undefined ? m[2].replace(/\\(["\\$`])/g, '$1') : m[3]!;
  const target = (m[1] ?? '').trim().split(/\s+/).find((w) => w && !w.startsWith('-') && !/^-?\d+(:-?\d+)?$/.test(w)) ?? null;
  return { target: target === 'self' ? null : target, question };
}

export async function askSurfaceRequests(snap: AskSnap, termsReply: string | null) {
  const terms = askTerms(snap.question, termsReply);
  const read = await readRows(snap.rows.map(asMessage), terms);
  return { terms, read, ...askAnswerRequest({ question: snap.question, title: snap.title, read, termCount: terms.length }) };
}

const impl: SurfaceImpl = {
  refForms: REF_FORMS,

  async capture(ref) {
    const m = await readSessionMoment(ref, REF_FORMS);
    const call = commandsOf(m.at).map(parseAskCall).find(Boolean);
    if (!call) throw new UsageError(`line ${m.line} of ${m.conversation.id} has no \`cast read <id> --ask "<question>"\` call: ${REF_FORMS}`);
    if (call.target?.includes('$')) throw new UsageError(`line ${m.line} asks about a shell variable (${call.target}): freeze a line that names the session`);
    const askedAt = m.at.timestamp;
    const target = call.target ? await readConversation(call.target) : null;
    // A session asking about itself reads what was there before this line.
    const self = !target || target.conversation.id === m.conversation.id;
    const title = (self ? m.conversation.title : target.conversation.title) ?? 'Untitled session';
    const rows = self ? m.rows.filter((r) => r.line < m.line) : toRows(target.messages).filter((r) => r.timestamp <= askedAt);
    if (!rows.length) throw new UsageError(`${call.target ?? m.conversation.id} had no messages when line ${m.line} asked about it`);
    const snapshot: AskSnap = {
      question: call.question,
      title,
      rows: rows.map((r) => ({ _id: r._id, role: r.role, content: r.content, timestamp: r.timestamp, line: r.line, ...(r.tool_calls ? { tool_calls: r.tool_calls } : {}), ...(r.tool_results ? { tool_results: r.tool_results } : {}) })),
      asked_in: { conversation: m.conversation.id, line: m.line },
      approximate: [
        'the title is the session title now: /cli/read has no title history',
        'files edited outside tool calls (the change index) are not captured, so a line matches on its own tool calls only',
        '/cli/read carries no subtype or images: a compact_boundary row or an image-only prompt is classed by its text alone',
        'the scan is read whole: a session the 120 s scan budget would have cut is replayed complete',
      ],
    };
    return {
      snapshot,
      subject: { kind: 'session', id: m.conversation.id, title: m.conversation.title ?? m.conversation.id },
      asOf: new Date(askedAt).toISOString(),
      anchor: { kind: 'message', id: `${m.conversation.id}:${m.line}` },
      name: `ask ${m.conversation.id.slice(0, 7)}:${m.line}`,
      meta: { conversation_id: m.conversation.id, line: m.line, asked_about: call.target ?? m.conversation.id },
    };
  },

  async replay(snap: AskSnap, ctx) {
    const termsCall = await ctx.call(askTermsRequest(snap.question));
    const { terms, read, context, request } = await askSurfaceRequests(snap, termsCall.text);
    const answer = await ctx.call(request);
    const shown = new Set(context.shownLines);
    const parsed: AskParsed = {
      modelTerms: parseTermsReply(termsCall.text),
      terms,
      cited: citedLines(answer.text),
      shown: context.shownLines,
      resolved: citationTargets(answer.text, read.lines, shown).map((c) => c.line),
      ...citationCheck(answer.text, context.shownLines),
    };
    return { reply: answer.text, parsed, extra: { terms, shown_lines: context.shownLines.length, matched_lines: context.matchedLines, scanned_lines: read.lines.length } };
  },

  gates(_snap: AskSnap, out) {
    const p = out.parsed as AskParsed;
    const gaps = p.unshownInRanges ? `; its ranges pass over ${p.unshownInRanges} line(s) it was not shown` : '';
    return [
      gate('parse', p.modelTerms.length > 0, p.modelTerms.length ? `terms: ${p.modelTerms.join(', ')}` : `parseTermsReply found no JSON array of strings in the terms reply: ${out.calls[0]?.text.slice(0, 120) ?? '(no call)'}`),
      gate('citations-real', p.invented.length === 0, p.invented.length ? `cites ${p.invented.join(', ')}, which the model was not shown` : p.cited.length ? `every citation names lines it was shown${gaps}` : 'cites no lines'),
    ];
  },

  describe(snap: AskSnap): ConvoMessage[] {
    // The judge's view: the question, then the lines the question's own words
    // select (the answer's selection also used the terms call's words).
    const terms = questionTerms(snap.question);
    const lines = snap.rows.map((r, i) => ({ id: r._id, ...toAskLine(asMessage(r), i + 1, terms) }));
    const context = selectAskContext(lines, { budget: JUDGE_CONTEXT_CHARS, termCount: terms.length });
    const at = snap.rows.length ? snap.rows[snap.rows.length - 1]!.timestamp : 0;
    const msg = (n: number, direction: ConvoMessage['direction'], text: string): ConvoMessage => ({
      n,
      id: `ask-${n}`,
      at: new Date(at).toISOString(),
      channel: 'session',
      isGroup: false,
      direction,
      from: direction === 'in' ? 'user' : 'session',
      text,
    });
    return [
      msg(1, 'in', `Question about the session "${snap.title}" (${snap.rows.length} messages): ${snap.question}`),
      msg(2, 'system', `Excerpts of that session, with gaps marked:\n${context.text}`),
    ];
  },

  productionReply: () => null,
};

export default impl;
