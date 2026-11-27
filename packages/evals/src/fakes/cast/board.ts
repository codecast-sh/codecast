import { applyOp, artifactView, opsProblem, toElement, type ArtifactElement, type ArtifactOp } from '@codecast/shared/artifacts';
import { BOARD_VERBS, boardSpec } from '@codecast/shared/artifacts/board';

import { underTarget } from '../../../../cli/src/taskClaim';

import type { Parsed } from './tree';
import type { Answer, Ctx } from './verbs';
import { mint, type FakeWorld } from './world';

// The huddle board as the fake keeps it, for a Scribe replay (ct-102408): one
// board doc's elements, its comments and the call it belongs to. Every layout
// verb is the real BOARD_VERBS run against the world's elements with
// `agent: true`, as the CLI runs it for a session, and its ops are applied
// with the real applyOp, so the board a run leaves is the board prod would
// hold. Listings (priorities, goals, plans, tasks) answer from a seed the
// driver read once from a real workspace, plus what the run created.

const ok = (...lines: string[]): Answer => ({ out: `${lines.join('\n')}\n`, exit: 0 });
const fail = (...lines: string[]): Answer => ({ out: `${lines.join('\n')}\n`, exit: 1 });
const text = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

/** A doc reference as the CLI takes it: an id, doc:<id> or a /docs/<id> URL. */
const docOf = (ref: string): string => ref.replace(/^doc:/, '').replace(/^.*\/docs\//, '').replace(/[/?#].*$/, '');

function boardOf(w: FakeWorld, ref: string): NonNullable<FakeWorld['board']> | Answer {
  const b = w.board;
  if (!b || docOf(ref) !== b.doc) return fail(`Error: No board, sheet or dashboard ${docOf(ref)} that you can open`);
  return b;
}

/** The board's live elements, as `cast board read --json` gives them. */
export function boardElements(w: FakeWorld): ArtifactElement[] {
  const b = w.board;
  if (!b) return [];
  return Object.entries(b.elements)
    .filter(([, e]) => !e.deleted)
    .map(([k, e]) => toElement(k, { kind: e.kind, fields: e.fields }, { rev: e.rev, by: e.by, at: e.at }));
}

const viewOf = (w: FakeWorld) => artifactView('board', w.board!.title, boardElements(w));

/** Ops written as this session, one revision per call, the way /cli/live/apply stamps them. */
function write(w: FakeWorld, ops: readonly ArtifactOp[], verb: string): { rev: number; written: string[] } {
  const b = w.board!;
  b.rev++;
  const by = `s:${w.self}`;
  for (const op of ops) {
    const prev = b.elements[op.k];
    const next = applyOp(prev ? { kind: prev.kind, fields: prev.fields, ...(prev.deleted ? { deleted: true } : {}) } : undefined, op);
    b.elements[op.k] = { kind: next.kind, fields: next.fields, ...(next.deleted ? { deleted: true } : {}), rev: b.rev, by, at: w.seq };
  }
  b.log.push({ seq: w.seq, rev: b.rev, verb, ops: ops.map((o) => JSON.parse(JSON.stringify(o))) });
  return { rev: b.rev, written: ops.map((o) => o.k) };
}

const written = (doc: string, r: { rev: number; written: string[] }) =>
  `ok ${r.written.length} element${r.written.length === 1 ? '' : 's'} written (r${r.rev}) https://codecast.sh/docs/${doc}`;

/** `cast board <verb> <doc> [args...]`: a BOARD_VERBS verb, its own flags parsed by itself, as the CLI hands them over. */
export function boardVerb(name: string, rest: string[], stdin: string, ctx: Ctx): Answer | null {
  const verb = BOARD_VERBS[name];
  if (!verb) return null;
  const { w } = ctx;
  const words = rest.filter((a) => a !== '--draft');
  const json = words.includes('--json');
  const [ref, ...args] = words.filter((a) => a !== '--json');
  if (!ref) return fail("error: missing required argument 'doc'");
  const b = boardOf(w, ref);
  if ('exit' in b) return b;
  let result;
  try {
    result = verb.run(viewOf(w), json ? [...args, '--json'] : args, verb.stdin ? stdin : undefined, { agent: true });
  } catch (e) {
    return fail(`Error: ${(e as Error).message}`);
  }
  if (result.ops.length === 0) return ok(result.status ?? '');
  const problem = opsProblem(result.ops);
  if (problem) return fail(`Error: ${problem}`);
  const r = write(w, result.ops, name);
  if (json) return ok(JSON.stringify({ ...r, ...(result.status ? { status: result.status } : {}) }));
  return ok(written(b.doc, r), ...(result.status ? [result.status] : []));
}

const boardRead = (p: Parsed, ctx: Ctx): Answer => {
  const b = boardOf(ctx.w, String(p.args[0]));
  if ('exit' in b) return b;
  let elements = boardElements(ctx.w);
  if (p.opts.keys) {
    const keys = new Set(String(p.opts.keys).split(',').map((s) => s.trim()));
    elements = elements.filter((e) => keys.has(e.key));
  }
  if (p.opts.json) return ok(JSON.stringify({ id: b.doc, title: b.title, type: 'board', rev: b.rev, draft: null, archived: false, can_edit: true, elements }, null, 2));
  const open = b.comments.filter((c) => !c.parent && !c.resolved);
  return ok(boardSpec.describe(artifactView('board', b.title, elements)), ...(open.length ? ['', `comments: ${open.length} open; \`cast board comments ${b.doc}\``] : []));
};

const boardApply = (p: Parsed, ctx: Ctx): Answer | null => {
  if (p.opts.file) return null;
  const b = boardOf(ctx.w, String(p.args[0]));
  if ('exit' in b) return b;
  const raw = ctx.stdin ?? '';
  let body: any;
  try {
    const parsed = JSON.parse(raw || 'null');
    body = Array.isArray(parsed) ? { ops: parsed } : parsed;
  } catch (e) {
    return fail(`Error: ops must be JSON: ${(e as Error).message}`);
  }
  if (!body || !Array.isArray(body.ops)) return fail('Error: expected a JSON array of ops, or {"ops": [...]}');
  const problem = opsProblem(body.ops);
  if (problem) return fail(`Error: ${problem}`);
  const r = write(ctx.w, body.ops, 'apply');
  return p.opts.json ? ok(JSON.stringify(r)) : ok(written(b.doc, r));
};

const boardRm = (p: Parsed, ctx: Ctx): Answer => {
  const b = boardOf(ctx.w, String(p.args[0]));
  if ('exit' in b) return b;
  const view = viewOf(ctx.w);
  const keys = (p.args[1] as string[]) ?? [];
  const missing = keys.filter((k) => !view.get(k));
  if (missing.length) return fail(`Error: no element ${missing.join(', ')} in this board (\`cast board read <doc> --json\` lists every key)`);
  return ok(written(b.doc, write(ctx.w, [...new Set(keys)].map((k) => ({ k, del: true as const })), 'rm')));
};

const boardCursor = (p: Parsed, ctx: Ctx): Answer => {
  const b = boardOf(ctx.w, String(p.args[0]));
  if ('exit' in b) return b;
  b.cursor = { ...(p.opts.key ? { key: String(p.opts.key) } : {}), ...(p.opts.point ? { point: String(p.opts.point) } : {}), ...(p.opts.status ? { status: String(p.opts.status) } : {}) };
  return ok('ok');
};

const boardComments = (p: Parsed, ctx: Ctx): Answer => {
  const b = boardOf(ctx.w, String(p.args[0]));
  if ('exit' in b) return b;
  if (p.opts.json) return ok(JSON.stringify(b.comments, null, 2));
  const roots = b.comments.filter((c) => !c.parent && (p.opts.all || !c.resolved));
  if (!roots.length) return ok('No comments');
  return ok(...roots.flatMap((r) => [`${r.key}${r.anchor ? ` on ${r.anchor}` : ''}  ${r.author_name}: ${r.text}`, ...b.comments.filter((c) => c.parent === r.key).map((c) => `  ${c.key}  ${c.author_name}: ${c.text}`)]));
};

const boardComment = (p: Parsed, ctx: Ctx): Answer => {
  const b = boardOf(ctx.w, String(p.args[0]));
  if ('exit' in b) return b;
  const key = String(p.args[1]);
  const words = ((p.args[2] as string[]) ?? []).join(' ');
  const k = `cm_${String(ctx.w.seq).padStart(10, '0')}`;
  if (key.startsWith('cm_')) {
    if (!b.comments.some((c) => c.key === key)) return fail(`Error: no comment ${key}`);
    b.comments.push({ key: k, parent: key, text: words, author_name: 'Scribe', by: `s:${ctx.w.self}` });
  } else {
    if (!viewOf(ctx.w).get(key)) return fail(`Error: ${key} names nothing in this board; pass an element key (\`cast board read\` lists them)`);
    b.comments.push({ key: k, anchor: key, text: words, author_name: 'Scribe', by: `s:${ctx.w.self}` });
  }
  return ok(`ok ${k}`);
};

const boardCheckpoint = (p: Parsed, ctx: Ctx): Answer => {
  const b = boardOf(ctx.w, String(p.args[0]));
  if ('exit' in b) return b;
  b.checkpoints.push({ rev: b.rev, label: text(p.args[1]) });
  return ok(`ok saved r${b.rev}`);
};

// ── The call ──────────────────────────────────────────────────────────────

/** `cast call <id|board>`: the call's board, or the live call with what this call created. A transcript read is not modelled: the lines so far are the chunks the session was sent. */
const call = (p: Parsed, ctx: Ctx): Answer | null => {
  const { w } = ctx;
  const id = String(p.args[0]);
  const c = w.call;
  if (!c) return null;
  if (id === 'board') {
    if (!w.board) return null;
    if (p.opts.json) return ok(JSON.stringify({ doc_id: w.board.doc, title: w.board.title, pinned: true }, null, 2));
    return ok(`doc:${w.board.doc}  ${w.board.title}  on the stage`, `https://codecast.sh/docs/${w.board.doc}`, `Read it with \`cast board read ${w.board.doc}\`, write with the \`cast board\` verbs.`);
  }
  if (['hold', 'snap', 'join', 'leave', 'pin', 'unpin', 'pins'].includes(id)) return null;
  if (id.replace(/:.*$/, '') !== c.id) return null;
  if (p.opts.transcript || id.includes(':') || p.args[1]) return ok(`${c.id} is live: the lines said so far are the transcript chunks this session was sent.`);
  const made = Object.values(w.tasks).filter((t) => t.from_call === c.id);
  const madeOther = [...Object.values(w.plans), ...Object.values(w.priorities)].filter((x) => x.from_call === c.id);
  return ok(
    `${c.title} (live)`,
    `${c.id} · ${c.started}`,
    `https://codecast.sh/calls/${c.id}`,
    `speakers: ${c.speakers.join(', ')}`,
    ...(made.length ? ['', 'Tasks', ...made.map((t) => `  ${t.id} ${t.title} (${t.status})`)] : []),
    ...(madeOther.length ? ['', 'Created in this call', ...madeOther.map((x) => `  ${x.id} ${x.title}`)] : []),
    '',
    `Sessions\n  ${w.self} Scribe (fed live)`,
  );
};

const calls = (_p: Parsed, ctx: Ctx): Answer | null => {
  const c = ctx.w.call;
  if (!c) return null;
  return ok(`● ${c.id} ${c.started} live  ${c.title}`, `   ${c.speakers.join(', ')}`, '', 'cast call <id> for summary + transcript');
};

// ── Listings and the objects a huddle creates ─────────────────────────────

/** Seeded lines whose text holds any of the query's words, then what the run made. */
function listed(seed: string[] | undefined, made: Array<{ id: string; title: string; line: string }>, query?: string): string[] {
  const words = (query ?? '').toLowerCase().split(/\s+/).filter((x) => x.length > 2);
  const hit = (s: string) => !words.length || words.some((x) => s.toLowerCase().includes(x));
  return [...(seed ?? []).filter(hit), ...made.filter((m) => hit(m.title)).map((m) => m.line)];
}

const prioritiesLs = (_p: Parsed, ctx: Ctx): Answer | null => {
  const { w } = ctx;
  if (!w.listings) return null;
  const made = Object.values(w.priorities).map((x) => ({ ...x, line: `      ${x.id}  ${x.title}   (new, from ${x.from_call ?? 'no call'})  ${x.owner ?? ''}` }));
  return ok(...listed(w.listings.priorities, made));
};

const goals = (_p: Parsed, ctx: Ctx): Answer | null => (ctx.w.listings?.goals ? ok(ctx.w.listings.goals.trimEnd()) : null);

const planLs = (p: Parsed, ctx: Ctx): Answer | null => {
  const { w } = ctx;
  if (!w.listings) return null;
  const made = Object.values(w.plans).map((x) => ({ ...x, line: `  ○ ${x.id} ${x.title} draft` }));
  const lines = listed(w.listings.plans, made, p.opts.query as string | undefined);
  return ok(...(lines.length ? lines : ['No plans match']));
};

const taskLs = (p: Parsed, ctx: Ctx): Answer | null => {
  const { w } = ctx;
  if (!w.listings) return null;
  const made = Object.values(w.tasks).map((t) => ({ ...t, line: `  ◎ ${t.id} ${t.title}` }));
  const lines = listed(w.listings.tasks, made, p.opts.query as string | undefined);
  return ok(...(lines.length ? lines : ['No tasks match']));
};

const prioritiesCreate = (p: Parsed, ctx: Ctx): Answer => {
  const title = text(p.args[0]).trim();
  if (!title) return fail('Error: a priority needs a title');
  const id = mint(ctx.w, 'pri-');
  ctx.w.priorities[id] = { id, title, ...(p.opts.owner ? { owner: String(p.opts.owner) } : {}), ...(p.opts.fromCall ? { from_call: String(p.opts.fromCall) } : {}) };
  return ok(`ok Created ${id}: ${title}`);
};

const planCreate = (p: Parsed, ctx: Ctx): Answer => {
  const title = text(p.args[0]).trim();
  if (!title) return fail('Error: a plan needs a title');
  const id = mint(ctx.w, 'pl-');
  ctx.w.plans[id] = { id, title, ...(p.opts.goal ? { goal: text(p.opts.goal) } : {}), ...(p.opts.fromCall ? { from_call: String(p.opts.fromCall) } : {}) };
  return ok(`ok Created plan ${id}: ${title}`, `  Run cast plan bind ${id} to bind this session to the plan`);
};

/** `task create --under`, checked by the CLI's own underTarget before anything is filed. */
export function underOf(p: Parsed): { under?: string } | Answer {
  if (p.opts.under === undefined) return {};
  try {
    underTarget(String(p.opts.under), { parent: p.opts.parent as string | undefined, plan: p.opts.plan as string | undefined });
  } catch (e) {
    return fail(`Error: ${(e as Error).message}`);
  }
  return { under: String(p.opts.under).trim().toLowerCase() };
}

export const BOARD_WRITES = ['board apply', 'board rm', 'board cursor', 'board comment', 'board checkpoint', 'priorities create', 'plan create', ...Object.keys(BOARD_VERBS).map((v) => `board ${v}`)];

export const BOARD_HANDLERS: Record<string, (p: Parsed, ctx: Ctx) => Answer | null> = {
  'board read': boardRead,
  'board apply': boardApply,
  'board rm': boardRm,
  'board cursor': boardCursor,
  'board comments': boardComments,
  'board comment': boardComment,
  'board checkpoint': boardCheckpoint,
  call,
  calls,
  'priorities ls': prioritiesLs,
  'priorities create': prioritiesCreate,
  goals,
  'plan ls': planLs,
  'plan create': planCreate,
  'task ls': taskLs,
};
