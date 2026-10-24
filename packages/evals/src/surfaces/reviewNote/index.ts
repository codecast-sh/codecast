import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CheckResult, ConvoMessage, ProductionReply } from '@platform/evals';
import { UsageError } from '@platform/evals/cli';

import { parseWorkflowFile } from '../../../../cli/src/workflow/parser';
import { splitReviewNote } from '../../../../cli/src/workflow/reviewNote';
import { parseJsonBlock } from '../../../../convex/convex/lib/anthropic';
import type { MessageRow } from '../../adapters/convo';
import { readSessionMoment, SESSION_LINE_FORMS } from '../../adapters/moment';
import { JUDGE_MODEL } from '../../models';
import { REPO_ROOT } from '../../paths';
import { gate, type SurfaceImpl, type SurfaceRequest } from '../../surface';
import { bashBlock, sessionText } from '../decide';
import { describeTurn } from '../roleWake/world';
import { meta } from './meta';

// review-note: the note the change flow's independent reviewer writes with
// `cast task verdict`. On approve, decide.cast shows that note as the Ship
// card's document, so it is the whole of what the person answering reads. A
// freeze is a real review session cut just before the line that ran the
// verdict; the replay hands the model that session with its brief rendered
// from this tree's review.md (same task, branch and criteria), and asks for
// the verdict command. The investigation is fixed, so only how the note is
// written varies. One grader reads the card cold, as the person does; a second
// reads it beside the session to catch claims the session does not bear out.

export const TEMPLATE = 'packages/cli/src/workflow/templates/line/review.md';
const DECIDE = 'packages/cli/src/workflow/templates/decide.cast';
const TASK_HEADER = '# Task: Review\n';
const VAR = /\$([a-z_]+(?:\.[a-z_]+)*)/g;

type Row = Pick<MessageRow, 'line' | 'role' | 'content' | 'timestamp' | 'tool_calls' | 'tool_results'>;

export interface Verdict {
  task: string;
  verdict: 'approve' | 'changes' | 'reject';
  note: string;
}

export interface ReviewNoteSnap {
  title: string;
  /** The task's title as the Ship card's question names it. */
  task_title: string;
  branch: string;
  /** The brief's values, read back out of the rendered brief, so this tree's review.md renders with the same facts. */
  vars: Record<string, string>;
  /** The first message up to and including the `# Task: Review` header: the unattended frame the runner wraps every station in. */
  frame: string;
  /** Rows from line 2 up to (not including) the verdict line, oldest first. */
  rows: Row[];
  captured_at: string;
  production: Verdict;
}

const REF_FORMS = `review-note@ needs the review session line that ran cast task verdict, like review-note@jx7f0vw:47 (${SESSION_LINE_FORMS})`;

// ── the brief, rendered from a template ───────────────────────────────────

export const renderBrief = (template: string, vars: Record<string, string>): string => template.replace(VAR, (m, name: string) => vars[name] ?? m);

/** The values a rendered brief was made from, read against the template it was rendered from. Null when the brief is not that template's. */
export function briefVars(template: string, rendered: string): Record<string, string> | null {
  const names: string[] = [];
  let pattern = '';
  let last = 0;
  for (const m of template.matchAll(VAR)) {
    pattern += escape(template.slice(last, m.index));
    const name = m[1]!;
    const seen = names.indexOf(name);
    pattern += seen < 0 ? '([\\s\\S]*?)' : `\\${seen + 1}`;
    if (seen < 0) names.push(name);
    last = m.index! + m[0].length;
  }
  pattern += escape(template.slice(last).trimEnd());
  const match = new RegExp(`^${pattern}\\s*$`).exec(rendered.trimEnd());
  if (!match) return null;
  return Object.fromEntries(names.map((n, i) => [n, match[i + 1]!]));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const treeTemplate = (): string => readFileSync(join(REPO_ROOT, TEMPLATE), 'utf8');

// ── reading the verdict out of a command ──────────────────────────────────

/** The verdict a shell snippet records: its task, verdict and note (a heredoc or a quoted value). Null when it records none. */
export function verdictOfCommand(text: string): Verdict | null {
  const head = /cast task verdict\s+(\S+)\s+(approve|changes|reject)\b([^\n]*)/.exec(text);
  if (!head) return null;
  const [, task, verdict, rest] = head as unknown as [string, string, Verdict['verdict'], string];
  const doc = /--note\s+-\s*<<-?\s*(['"]?)([A-Za-z_]\w*)\1/.exec(rest);
  if (doc) {
    const body = text.slice(head.index + head[0].length + 1).split('\n');
    const end = body.findIndex((l) => l.trim() === doc[2]);
    if (end < 0) return null;
    return { task, verdict, note: body.slice(0, end).join('\n').trim() };
  }
  const quoted = /--note\s+(["'])((?:\\.|(?!\1)[\s\S])*)\1/.exec(text.slice(head.index));
  return quoted ? { task, verdict, note: quoted[2]!.replace(/\\(["\\$`])/g, '$1').trim() } : null;
}

// ── the card as the person meets it ───────────────────────────────────────

/** decide.cast's Ship card with the note as its document, read from this tree's decide.cast. */
export function renderCard(snap: Pick<ReviewNoteSnap, 'task_title' | 'branch'>, note: string): string {
  const graph = parseWorkflowFile(join(REPO_ROOT, DECIDE));
  const { question: review_question, body: review_body } = splitReviewNote(note);
  const [question, ...context] = renderBrief(graph.nodes.get('decide')?.prompt ?? '', { task_title: snap.task_title, branch: snap.branch, review_question }).split('\n');
  const answers = graph.edges.filter((e) => e.from === 'decide' && e.label).map((e, i) => {
    const [head, what] = e.label!.split('::').map((x) => x.trim());
    return `${i + 1}. ${head!.replace(/^\[\w\]\s*/, '')} (${what})`;
  });
  return [`Question: ${question}`, ...context, '', 'Answers:', ...answers, '', 'Document:', review_body || '(empty)'].join('\n');
}

const FINDING = /^(blocker|high|medium|low|nit)\s+\S+:\d+/gm;
export const findingLines = (note: string): number => note.match(FINDING)?.length ?? 0;

/** The session as the reviewer had it, its brief rendered from `template`. */
export function sessionRows(snap: ReviewNoteSnap, template: string): Row[] {
  const first: Row = { line: 1, role: 'user', content: `${snap.frame}${renderBrief(template, snap.vars)}`, timestamp: snap.rows[0]?.timestamp ?? 0 };
  return [first, ...snap.rows];
}

const FRAME_ASK = [
  'Above is your session so far. Your next step is the one your brief ends your turn on: the verdict, with its note.',
  'This is a rehearsal: nothing runs. Reply with the exact `cast task verdict` command you would run, its note included, in one ```bash block, and nothing else.',
].join('\n');

export function reviewRequest(snap: ReviewNoteSnap, model: string, template = treeTemplate()): SurfaceRequest {
  return {
    model,
    system: 'You are a coding agent working in a codecast session.',
    prompt: `# Your session: ${snap.title}\n\n${sessionText(sessionRows(snap, template))}\n\n---\n\n${FRAME_ASK}`,
    max_tokens: 12000,
  };
}

// ── grading ───────────────────────────────────────────────────────────────

const COLD_READ = (card: string) => `A Ship card just arrived in your decision queue. An AI agent made a change to the product you run, an independent AI reviewer checked it, and you answer whether it lands. You know the product's features, its agents, your team, customers and contacts by name, but not its code, and you never opened the session that made this change. You give it a couple of minutes.

<card>
${card}
</card>

Read it once, top to bottom, as that person. Then return ONLY a JSON object:
{
  "does": "what the change does for the people it reaches, in one plain sentence, as you understood it, or null if you could not tell",
  "lookups": ["each term, name, path, id, number or reference you would have to look up or ask about before you could choose, quoted from the card; detail you could skip and still choose knowing why does not count"],
  "opening_says_what": true or false (do the card's first lines tell you what changes for people and what the review concluded, before any code detail?),
  "could_answer": true or false (could you choose Ship, Revise or Drop from the card alone, knowing why?)
}`;

const FAITHFUL = (session: string, note: string) => `An AI code reviewer wrote the note below at the end of the review session below. Check the note against the session.

<session>
${session}
</session>

<note>
${note}
</note>

List each claim in the note (a number, a test result, a name, what the change does or does not do) that the session contradicts, or that nothing anywhere in the session supports: at most eight, the most consequential first, one line each. A claim the session supports anywhere, its tool output and the diff it read included, is supported. Rewording that keeps the meaning is fine, and so is leaving detail out. Return ONLY a JSON object: {"unsupported": ["each claim, quoted, with what the session says instead"]}`;

interface ColdRead {
  does: string | null;
  lookups: string[];
  opening_says_what: boolean;
  could_answer: boolean;
}

interface Parsed {
  verdict: Verdict | null;
  cold: ColdRead | null;
  unsupported: string[] | null;
}

const graderRequest = (prompt: string): SurfaceRequest => ({ model: JUDGE_MODEL, prompt, max_tokens: 8000 });

const CONTEXT = '(An AI reviewer has just approved a change, and its note is about to become the document of the Ship card its person answers in their decision queue. The person runs the product and knows its features, agents, team and customers, but not its code, and never opened the session that made the change. The reply is the card they will see; the review session behind it is not shown, because the person does not see it either.)';

const impl: SurfaceImpl = {
  refForms: REF_FORMS,

  async capture(ref) {
    const m = await readSessionMoment(ref, REF_FORMS);
    const command = (m.at.tool_calls ?? []).map((t) => toolCommand((t as { input?: unknown }).input)).find((c) => c.includes('cast task verdict'));
    const production = command ? verdictOfCommand(command) : null;
    if (!production) throw new UsageError(`line ${m.line} of ${m.conversation.id} runs no cast task verdict with a note: ${REF_FORMS}`);
    const brief = m.rows.find((r) => r.line === 1)?.content ?? '';
    const cut = brief.indexOf(TASK_HEADER);
    const vars = cut < 0 ? null : briefVars(treeTemplate(), brief.slice(cut + TASK_HEADER.length));
    if (!vars) throw new UsageError(`${m.conversation.id}'s first message is not a brief rendered from this tree's ${TEMPLATE}`);
    const snapshot: ReviewNoteSnap = {
      title: m.conversation.title ?? m.conversation.id,
      task_title: vars['task_title'] ?? '',
      branch: vars['branch'] ?? '',
      vars,
      frame: brief.slice(0, cut + TASK_HEADER.length),
      rows: m.rows
        .filter((r) => r.line > 1 && r.line < m.line)
        .map((r) => ({ line: r.line, role: r.role, content: r.content, timestamp: r.timestamp, ...(r.tool_calls?.length ? { tool_calls: r.tool_calls } : {}), ...(r.tool_results?.length ? { tool_results: r.tool_results } : {}) })),
      captured_at: new Date(m.at.timestamp).toISOString(),
      production,
    };
    return {
      snapshot,
      subject: { kind: 'session', id: m.conversation.id, title: m.conversation.title ?? m.conversation.id },
      asOf: new Date(m.at.timestamp).toISOString(),
      anchor: { kind: 'message', id: `${m.conversation.id}:${m.line}` },
      name: `review-note ${m.conversation.id.slice(0, 7)}:${m.line}`,
      meta: { conversation_id: m.conversation.id, line: m.line },
    };
  },

  async replay(snap: ReviewNoteSnap, ctx) {
    const template = treeTemplate();
    const r = await ctx.call(reviewRequest(snap, ctx.model ?? meta.model, template), { label: 'review' });
    const verdict = verdictOfCommand(bashBlock(r.text));
    const parsed: Parsed = { verdict, cold: null, unsupported: null };
    if (verdict) {
      // One after the other: a harness call numbers its run dir when it starts, so two at once share one.
      const cold = await ctx.call(graderRequest(COLD_READ(renderCard(snap, verdict.note))), { label: 'cold-read', grader: true });
      const faithful = await ctx.call(graderRequest(FAITHFUL(sessionText(sessionRows(snap, template)), verdict.note)), { label: 'faithful', grader: true });
      parsed.cold = parseJsonBlock(cold.text) as ColdRead | null;
      parsed.unsupported = (parseJsonBlock(faithful.text) as { unsupported?: string[] } | null)?.unsupported ?? null;
    }
    return { reply: verdict ? renderCard(snap, verdict.note) : r.text, parsed };
  },

  gates(_snap: ReviewNoteSnap, out) {
    const p = out.parsed as Parsed | undefined;
    return [gate('parse', Boolean(p?.verdict), p?.verdict ? `${p.verdict.verdict}, ${p.verdict.note.length} characters of note` : `no cast task verdict with a note in the reply: ${out.reply.slice(0, 160)}`)];
  },

  checks(snap: ReviewNoteSnap, out): CheckResult[] {
    const p = out.parsed as Parsed | undefined;
    if (!p?.verdict) return [];
    const checks: CheckResult[] = [];
    if (p.cold) {
      const n = p.cold.lookups?.length ?? 0;
      checks.push({ id: 'cold-lookups', ask: 'a cold reader has nothing to look up', weight: 1, score: Math.max(0, 1 - n / 15), evidence: n ? p.cold.lookups.join(' | ').slice(0, 600) : 'none' });
      checks.push({ id: 'cold-opening', ask: 'the opening says what changes for people and what the review concluded, before code detail', weight: 1, score: p.cold.opening_says_what ? 1 : 0, evidence: p.cold.does ?? '(could not tell)' });
      checks.push({ id: 'cold-answer', ask: 'a cold reader could choose from the card alone', weight: 0.5, score: p.cold.could_answer ? 1 : 0, evidence: p.cold.does ?? '(could not tell)' });
    }
    if (p.unsupported) {
      const n = p.unsupported.length;
      checks.push({ id: 'faithful', ask: 'every claim in the note is borne out by the session', weight: 1, score: Math.max(0, 1 - n / 8), evidence: n ? p.unsupported.join(' | ').slice(0, 600) : 'none' });
    }
    // Guards: writing for the person must not change what the review decides or drop what it found.
    checks.push({ id: 'same-verdict', ask: 'the verdict is the one the review reached', weight: 0.5, score: p.verdict.verdict === snap.production.verdict ? 1 : 0, evidence: `${p.verdict.verdict} (production: ${snap.production.verdict})` });
    const had = findingLines(snap.production.note);
    const has = findingLines(p.verdict.note);
    checks.push({ id: 'findings-kept', ask: 'the finding lines the review recorded are still recorded', weight: 0.5, score: had ? Math.min(1, has / had) : 1, evidence: `${has} finding lines (production: ${had})` });
    return checks;
  },

  describe: (snap: ReviewNoteSnap): ConvoMessage[] => describeTurn(`${sessionText(sessionRows(snap, treeTemplate()))}\n\n---\n\n${FRAME_ASK}`, snap.captured_at, 'session'),

  // The person answering sees only the card, so the judge reads the card cold.
  judgeMoment: (snap: ReviewNoteSnap): ConvoMessage[] => describeTurn(CONTEXT, snap.captured_at, 'queue'),

  productionReply(snap: ReviewNoteSnap): ProductionReply | null {
    return { messages: [{ n: 1, id: 'production-card', at: snap.captured_at, channel: 'session', isGroup: false, direction: 'out', from: 'assistant', text: renderCard(snap, snap.production.note) }] };
  },
};

function toolCommand(input: unknown): string {
  let v = input;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return v as string;
    }
  }
  return v && typeof v === 'object' && typeof (v as { command?: unknown }).command === 'string' ? (v as { command: string }).command : '';
}

export default impl;
