import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { ConvoMessage } from '@platform/evals';
import { UsageError } from '@platform/evals/cli';

import { buildNodePrompt, expandPromptVars, lineRunDir, recordNodeOutput } from '../../../../cli/src/workflow/runner';
import { extractJsonOutput } from '../../../../cli/src/workflow/condition';
import { parseWorkflowSource } from '../../../../cli/src/workflow/parser';
import { BUILTIN_WORKFLOW_TEMPLATES } from '../../../../cli/src/workflow/templates';
import { applyUnattended, inlineForeignText } from '../../../../shared/contracts';
import { CHANGE_VERDICTS, validateChangeCard, type ChangeCard } from '../../../../shared/contracts/changeCard';
import { toConvoMessages } from '../../adapters/convo';
import { PROD_DEFAULT_MODEL } from '../../models';
import { gate, type Captured, type SurfaceImpl, type SurfaceRequest } from '../../surface';

// The line's card words station (card_write in line.cast). In prod it is an
// agent=claude hand, but its job is one reply over one document, so it
// replays as one call: the briefing the runner hands the hand (the mandate,
// the run's goal, the station's prompt with its $vars expanded by the
// runner's own expander), over the card `cast card build --json` drafted.
// The draft enters the context the way the card_draft node's stdout does
// (recordNodeOutput), so the replay keeps prod's caps. The reply ends in a
// fenced json block of six fields, read by the runner's own JSON reader.

export interface CardWriteSnap {
  task: { short_id: string; title: string };
  /** The card as `cast card build --json` prints it under `.card`, before any words are written. */
  card: ChangeCard;
  approximate?: string[];
}

export const CARD_FIELDS = ['headline', 'context', 'wrong', 'change', 'recommend', 'why'] as const;
export type CardWords = Record<(typeof CARD_FIELDS)[number], string>;

/** The card's headline limit, as the station's prompt states it. */
export const HEADLINE_MAX = 70;

/**
 * Ids the project uses inside itself, which the six fields must never carry:
 * tasks, decisions, plans, sessions (jx7...), workflow runs (th7...) and
 * freeze uuids.
 */
export const INTERNAL_ID = /\b(?:(?:ct|sd|pl)-\d+|jx7[a-z0-9]{4,}|th7[a-z0-9]{4,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

const REF_FORMS = `card-write@ takes a fixture, a cause whose line run left a card in this repository, or a run dir or card.json path, like card-write@fixture:<case>, card-write@ct-56750 or card-write@~/src/x/.git/cast-line/line-ct-1`;

// An agent turn has no max_tokens of its own; this is room for a few lines and the block, so prod-budget fails only a runaway reply.
const CARD_WRITE_MAX_TOKENS = 8000;

/** The briefing the runner hands the card_write hand for this draft, on its first visit. */
export function cardWritePrompt(snap: CardWriteSnap): string {
  const graph = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.line!);
  const node = graph.nodes.get('card_write');
  if (!node) throw new Error('the line template has no card_write node');
  const context: Record<string, string> = { task_id: snap.task.short_id, task_title: inlineForeignText(snap.task.title) };
  if (graph.goal) graph.goal = expandPromptVars(graph.goal, graph, context);
  recordNodeOutput(context, 'card_draft', JSON.stringify({ card: snap.card, errors: cardErrors(snap.card) }, null, 2));
  return applyUnattended(buildNodePrompt(node, graph, context));
}

function cardErrors(card: ChangeCard): string[] {
  const v = validateChangeCard(card);
  return v.ok ? [] : v.errors;
}

export const cardWriteRequest = (snap: CardWriteSnap): SurfaceRequest => ({ model: PROD_DEFAULT_MODEL, prompt: cardWritePrompt(snap), max_tokens: CARD_WRITE_MAX_TOKENS });

/** The six fields from the reply's last fenced json block, each as a trimmed string ("" when absent). */
export function parseCardWords(text: string): CardWords | null {
  const parsed = extractJsonOutput(text) as Record<string, unknown> | undefined;
  if (!parsed || Array.isArray(parsed)) return null;
  return Object.fromEntries(CARD_FIELDS.map((k) => [k, typeof parsed[k] === 'string' ? (parsed[k] as string).trim() : ''])) as CardWords;
}

/** A finished card as a draft: the words the station writes taken back out. */
export function cardDraftOf(card: ChangeCard): ChangeCard {
  const { headline: _h, context: _c, ...rest } = card;
  return { ...rest, wrong: '', change: '', recommend: { verdict: '', why: '' } as unknown as ChangeCard['recommend'] };
}

function findCardFile(ref: string): string {
  const raw = ref.trim().replace(/^~(?=\/)/, process.env.HOME ?? '~');
  if (/^ct-\d+$/i.test(raw)) {
    const file = join(lineRunDir(process.cwd(), `line-${raw.toLowerCase()}`), 'card.json');
    if (!existsSync(file)) throw new UsageError(`no line run of ${raw} left a card here (${file}); pass the run dir or card.json path`);
    return file;
  }
  const path = resolve(raw);
  if (!existsSync(path)) throw new UsageError(REF_FORMS);
  const file = statSync(path).isDirectory() ? join(path, 'card.json') : path;
  if (!existsSync(file)) throw new UsageError(`${path} holds no card.json`);
  return file;
}

const DESCRIBE_CLOCK = Date.parse('2026-01-01T00:01:00.000Z');

const impl: SurfaceImpl = {
  refForms: REF_FORMS,

  async capture(ref): Promise<Captured> {
    const file = findCardFile(ref);
    const card = JSON.parse(readFileSync(file, 'utf8')) as ChangeCard;
    if (!card?.cause?.task) throw new UsageError(`${file} is not a change card`);
    const snapshot: CardWriteSnap = {
      task: { short_id: card.cause.task, title: card.cause.title },
      card: cardDraftOf(card),
      approximate: ['the draft is the run\'s last card with its six words taken out; the proof, checks and diff are as that last build read them'],
    };
    return {
      snapshot,
      subject: { kind: 'task', id: card.cause.task, title: card.cause.title },
      asOf: statSync(file).mtime.toISOString(),
      anchor: { kind: 'run', id: `card:${card.cause.task}` },
      name: `card-write ${card.cause.task}`,
      meta: { task: card.cause.task, card_file: file, prod: { headline: card.headline ?? '', context: card.context ?? '', wrong: card.wrong, change: card.change, recommend: card.recommend?.verdict ?? '', why: card.recommend?.why ?? '' } },
    };
  },

  async replay(snap: CardWriteSnap, ctx) {
    const r = await ctx.call(cardWriteRequest(snap));
    const words = parseCardWords(r.text);
    // A person meets only the six fields, on the card; the hand's closing line is the station's plumbing, kept beside them.
    return { reply: words ? CARD_FIELDS.map((k) => `${k}: ${words[k]}`).join('\n') : r.text, parsed: words, extra: { turn: r.text } };
  },

  gates(_snap: CardWriteSnap, out) {
    const words = (out.parsed as CardWords | null | undefined) ?? null;
    const empty = words ? CARD_FIELDS.filter((k) => !words[k]) : [...CARD_FIELDS];
    const gates = [gate('parse', !!words && !empty.length, !words ? `no json block parsed from: ${out.reply.slice(-160)}` : empty.length ? `empty: ${empty.join(', ')}` : 'six fields')];
    if (!words) return gates;
    gates.push(gate('headline-length', words.headline.length < HEADLINE_MAX, `${words.headline.length} chars: ${words.headline}`));
    gates.push(gate('recommend-valid', (CHANGE_VERDICTS as readonly string[]).includes(words.recommend), `recommend "${words.recommend}"`));
    const leaks = CARD_FIELDS.flatMap((k) => {
      const m = INTERNAL_ID.exec(words[k]);
      return m ? [`${k}: ${m[0]}`] : [];
    });
    gates.push(gate('no-internal-ids', !leaks.length, leaks.length ? leaks.join('; ') : 'none'));
    return gates;
  },

  describe(snap: CardWriteSnap): ConvoMessage[] {
    return toConvoMessages([{ role: 'user', content: `The change card for ${snap.task.short_id} (${snap.task.title}), as the run assembled it before the words were written:\n\n${JSON.stringify(snap.card, null, 2)}`, line: 1, timestamp: DESCRIBE_CLOCK }]);
  },

  productionReply: () => null,
};

export default impl;
