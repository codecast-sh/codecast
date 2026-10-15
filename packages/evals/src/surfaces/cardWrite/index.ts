import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { ConvoMessage, GateResult } from '@platform/evals';
import { UsageError } from '@platform/evals/cli';

import { captureDecision, capturePin, readWrites, type CapturedDecision, type CapturedPin } from '../../../../cli/scripts/lib/linePresent';
import { DECISION_KIT_GUIDE } from '../../../../cli/src/decisionKit';
import { expandPromptVars, lineRunDir, recordNodeOutput, stationBrief } from '../../../../cli/src/workflow/runner';
import { parseWorkflowSource } from '../../../../cli/src/workflow/parser';
import { BUILTIN_WORKFLOW_TEMPLATES } from '../../../../cli/src/workflow/templates';
import { inlineForeignText } from '../../../../shared/contracts';
import { CHANGE_VERDICTS, validateChangeCard, type ChangeCard } from '../../../../shared/contracts/changeCard';
import { REPO_ROOT } from '../../paths';
import { writeServedRead } from '../../served';
import { gate, type AgentResult, type Captured, type ReplayResult, type SurfaceImpl } from '../../surface';
import { describeTurn, servedDirFor, type FixtureRead, type StandingWorld } from '../roleWake/world';
import { meta } from './meta';

// The line's presenting station (card_write in line.cast): an agent=claude
// hand that reads the problem, its findings and the change, builds a decision
// page, posts the one decision the run asks a person, and pins a report the
// run checks against the facts it computed. It replays as an agent against
// the world it read: the problem and its findings answer from the record, the
// change is a git repository built in the rep from the files it touched, and
// the recording guard (line-present-replay-bin/cast) keeps the decision and
// the report whole instead of sending them. The gates read those two writes
// the way the line does; the judge reads the decision a person would see.

export interface CardWriteSnap extends StandingWorld {
  task: { short_id: string; title: string };
  /** The card as `cast card build --json` prints it under `.card` before the station runs. */
  card: ChangeCard;
  /** The change: every file it touched, as the base and the branch hold it (null where one side has no such file). */
  repo: { files: Array<{ path: string; before: string | null; after: string | null }> };
  approximate?: string[];
}

/** A finished card as a draft: the words its author wrote taken back out. */
export function cardDraftOf(card: ChangeCard): ChangeCard {
  const rest = { ...card } as Record<string, unknown>;
  for (const k of ['headline', 'context']) delete rest[k];
  return { ...rest, wrong: '', change: '', recommend: { verdict: '', why: '' } } as unknown as ChangeCard;
}

/**
 * Ids the project uses inside itself, which nothing a person reads may carry:
 * tasks, decisions, plans, sessions (jx7...), workflow runs (th7...) and
 * freeze uuids.
 */
export const INTERNAL_ID = /\b(?:(?:ct|sd|pl)-\d+|jx7[a-z0-9]{4,}|th7[a-z0-9]{4,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

const REF_FORMS = `card-write@ takes a fixture, or an open problem in this repository whose line run is at its card, like card-write@fixture:<case> or card-write@ct-56750`;

/** The branch names a rep's repository uses: the run's base and the line's own branch. */
const BASE_BRANCH = 'main';
export const branchOf = (task: string) => `codecast/line-${task}`;
export const worktreeOf = (task: string) => `line-${task}`;

/** Where a rep's change and the station's run files live, under the rep's own dir. */
export function repDirs(runDir: string) {
  return { repo: join(runDir, 'worktree'), run: join(runDir, 'line-run') };
}

/** The briefing the runner hands the card_write hand on its first visit, with the run's places filled in. */
export function cardWritePrompt(snap: CardWriteSnap, places: { worktree: string; runDir: string }): string {
  const graph = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.line!);
  const node = graph.nodes.get('card_write');
  if (!node) throw new Error('the line template has no card_write node');
  const context: Record<string, string> = {
    task_id: snap.task.short_id,
    task_title: inlineForeignText(snap.task.title),
    default_branch: BASE_BRANCH,
    branch: branchOf(snap.task.short_id),
    worktree: worktreeOf(snap.task.short_id),
    run_dir: places.runDir,
  };
  if (graph.goal) graph.goal = expandPromptVars(graph.goal, graph, context);
  recordNodeOutput(context, 'card_draft', JSON.stringify({ card: snap.card, errors: cardErrors(snap.card) }, null, 2));
  return stationBrief(node, graph, context);
}

function cardErrors(card: ChangeCard): string[] {
  const v = validateChangeCard(card);
  return v.ok ? [] : v.errors;
}

/** What the station is told about the replay it is in, after the briefing prod sends. */
export const HARNESS_NOTE = [
  '',
  '## Dry run (harness note)',
  '',
  [
    'This run grades the decision you present, so nothing you do reaches anyone.',
    'Every `cast` read answers from a record of the workspace saved for this run, and a read the record does not hold fails.',
    '`cast decide` and `cast state` are recorded rather than sent: post and pin exactly as the brief asks.',
    'Every other command that writes, posts or sends is refused.',
    'The product cannot be served in this run, so build the page from the record, the diff and the code in the worktree, and say on the page what you could not run.',
    'Run every command in the foreground and wait for it.',
  ].join(' '),
].join('\n');

/** A git repository holding the change: the base on `main`, the change on the line's branch, both dated before the capture. */
export function buildChangeRepo(dir: string, snap: CardWriteSnap): string {
  const branch = branchOf(snap.task.short_id);
  const at = new Date(Date.parse(snap.captured_at) - 3_600_000).toISOString();
  const env = { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at, GIT_AUTHOR_NAME: 'line', GIT_AUTHOR_EMAIL: 'line@example.com', GIT_COMMITTER_NAME: 'line', GIT_COMMITTER_EMAIL: 'line@example.com' };
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd: dir, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${dir}: ${r.stderr}`);
  };
  const put = (side: 'before' | 'after') => {
    for (const f of snap.repo.files) {
      const file = join(dir, f.path);
      const text = f[side];
      if (text === null) spawnSync('rm', ['-f', file]);
      else {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
      }
    }
  };
  mkdirSync(dir, { recursive: true });
  git('init', '-q');
  put('before');
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', 'base');
  git('checkout', '-q', '-b', branch);
  put('after');
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', snap.task.title);
  return dir;
}

/** The decision and the report the station's run left with the recording guard. */
export function presented(agent: Pick<AgentResult, 'runSubdir'> | undefined): { decision: CapturedDecision | null; pin: CapturedPin | null } {
  if (!agent) return { decision: null, pin: null };
  const writes = readWrites(agent.runSubdir);
  return { decision: captureDecision(writes), pin: capturePin(writes) };
}

/** The decision as the person sees it: the question, the answers, the context, and the page as text. */
export function decisionText(decision: CapturedDecision): string {
  const page = decision.report?.content ? pageText(decision.report.content) : '(no page)';
  const options = decision.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` :: ${o.description}` : ''}`).join('\n');
  return [`Question: ${decision.question}`, `Answers:\n${options}`, `Context:\n${decision.context}`, `Page:\n${page}`].join('\n\n');
}

/** A page's words in reading order, its markup, styles and scripts dropped. */
export function pageText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|section|h\d|li|tr|figcaption|header|footer)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/**
 * The problem's other reads, drawn from the ones the record holds when it
 * lacks them: `task show` reads as the context does, and `signal ls --task`
 * lists each finding by its `signal show` header line.
 */
export function problemReads(snap: CardWriteSnap): FixtureRead[] {
  const reads = snap.reads ?? [];
  const has = (argv: string[]) => reads.some((r) => r.argv.join(' ') === argv.join(' '));
  const task = snap.task.short_id;
  const context = reads.find((r) => r.argv.join(' ') === `task context ${task}`);
  const out: FixtureRead[] = [];
  if (context && !has(['task', 'show', task])) out.push({ argv: ['task', 'show', task], out: context.out });
  if (!has(['signal', 'ls', '--task', task])) {
    const lines = reads.filter((r) => r.argv[0] === 'signal' && r.argv[1] === 'show' && (r.exit ?? 0) === 0).map((r) => r.out.split('\n')[0]!);
    out.push({ argv: ['signal', 'ls', '--task', task], out: `${lines.join('\n')}\n` });
  }
  return out;
}

/** Per changed file, a cap on what the judge reads of each side; a real change can be large. */
const JUDGE_FILE_CHARS = 8_000;

/** The change as the judge reads it: each file's base and branch text, capped. */
export function changeText(snap: CardWriteSnap): string {
  const side = (text: string | null) => (text === null ? '(no such file)' : text.length > JUDGE_FILE_CHARS ? `${text.slice(0, JUDGE_FILE_CHARS)}\n… (${text.length - JUDGE_FILE_CHARS} more characters)` : text);
  return snap.repo.files.map((f) => `### ${f.path}\n--- base\n${side(f.before)}\n--- branch\n${side(f.after)}`).join('\n\n');
}

/** The findings the world holds: every `sg-N` a `signal show` read answers. */
export const worldSignals = (snap: CardWriteSnap): string[] => (snap.reads ?? []).filter((r) => r.argv[0] === 'signal' && r.argv[1] === 'show' && (r.exit ?? 0) === 0).map((r) => r.argv[2]!);

function findCardFile(ref: string): string {
  const task = ref.trim().toLowerCase();
  if (!/^ct-\d+$/.test(task)) throw new UsageError(REF_FORMS);
  const file = join(lineRunDir(process.cwd(), `line-${task}`), 'card.json');
  if (!existsSync(file)) throw new UsageError(`no line run of ${task} left a card here (${file})`);
  return file;
}

/** A live read through the real CLI, kept as the record answers it. */
function liveRead(argv: string[]): FixtureRead {
  const r = spawnSync('cast', argv, { encoding: 'utf8', cwd: REPO_ROOT });
  return { argv, out: `${r.stdout ?? ''}${r.status ? r.stderr ?? '' : ''}`, exit: r.status ?? 1 };
}

/** The change as the branch and its merge base hold it, file by file. */
function changeFiles(branch: string): CardWriteSnap['repo']['files'] {
  const git = (...args: string[]) => spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
  const ref = [branch, `origin/${branch}`].find((b) => git('rev-parse', '--verify', '-q', b).status === 0);
  if (!ref) throw new UsageError(`no branch ${branch} here or on origin`);
  const base = git('merge-base', 'origin/main', ref).stdout.trim();
  const show = (rev: string, path: string) => {
    const r = git('show', `${rev}:${path}`);
    return r.status === 0 ? r.stdout : null;
  };
  return git('diff', '--name-only', `${base}...${ref}`)
    .stdout.split('\n')
    .filter(Boolean)
    .map((path) => ({ path, before: show(base, path), after: show(ref, path) }));
}

const impl: SurfaceImpl = {
  refForms: REF_FORMS,

  // A capture is the world as the station would meet it: take it while the problem waits at its card, since a problem the person already answered carries the outcome in its own record.
  async capture(ref): Promise<Captured> {
    const file = findCardFile(ref);
    const card = JSON.parse(readFileSync(file, 'utf8')) as ChangeCard;
    if (!card?.cause?.task) throw new UsageError(`${file} is not a change card`);
    const task = card.cause.task;
    const context = liveRead(['task', 'context', task]);
    if (/\| Status: (done|dropped|cancelled) \|/.test(context.out)) throw new UsageError(`${task} is already settled, so its record tells the outcome the station is asked to weigh: capture a problem while its run waits at the card`);
    const list = liveRead(['signal', 'ls', '--task', task]);
    const signals = list.out.match(/\bsg-\d+\b/g) ?? [];
    const snapshot: CardWriteSnap = {
      captured_at: new Date().toISOString(),
      task: { short_id: task, title: card.cause.title },
      card: cardDraftOf(card),
      reads: [context, liveRead(['task', 'show', task]), list, ...[...new Set(signals)].map((sg) => liveRead(['signal', 'show', sg]))],
      repo: { files: changeFiles(branchOf(task)) },
      approximate: ["the draft is the run's last card with its author's words taken out; the proof, checks and diff are as that last build read them"],
    };
    return {
      snapshot,
      subject: { kind: 'task', id: task, title: card.cause.title },
      asOf: snapshot.captured_at,
      anchor: { kind: 'run', id: `card:${task}` },
      name: `card-write ${task}`,
      meta: { task, card_file: file },
    };
  },

  async replay(snap: CardWriteSnap, ctx) {
    const places = repDirs(ctx.runDir);
    const task = snap.task.short_id;
    if (!ctx.dry) buildChangeRepo(places.repo, snap);
    mkdirSync(places.run, { recursive: true });
    // The problem's own reads also answer their longer forms (`task context <id> --json`), from the same record.
    const reads = [...(snap.reads ?? []), ...problemReads(snap)].map((r) => (r.argv[0] === 'task' ? { ...r, prefix: true } : r));
    const serveDir = servedDirFor({ ...snap, reads }, ctx, meta);
    writeServedRead(serveDir, ['ws', 'path', worktreeOf(task)], `${places.repo}\n`, 0);
    writeServedRead(serveDir, ['decide', 'kit'], `${DECISION_KIT_GUIDE.trimEnd()}\n`, 0);
    const a = await ctx.agent({
      prompt: `${cardWritePrompt(snap, { worktree: places.repo, runDir: places.run })}\n${HARNESS_NOTE}`,
      serveDir,
      model: ctx.model,
      maxTurns: 80,
      guard: resolve(REPO_ROOT, 'packages/cli/scripts/line-present-replay-bin'),
    });
    const { decision, pin } = presented(a);
    return { reply: decision ? decisionText(decision) : `(no decision posted)\n\n${a.said.at(-1) ?? ''}`, parsed: { decision, pin: pin?.fields ?? null } };
  },

  gates(snap: CardWriteSnap, out: ReplayResult): GateResult[] {
    const { decision, pin } = presented(out.agents[0]);
    const gates = [gate('decision-posted', !!decision?.question && (decision?.options.length ?? 0) >= 2, decision ? `${decision.options.length} answer(s): ${decision.question}` : 'no `cast decide` was posted')];
    const fields = pin?.fields as Record<string, unknown> | null | undefined;
    gates.push(gate('report-pinned', !!fields, !pin ? 'no `cast state` pin' : fields ? `pinned ${pin.status ?? 'without a status'}` : `the pin holds no json block: ${pin.text.slice(-160)}`));
    if (!fields) return gates;
    const recommend = String(fields.recommend ?? '');
    const why = String(fields.why ?? '');
    gates.push(gate('recommend-valid', (CHANGE_VERDICTS as readonly string[]).includes(recommend) && !!why.trim(), `recommend "${recommend}", why "${why}"`));
    // The run refuses a report the card's own facts contradict: ship over a failing check or a red proof.
    const refused = cardErrors({ ...snap.card, recommend: { verdict: recommend, why } } as ChangeCard).filter((e) => e.startsWith('recommend.'));
    gates.push(gate('facts-agree', refused.length === 0, refused.length ? refused.join('; ') : 'the run would take this report'));
    const posted = decision?.question.trim() ?? '';
    gates.push(gate('question-as-posted', !!posted && String(fields.question ?? '').trim() === posted, `pinned "${String(fields.question ?? '')}" vs posted "${posted}"`));
    const known = new Set(worldSignals(snap));
    const covers = Array.isArray(fields.covers) ? fields.covers.map(String) : [];
    const unknown = covers.filter((sg) => !known.has(sg));
    gates.push(gate('covers-known', Array.isArray(fields.covers) && unknown.length === 0, unknown.length ? `not a finding of this problem: ${unknown.join(', ')}` : `${covers.length} of ${known.size} finding(s)`));
    const page = String(fields.page ?? '');
    gates.push(gate('page-written', !!page && (existsSync(page) || !!decision?.report?.content), page ? `${page}${existsSync(page) ? '' : ' (gone; the decision kept a copy)'}` : 'no page path'));
    const shown = decision ? [decision.question, ...decision.options.map((o) => `${o.label} ${o.description ?? ''}`), decision.context].join('\n') : '';
    const leak = INTERNAL_ID.exec(shown);
    gates.push(gate('no-internal-ids', !leak, leak ? leak[0] : 'none on the card'));
    return gates;
  },

  describe: (snap: CardWriteSnap): ConvoMessage[] =>
    describeTurn(`The problem ${snap.task.short_id} (${snap.task.title}), its change (${snap.repo.files.length} file(s)), and the card the run assembled before the station ran:\n\n${JSON.stringify(snap.card, null, 2)}`, snap.captured_at, 'card'),

  // The briefing is the prompt under test, so the judge reads the record the decision is drawn from.
  judgeMoment: (snap: CardWriteSnap): ConvoMessage[] =>
    describeTurn(
      [
        `(The station's instructions are the prompt under test and are not shown. A run built a change for a problem people met in this product; the station presents the one decision a person makes about it: ship it, revise it or drop it.)`,
        ...(snap.reads ?? []).map((r) => `$ cast ${r.argv.join(' ')}\n${r.out}`),
        `The change, file by file (base, then branch):\n\n${changeText(snap)}`,
        `What the run measured:\n${JSON.stringify(snap.card, null, 2)}`,
      ].join('\n\n'),
      snap.captured_at,
      'record',
    ),

  productionReply: () => null,
};

export default impl;
