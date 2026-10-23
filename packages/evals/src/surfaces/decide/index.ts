import type { CheckResult, ConvoMessage, ProductionReply } from '@platform/evals';
import { UsageError } from '@platform/evals/cli';

import { parseJsonBlock } from '../../../../convex/convex/lib/anthropic';
import { renderGuidanceFile } from '../../../../shared/contracts/snippets';
import type { MessageRow } from '../../adapters/convo';
import { readSessionMoment, SESSION_LINE_FORMS } from '../../adapters/moment';
import { JUDGE_MODEL } from '../../models';
import { gate, type SurfaceImpl, type SurfaceRequest } from '../../surface';
import { describeTurn } from '../roleWake/world';
import { meta } from './meta';

// decide: the card an agent writes when it puts a choice to its person with
// `cast decide`. A freeze is a real session cut just before the line where it
// ran `cast decide`; the replay hands the model that session (its messages,
// tool calls and their output) under the codecast guidance this tree renders
// into CLAUDE.md, and asks for the command it runs next. The person who
// answers sees only the card, so the judge reads only the card, and a second
// grader reads the card beside the session to catch a card that reads well
// but says what the session does not.

type Row = Pick<MessageRow, 'line' | 'role' | 'content' | 'timestamp' | 'tool_calls' | 'tool_results'>;

export interface DecideSnap {
  /** The session's title at capture. */
  title: string;
  /** Rows from line 1 up to (not including) the line that ran `cast decide`, oldest first. */
  rows: Row[];
  captured_at: string;
  /** The card the session actually posted. */
  production: DecisionCard;
}

export interface DecisionCard {
  question: string;
  options: Array<{ label: string; description?: string }>;
  context: string;
  advisory?: boolean;
  default?: number;
  report?: string;
}

const REF_FORMS = `decide@ needs the session line that ran cast decide, like decide@jx7c5mj:86 (${SESSION_LINE_FORMS})`;

// ── reading `cast decide` out of a shell command ──────────────────────────

/** The words of the first `cast decide` command in a shell snippet, with heredoc bodies as stdin. Null when there is none. */
export function shellWords(text: string): { argv: string[]; stdin: string | null } | null {
  const start = text.search(/(^|[\s;&|(])cast decide(\s|$)/m);
  if (start < 0) return null;
  let i = text.indexOf('cast decide', start);
  const argv: string[] = [];
  const heredocs: string[] = [];
  let word: string | null = null;
  const push = () => {
    if (word !== null) argv.push(word);
    word = null;
  };
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (c === '\\' && text[i + 1] === '\n') {
      i++;
      continue;
    }
    if (c === '\\') {
      word = (word ?? '') + (text[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return null;
      word = (word ?? '') + text.slice(i + 1, end);
      i = end;
      continue;
    }
    if (c === '"') {
      let s = '';
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === '\\' && '"\\$`\n'.includes(text[j + 1] ?? '')) {
          if (text[j + 1] !== '\n') s += text[j + 1];
          j++;
        } else s += text[j];
      }
      if (j >= text.length) return null;
      word = (word ?? '') + s;
      i = j;
      continue;
    }
    if (c === '<' && text[i + 1] === '<' && word === null) {
      const m = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(text.slice(i));
      if (!m) return null;
      heredocs.push(m[2]!);
      i += m[0].length - 1;
      continue;
    }
    if (c === ' ' || c === '\t') {
      push();
      continue;
    }
    if (c === '\n' || c === ';' || c === '|' || (c === '&' && text[i + 1] === '&')) break;
    if (c === '>' || (c === '2' && text[i + 1] === '>' && word === null)) {
      // A redirect: skip it and its target.
      const m = /^\d?>&?\d*\s*\S*/.exec(text.slice(i));
      i += (m?.[0].length ?? 1) - 1;
      continue;
    }
    word = (word ?? '') + c;
  }
  push();
  let stdin: string | null = null;
  if (heredocs.length) {
    const rest = text.slice(text.indexOf('\n', i) + 1).split('\n');
    const end = rest.findIndex((l) => l.trim() === heredocs[0]);
    if (end < 0) return null;
    stdin = rest.slice(0, end).join('\n');
  }
  return { argv: argv.slice(2), stdin };
}

/** The card a `cast decide` command posts: its question, options and context. Null when the command is not an ask. */
export function cardOfCommand(text: string): DecisionCard | null {
  const words = shellWords(text);
  if (!words) return null;
  const { argv, stdin } = words;
  const card: DecisionCard = { question: '', options: [], context: '' };
  const value = (v: string | undefined) => (v === '-' ? (stdin ?? '') : (v ?? ''));
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k]!;
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const next = () => inline ?? argv[++k];
    if (flag === '-o' || flag === '--option') {
      const raw = next() ?? '';
      const sep = raw.indexOf('::');
      card.options.push(sep < 0 ? { label: raw.trim() } : { label: raw.slice(0, sep).trim(), description: raw.slice(sep + 2).trim() });
    } else if (flag === '--context') card.context = value(next());
    else if (flag === '--question') card.question = value(next());
    else if (flag === '--advisory') card.advisory = true;
    else if (flag === '--blocking') card.advisory = false;
    else if (flag === '--default') card.default = Number(next());
    else if (flag === '--report') card.report = next();
    else if (flag.startsWith('-')) {
      // Flags with a value the card does not show.
      if (['--task', '--station', '--stack', '--category', '--kind', '--doc', '--spec', '--option-body', '--option-page', '--proposal'].includes(flag) && inline === undefined) k++;
    } else if (!card.question) card.question = a;
  }
  if (['edit', 'cancel', 'ls', 'show', 'answer', 'kit', 'brief'].includes(card.question)) return null;
  return card.question && card.options.length ? card : null;
}

/** The card as the person meets it in their queue. */
export function renderCard(card: DecisionCard): string {
  return [
    `Question: ${card.question}`,
    '',
    'Answers:',
    ...card.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` (${o.description})` : ''}${card.default === i + 1 ? ' [the agent continues on this one meanwhile]' : ''}`),
    '',
    card.context.trim() || '(no context)',
    ...(card.report ? ['', `(A report page is attached: ${card.report})`] : []),
  ].join('\n');
}

// ── the session as the agent had it ───────────────────────────────────────

/** Characters of session the replay carries: the newest rows that fit, plus the first message. */
export const SESSION_BUDGET = 180_000;
const CALL_CHARS = 4000;
const RESULT_CHARS = 2500;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n[… ${s.length - n} more characters]` : s);

function toolInput(input: unknown): string {
  let v = input;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return v as string;
    }
  }
  if (v && typeof v === 'object' && typeof (v as { command?: unknown }).command === 'string') return (v as { command: string }).command;
  return JSON.stringify(v);
}

function resultText(r: unknown): string {
  if (typeof r === 'string') return r;
  const c = (r as { content?: unknown })?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : (x as { text?: string })?.text ?? '')).join('\n');
  return JSON.stringify(r);
}

export function renderRow(r: Row): string {
  const parts: string[] = [];
  const who = r.role === 'assistant' ? 'YOU' : r.role === 'user' ? 'USER' : r.role.toUpperCase();
  if (r.content?.trim()) parts.push(`[${r.line}] ${who}: ${r.content.trim()}`);
  for (const t of r.tool_calls ?? []) parts.push(`[${r.line}] YOU ran ${(t as { name?: string }).name ?? 'a tool'}:\n${clip(toolInput((t as { input?: unknown }).input), CALL_CHARS)}`);
  for (const t of r.tool_results ?? []) parts.push(`[${r.line}] TOOL OUTPUT:\n${clip(resultText(t), RESULT_CHARS)}`);
  return parts.join('\n\n');
}

/** The session text the replay carries: the first message, then the newest rows within the budget. */
export function sessionText(rows: Row[]): string {
  const rendered = rows.map(renderRow).filter(Boolean);
  if (!rendered.length) return '';
  const head = rendered[0]!;
  const tail: string[] = [];
  let used = head.length;
  for (let k = rendered.length - 1; k > 0; k--) {
    if (used + rendered[k]!.length > SESSION_BUDGET) break;
    tail.unshift(rendered[k]!);
    used += rendered[k]!.length;
  }
  const skipped = rendered.length - 1 - tail.length;
  return [head, ...(skipped ? [`[… ${skipped} earlier messages left out]`] : []), ...tail].join('\n\n');
}

/** The replay's frame: identical in every arm, so it biases neither. */
const FRAME_SYSTEM = 'You are a coding agent working in a codecast session. Your human\'s global instructions (their CLAUDE.md) follow.';
const FRAME_ASK = (q: string) =>
  [
    'Above is your session so far. Your next step is to put the decision this work has reached to your human with `cast decide`.',
    `(Your own working title for it was: "${q}")`,
    'This is a rehearsal: nothing runs, and no files can be written, so a --report page cannot be built here. Reply with the exact command you would run, in one ```bash block, and nothing else.',
  ].join('\n');

export function decideRequest(snap: DecideSnap, model: string): SurfaceRequest {
  return {
    model,
    system: `${FRAME_SYSTEM}\n\n${renderGuidanceFile('full', 'eval')}`,
    prompt: `# Your session: ${snap.title}\n\n${sessionText(snap.rows)}\n\n---\n\n${FRAME_ASK(snap.production.question)}`,
    max_tokens: 8000,
  };
}

// ── grading ───────────────────────────────────────────────────────────────

const COLD_READ = (card: string) => `A decision just arrived in your queue from one of your AI agents. You run the product it works on and know its everyday vocabulary (its features, its agents' names, its customers), but you did not follow the work that produced this card, and you have a minute for it.

<card>
${card}
</card>

Read it once, top to bottom, as that person. Then return ONLY a JSON object:
{
  "asked": "the decision in one plain sentence, as you understood it, or null if you could not tell",
  "lookups": ["each term, name, id, number or reference you would have to look up or ask about before you could answer, quoted from the card"],
  "first_line_says_what": true or false (does the card's opening tell you what is being decided and why it matters, before any background?),
  "could_answer": true or false (could you pick an answer from the card alone, knowing what each one does?)
}`;

const FAITHFUL = (session: string, card: string) => `An AI agent wrote a decision card for its person from the session below. Check the card against the session.

<session>
${session}
</session>

<card>
${card}
</card>

List each claim in the card (a number, a name, a finding, what an answer would do) that the session contradicts, or that nothing anywhere in the session supports: at most eight, the most consequential first, one line each. A claim the session supports anywhere, its tool output included, is supported. Rewording that keeps the meaning is fine, and so are leaving detail out and the agent's stated plan or recommendation. Return ONLY a JSON object: {"unsupported": ["each claim, quoted, with what the session says instead"]}`;

interface ColdRead {
  asked: string | null;
  lookups: string[];
  first_line_says_what: boolean;
  could_answer: boolean;
}

interface Parsed {
  card: DecisionCard | null;
  cold: ColdRead | null;
  unsupported: string[] | null;
}

function graderRequest(prompt: string): SurfaceRequest {
  return { model: JUDGE_MODEL, prompt, max_tokens: 8000 };
}

/** The command block of the reply: from its opening fence to the last closing one, since a context can hold fences of its own. */
export const bashBlock = (text: string): string => {
  const open = /^(`{3,})(?:bash|sh|shell)?[ \t]*$/m.exec(text);
  if (!open) return text;
  const body = text.slice(open.index + open[0].length + 1);
  const close = body.lastIndexOf(`\n${open[1]}`);
  return close < 0 ? body : body.slice(0, close);
};

const impl: SurfaceImpl = {
  refForms: REF_FORMS,

  async capture(ref) {
    const m = await readSessionMoment(ref, REF_FORMS);
    const command = (m.at.tool_calls ?? []).map((t) => toolInput((t as { input?: unknown }).input)).find((c) => c.includes('cast decide'));
    const production = command ? cardOfCommand(command) : null;
    if (!production) throw new UsageError(`line ${m.line} of ${m.conversation.id} runs no cast decide ask: ${REF_FORMS}`);
    const rows = m.rows.filter((r) => r.line < m.line);
    const snapshot: DecideSnap = {
      title: m.conversation.title ?? m.conversation.id,
      rows: rows.map((r) => ({ line: r.line, role: r.role, content: r.content, timestamp: r.timestamp, ...(r.tool_calls?.length ? { tool_calls: r.tool_calls } : {}), ...(r.tool_results?.length ? { tool_results: r.tool_results } : {}) })),
      captured_at: new Date(m.at.timestamp).toISOString(),
      production,
    };
    return {
      snapshot,
      subject: { kind: 'session', id: m.conversation.id, title: m.conversation.title ?? m.conversation.id },
      asOf: new Date(m.at.timestamp).toISOString(),
      anchor: { kind: 'message', id: `${m.conversation.id}:${m.line}` },
      name: `decide ${m.conversation.id.slice(0, 7)}:${m.line}`,
      meta: { conversation_id: m.conversation.id, line: m.line },
    };
  },

  async replay(snap: DecideSnap, ctx) {
    const r = await ctx.call(decideRequest(snap, ctx.model ?? meta.model), { label: 'ask' });
    const card = cardOfCommand(bashBlock(r.text));
    const parsed: Parsed = { card, cold: null, unsupported: null };
    if (card) {
      const shown = renderCard(card);
      const [cold, faithful] = await Promise.all([
        ctx.call(graderRequest(COLD_READ(shown)), { label: 'cold-read', grader: true }),
        ctx.call(graderRequest(FAITHFUL(sessionText(snap.rows), shown)), { label: 'faithful', grader: true }),
      ]);
      parsed.cold = parseJsonBlock(cold.text) as ColdRead | null;
      parsed.unsupported = (parseJsonBlock(faithful.text) as { unsupported?: string[] } | null)?.unsupported ?? null;
    }
    return { reply: card ? renderCard(card) : r.text, parsed };
  },

  gates(_snap: DecideSnap, out) {
    const p = out.parsed as Parsed | undefined;
    return [gate('parse', Boolean(p?.card), p?.card ? `${p.card.options.length} answers, ${p.card.context.length} characters of context` : `no cast decide ask in the reply: ${out.reply.slice(0, 160)}`)];
  },

  checks(_snap: DecideSnap, out): CheckResult[] {
    const p = out.parsed as Parsed | undefined;
    if (!p?.card) return [];
    const checks: CheckResult[] = [];
    if (p.cold) {
      const n = p.cold.lookups?.length ?? 0;
      checks.push({ id: 'cold-lookups', ask: 'a cold reader has nothing to look up', weight: 1, score: Math.max(0, 1 - n / 15), evidence: n ? p.cold.lookups.join(' | ').slice(0, 600) : 'none' });
      checks.push({ id: 'cold-opening', ask: 'the opening says what is decided and why, before background', weight: 0.5, score: p.cold.first_line_says_what ? 1 : 0, evidence: p.cold.asked ?? '(could not tell)' });
    }
    if (p.unsupported) {
      const n = p.unsupported.length;
      checks.push({ id: 'faithful', ask: 'every claim on the card is borne out by the session', weight: 1, score: Math.max(0, 1 - n / 8), evidence: n ? p.unsupported.join(' | ').slice(0, 600) : 'none' });
    }
    return checks;
  },

  describe: (snap: DecideSnap): ConvoMessage[] => describeTurn(`${sessionText(snap.rows)}\n\n---\n\n${FRAME_ASK(snap.production.question)}`, snap.captured_at, 'session'),

  // The person answering sees only the card, so the judge reads the card cold.
  judgeMoment: (snap: DecideSnap): ConvoMessage[] =>
    describeTurn('(An AI agent is about to put a decision to the person it works for, through their decision queue. The person runs the product but did not follow this session. The reply is the card they will see; the session behind it is not shown, because the person does not see it either.)', snap.captured_at, 'queue'),

  productionReply(snap: DecideSnap): ProductionReply | null {
    return { messages: [{ n: 1, id: 'production-card', at: snap.captured_at, channel: 'session', isGroup: false, direction: 'out', from: 'assistant', text: renderCard(snap.production) }] };
  },
};

export default impl;
