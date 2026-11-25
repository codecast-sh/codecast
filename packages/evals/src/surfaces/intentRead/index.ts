import type { ConvoMessage } from '@platform/evals';
import { UsageError } from '@platform/evals/cli';

import { mayBeTyped, typedPart } from '../../../../convex/convex/lib/messageProvenance';
import { parseDecisionAnswer } from '../../../../shared/contracts';
import { normalizeQuote } from '../../../../convex/convex/lib/originatorChain';
import { parseJsonBlock } from '../../../../convex/convex/lib/anthropic';
import { blindDiff } from '../../../../cli/src/workflow/blindChange';
import { fitAskerRecord } from '../../../../cli/src/workflow/flowAsker';
import { parseWorkflowSource } from '../../../../cli/src/workflow/parser';
import { callNodeBody, taskProseVars } from '../../../../cli/src/workflow/runner';
import { BUILTIN_WORKFLOW_TEMPLATES } from '../../../../cli/src/workflow/templates';
import { castJson } from '../../adapters/cast';
import { apiConfig, readConversation, toConvoMessages } from '../../adapters/convo';
import { REPO_ROOT } from '../../paths';
import { gate, type Captured, type SurfaceImpl, type SurfaceRequest } from '../../surface';
import { optionIsShip } from '@codecast/shared/contracts/shipAnswer';

// The intent segment's Read station (intent.cast, flows.md FL4) replayed as a
// run posts it: the asker's record rendered by the real flowAsker (one
// chronological list, timestamps, card answers, the newest-whole fit), the
// change as `cast flow blind diff` prints it, and the task's prose, through
// the station's own prompt and callNodeBody. The gates read the answer the way
// the segment and the server do: the read -> clear edge, then the citation
// check (verifyCitation's quote and verdict rules over the lines the read was
// given). A label says whether the run should clear, and what ship and
// in_scope should be.

export interface IntentTyped {
  short_id: string;
  line: number;
  user_name: string | null;
  provenance: 'typed_composer' | 'typed_local';
  text: string;
  created_at: string;
}

/** A person's answer to a decision card, as /cli/sessions/originator returns it (originator.ts CardLine). */
export interface IntentCard {
  card: string;
  session_short_id?: string;
  on_task?: true;
  question: string;
  answer: string;
  note?: string;
  user_name: string | null;
  created_at: string;
}

export interface IntentReadSnap {
  starter_name: string;
  typed: IntentTyped[];
  cards?: IntentCard[];
  task: { short_id: string; title: string; description: string };
  change: { files: number; added: number; removed: number; text: string };
  /** What the run should do, set at capture (`=clear` or `=ask`); a label overrides it. */
  expected?: IntentReadLabel;
  approximate?: string[];
}

export interface IntentReadLabel {
  /** The run lands with no card. */
  clears: boolean;
  ship?: boolean;
  in_scope?: boolean;
}

type Answer = { ship: boolean; session: string; line: number; card?: string; quote: string; in_scope: boolean; why: string };

const REF_FORMS = `intent-read@ takes a fixture or a real moment, like intent-read@fixture:<case> or intent-read@ct-98877:sd-4278:jx74md0:198fcb760^..198fcb760:sd-4263:not=1=clear (the task, the approval card whose posting is the moment, the session the person typed in, the change's commits on main, the task's earlier approval cards a person answered, lines a program wrote that the offline filter keeps, and whether the run should clear or ask; the cards the session asked come from its answer frames)`;

const graph = () => parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.intent!);

/** What the Asker station records for the moment: flowAsker's fit of the lines and card answers. */
export function askerRecordOf(snap: IntentReadSnap): Record<string, unknown> {
  return fitAskerRecord({ chain: [], starter_id: 'starter', starter_name: snap.starter_name, typed: snap.typed, ...(snap.cards?.length ? { cards: snap.cards } : {}) });
}

/** The Read station's call, built as the runner builds it. */
export function intentReadRequest(snap: IntentReadSnap): SurfaceRequest {
  const g = graph();
  const node = g.nodes.get('read');
  if (!node) throw new Error('intent.cast has no read station');
  const context: Record<string, string> = {
    'asker.json': JSON.stringify(askerRecordOf(snap)),
    'change.json': JSON.stringify(snap.change),
    task_id: snap.task.short_id,
    ...taskProseVars(snap.task),
  };
  const body = callNodeBody(node, g, context, REPO_ROOT);
  return { model: body.model, max_tokens: body.max_tokens, prompt: body.prompt, ...(body.system ? { system: body.system } : {}) };
}

/** The answer when it is the JSON the station asks for, else null. */
export function answerOf(text: string): Answer | null {
  const j = parseJsonBlock(text) as any;
  if (!j || typeof j !== 'object') return null;
  const ok = typeof j.ship === 'boolean' && typeof j.in_scope === 'boolean' && typeof j.session === 'string' && typeof j.line === 'number' && (j.card === undefined || typeof j.card === 'string') && typeof j.quote === 'string' && typeof j.why === 'string' && j.why.trim() !== '';
  return ok ? (j as Answer) : null;
}

/**
 * What the run would do with the answer: the read -> clear (or clear_card) edge of intent.cast, then the server's
 * check of the citation (verifyCitation, verifyCardCitation) over what the read was given: the line or the card
 * exists, is the starter's, holds the quote with whitespace folded, and no non-Ship answer on the task's approval cards
 * is newer than it.
 */
export function outcomeOf(snap: IntentReadSnap, a: Answer | null): { clears: boolean; why: string } {
  if (!a) return { clears: false, why: 'no usable JSON answer' };
  if (!(a.ship && a.in_scope && a.quote)) return { clears: false, why: `ship ${a.ship}, in_scope ${a.in_scope}` };
  const newestOnTask = [...(snap.cards ?? [])].filter((c) => c.on_task).sort((x, y) => y.created_at.localeCompare(x.created_at))[0];
  const takenBack = (at: string, ref?: string) => !!newestOnTask && newestOnTask.card !== ref && !optionIsShip(newestOnTask.answer) && newestOnTask.created_at > at;
  if (a.session && a.line > 0) {
    const line = snap.typed.find((t) => t.short_id === a.session && t.line === a.line);
    if (!line) return { clears: false, why: `${a.session}:${a.line} is not a typed line the read was given` };
    if (!normalizeQuote(line.text).includes(normalizeQuote(a.quote))) return { clears: false, why: `${a.session}:${a.line} does not hold the quote` };
    if (takenBack(line.created_at)) return { clears: false, why: `${newestOnTask!.card} answered ${newestOnTask!.answer} after the cited line` };
    return { clears: true, why: `cites ${a.session}:${a.line}` };
  }
  if (!a.card) return { clears: false, why: 'cites neither a line nor a card' };
  const card = (snap.cards ?? []).find((c) => c.card === a.card);
  if (!card) return { clears: false, why: `${a.card} is not a card the read was given` };
  if (card.user_name !== snap.starter_name) return { clears: false, why: `${a.card} was answered by ${card.user_name ?? 'someone else'}` };
  if (!normalizeQuote(`${card.answer} ${card.note ?? ''}`).includes(normalizeQuote(a.quote))) return { clears: false, why: `${a.card}'s answer does not hold the quote` };
  if (takenBack(card.created_at, card.card)) return { clears: false, why: `${newestOnTask!.card} answered ${newestOnTask!.answer} after ${a.card}` };
  return { clears: true, why: `cites card ${a.card}` };
}

const isoOf = (ms: number) => new Date(ms).toISOString();

const impl: SurfaceImpl = {
  refForms: REF_FORMS,

  async capture(ref): Promise<Captured> {
    const m = /^(ct-\d+):(sd-\d+):([a-z0-9]+):([0-9a-f]+\^?)\.\.([0-9a-f]+)(?::((?:sd-\d+,?)+))?(?::not=([\d,]+))?=(clear|ask)$/i.exec(ref.trim());
    if (!m) throw new UsageError(REF_FORMS);
    const [, taskRef, cardRef, session, base, head, earlier, not, expect] = m;
    // Lines a program wrote that the offline filter cannot tell from typing (a spawned session's brief).
    const programLines = new Set((not ?? '').split(',').filter(Boolean).map(Number));
    const shown = castJson(['decide', 'show', cardRef, '--json']);
    const card = shown?.decision;
    if (!card?.created_at) throw new UsageError(`no card ${cardRef} readable here`);
    const { siteUrl, apiToken } = apiConfig();
    const task: any = await (await fetch(`${siteUrl}/cli/work/get`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_token: apiToken, short_id: taskRef }) })).json();
    if (!task?._id) throw new UsageError(`no task ${taskRef} readable here`);
    const askedUser = shown.asked_users?.[0];
    const asked: string = askedUser?.name ?? 'the person who started the run';
    const read = await readConversation(session);
    const shortId = session;
    const typed: IntentTyped[] = [];
    // A person's answers to cards, as the server reads them (originator.ts CardLine): the card row behind each answer
    // frame the session holds, and the task's earlier approval cards the ref names. An agent's answer is left out.
    const cards = new Map<string, IntentCard>();
    const addCard = (d: any, sessionShort?: string) => {
      if (!d?.resolved_at || d.resolved_at > card.created_at || d.answered_by?.kind !== 'user' || !d.short_id) return;
      const label = String(d.options?.[d.answer_index ?? -1]?.label ?? d.answer_text ?? '').trim();
      const prev = cards.get(d.short_id);
      cards.set(d.short_id, {
        card: d.short_id,
        ...(sessionShort ?? prev?.session_short_id ? { session_short_id: sessionShort ?? prev?.session_short_id } : {}),
        ...(d.workflow_run_id && d.task_id === task._id && (d.options ?? []).some((o: any) => optionIsShip(o?.label)) ? { on_task: true as const } : {}),
        question: String(d.question ?? ''),
        answer: label,
        ...(d.answer_text && d.answer_text.trim() !== label ? { note: d.answer_text } : {}),
        user_name: String(d.answered_by.id) === String(askedUser?._id) ? asked : 'someone else',
        created_at: isoOf(d.resolved_at),
      });
    };
    for (const msg of read.messages) {
      const at = Date.parse(msg.timestamp);
      if (msg.role !== 'user' || at > card.created_at || programLines.has(msg.line)) continue;
      // A card answer reaches the session as a frame the decision rail queues, never as a typed line: read the card instead.
      const answered = parseDecisionAnswer(msg.content ?? '');
      if (answered) {
        if (answered.id) addCard(castJson(['decide', 'show', answered.id, '--json'])?.decision, shortId);
        continue;
      }
      if (!mayBeTyped(msg.content ?? '')) continue;
      const words = typedPart(msg.content ?? '', 'typed_local', null);
      if (words) typed.push({ short_id: shortId, line: msg.line, user_name: asked, provenance: 'typed_local', text: words, created_at: isoOf(at) });
    }
    for (const ref of (earlier ?? '').split(',').filter(Boolean)) addCard(castJson(['decide', 'show', ref, '--json'])?.decision);
    const change = blindDiff({ cwd: REPO_ROOT, base, head });
    const snapshot: IntentReadSnap = {
      starter_name: asked,
      typed,
      ...(cards.size ? { cards: [...cards.values()] } : {}),
      task: { short_id: task.short_id, title: task.title, description: task.description ?? '' },
      change,
      // A clear rests on a ship word in scope; an ask here is one with no ship word for this change.
      expected: expect.toLowerCase() === 'clear' ? { clears: true, ship: true, in_scope: true } : { clears: false, ship: false },
      approximate: [
        `the lines are every user-role line of ${shortId} before ${cardRef} was posted that the asker's text filter keeps, read as typed at the terminal: provenance is not checked offline, and the sessions above it on the chain are left out`,
        `the change is ${base}..${head} on main as it landed, which may differ from the branch the run read`,
        'the cards are those whose answer frames the session holds, and the task\'s earlier approval cards the ref names; an answer by anyone but the person the moment\'s card asked reads as someone else\'s',
      ],
    };
    return {
      snapshot,
      subject: { kind: 'task', id: String(task._id), title: task.title },
      asOf: isoOf(card.created_at),
      anchor: { kind: 'message', id: `card:${cardRef}` },
      name: `intent-read ${task.short_id} (${cardRef})`,
      meta: { task: task.short_id, card: cardRef, session: shortId },
    };
  },

  async replay(snap: IntentReadSnap, ctx) {
    const r = await ctx.call(intentReadRequest(snap));
    const answer = answerOf(r.text);
    return { reply: r.text, parsed: { answer, outcome: outcomeOf(snap, answer) } };
  },

  gates(snap: IntentReadSnap, out, given?: IntentReadLabel) {
    const label = given ?? snap.expected;
    const parsed = out.parsed as { answer: Answer | null; outcome: { clears: boolean; why: string } } | undefined;
    const a = parsed?.answer ?? null;
    const gates = [gate('json', a !== null, a ? `ship ${a.ship}, in_scope ${a.in_scope}, ${a.session}:${a.line}` : `no well-formed answer in: ${out.reply.slice(0, 160)}`)];
    if (!label) return gates;
    if (label.ship !== undefined) gates.push(gate('ship', a?.ship === label.ship, `ship ${a?.ship}, expected ${label.ship}`));
    if (label.in_scope !== undefined) gates.push(gate('in-scope', a?.in_scope === label.in_scope, `in_scope ${a?.in_scope}, expected ${label.in_scope}`));
    const outcome = parsed?.outcome ?? { clears: false, why: 'no answer' };
    gates.push(gate('outcome', outcome.clears === label.clears, `${outcome.clears ? 'clears' : 'asks'} (${outcome.why}), expected ${label.clears ? 'clears' : 'asks'}`));
    return gates;
  },

  describe(snap: IntentReadSnap): ConvoMessage[] {
    const last = Math.max(...snap.typed.map((t) => Date.parse(t.created_at)), ...(snap.cards ?? []).map((v) => Date.parse(v.created_at)), Date.parse('2026-01-01T00:00:00.000Z'));
    const record = askerRecordOf(snap) as { text: string };
    return toConvoMessages([
      { role: 'user', content: `What ${snap.starter_name} and others typed along the change's sessions, and their card answers:\n\n${record.text}`, line: 1, timestamp: last + 1_000 },
      { role: 'user', content: `The task ${snap.task.short_id}: ${snap.task.title}\n\n${snap.task.description}`, line: 2, timestamp: last + 2_000 },
      { role: 'user', content: `The change (${snap.change.files} files, +${snap.change.added} -${snap.change.removed}):\n\n${snap.change.text}`, line: 3, timestamp: last + 3_000 },
    ]);
  },

  productionReply: () => null,
};

export default impl;
