import { parseChangeGuide } from '@codecast/shared/contracts/changeGuide';

import { briefBudget, briefBudgetWords, briefOverBudgetMessage } from '@codecast/shared/contracts/rolePlaybook';

import { patchBriefNarrative } from '../../../../cli/src/briefLines';
import { parseFindings } from '../../../../cli/src/reviewFindings';

import { BOARD_HANDLERS, BOARD_WRITES, underOf } from './board';
import type { Parsed } from './tree';
import { mint, type FakeTask, type FakeWorld } from './world';

// What each `cast` verb does to the world and prints, written from the
// answers real calls got (EVALS_HOME/fakes/captures) and checked against
// held-out ones (`./evals fakes fidelity`). A handler sees the argv parsed the
// way the CLI parses it, and returns null to decline: the call then goes on
// to the guard as before (a read to its record, a write refused), so a verb
// the fake does not model is never answered with a guess.

export interface Ctx {
  w: FakeWorld;
  /** The call's stdin, for a verb the CLI reads it for whole (`board apply`, `board place`). */
  stdin?: string;
}

export interface Answer {
  out: string;
  exit: number;
  /** The CLI's own refusal of the argv at parse time (commander's words): no command ran. */
  cli?: true;
}

type Handler = (p: Parsed, ctx: Ctx) => Answer | null;

const ok = (...lines: string[]): Answer => ({ out: `${lines.join('\n')}\n`, exit: 0 });
const fail = (...lines: string[]): Answer => ({ out: `${lines.join('\n')}\n`, exit: 1 });

/** An argument or option value; a '-' was already read from stdin by the parser, as the CLI reads it. */
const text = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

const SESSION = /^jx[0-9a-z]{5,}$/;
const TASK = /^ct-\d+$/;
const TRIGGER = /^tr-\d+$/;
const DECISION = /^sd-\d+$/;
const HANDLE = /^[a-z][a-z0-9-]*$/;

/** A map's own entry, never one inherited: an id the agent types (`__proto__`) must not reach Object.prototype. */
const own = <T>(map: Record<string, T>, key: string): T | undefined => (typeof map === 'object' && map !== null && Object.hasOwn(map, key) ? map[key] : undefined);

const ASSIGNEE_NOTE = 'An assignee is who answers for the task being done, never who may work on it: any session may work any task.';
const STATE_TAG: Record<string, string> = { working: 'in progress', blocked: 'needs you', done: 'complete', dormant: 'dormant' };
const PIN_HINT = '(the human already sees the pin: do not mention this update in your reply. Rewrite it when this changes; `cast state clear` when it no longer holds)';

/** A target the world knows, or one a real workspace would hold: the fake answers sends to any well-formed session id. */
function sendTo(ctx: Ctx, kind: string, to: string, body: string, label = to): Answer {
  ctx.w.sent.push({ seq: ctx.w.seq, kind, to, text: body });
  return ok(`✓ sent to ${label} from ${ctx.w.self}, arrives now`);
}

/**
 * Whether a target exists, as far as this world can say: one it made, or one
 * the replay's record or prompt names. An open world (fidelity scoring, where
 * every target the real call named existed) takes any well-formed id; a world
 * with no record to go on cannot tell, and the call is left to the guard.
 */
function exists(w: FakeWorld, id: string, made = false): 'yes' | 'no' | 'unsure' {
  if (made || w.open || w.self === id) return 'yes';
  if (!w.known) return 'unsure';
  return w.known.includes(id) || Object.values(w.roles).some((r) => r?.session === id) ? 'yes' : 'no';
}

const send: Handler = (p, ctx) => {
  const [to, body] = p.args as [string, string | undefined];
  const message = text(body);
  if (!message.trim()) return fail('Error: Message text is empty');
  // A short id is the first seven characters of the session's id: a longer one resolves to it.
  const short = SESSION.test(to) ? to.slice(0, 7) : to;
  const there = exists(ctx.w, short);
  if (there === 'unsure') return null;
  if (there === 'no') return fail('Error: Conversation not found');
  return sendTo(ctx, 'send', short, message);
};

const state: Handler = (p, ctx) => {
  const args = (p.args[0] as string[] | undefined) ?? [];
  const { w } = ctx;
  if (args[0] === 'show') return null;
  if (args[0] === 'clear') {
    if (p.opts.status !== undefined) return fail(`--status goes with a state to pin: cast state --status ${p.opts.status} "<text>"`);
    const had = !!w.pin;
    delete w.pin;
    return ok(had ? `ok cleared the pinned state on ${w.self}` : `${w.self} had no pinned state`);
  }
  if (!args.length) {
    if (p.opts.status !== undefined) return fail(`--status goes with a state to pin: cast state --status ${p.opts.status} "<text>"`);
    if (!w.pin) return ok(`${w.self} has no pinned state`);
    return ok(`${w.self} [${STATE_TAG[w.pin.status]}]`, ...w.pin.text.split('\n').map((l) => `  ${l}`));
  }
  const status = String(p.opts.status ?? 'working');
  if (!STATE_TAG[status]) return fail(`Unknown --status "${status}": use working, blocked, done, or dormant`);
  const body = args.length === 1 ? text(args[0]) : args.join(' ');
  if (!body.trim()) return fail('Empty state: pass text to pin, or `cast state clear` to remove it');
  w.pin = { text: body.trim(), status };
  return ok(`ok pinned the state of ${w.self} [${STATE_TAG[status]}] ${PIN_HINT}`);
};

const taskCreate: Handler = (p, ctx) => {
  const { w } = ctx;
  const title = text(p.args[0]).trim();
  if (!title) return fail('Error: a task needs a title');
  const under = underOf(p);
  if ('exit' in under) return under;
  const id = mint(w, 'ct-');
  const explicit = p.opts.foundDuring as string | undefined;
  const found = explicit === 'none' ? undefined : explicit ?? w.bound;
  const t: FakeTask = {
    id,
    title,
    status: 'open',
    priority: String(p.opts.priority ?? 'medium'),
    type: String(p.opts.type ?? 'task'),
    ...(p.opts.description !== undefined ? { description: text(p.opts.description) } : {}),
    ...(p.opts.plan ? { plan: String(p.opts.plan) } : {}),
    ...(p.opts.project ? { project: String(p.opts.project) } : {}),
    ...(found ? { found_during: found } : {}),
    ...(p.opts.fromCall ? { from_call: String(p.opts.fromCall) } : {}),
    ...(under.under ? { under: under.under } : {}),
    ...(p.opts.assignee ? { assignee: String(p.opts.assignee) } : {}),
    comments: [],
  };
  w.tasks[id] = t;
  return ok(`ok Created ${id}: ${title}`, ...(found ? [`  found during ${found}${explicit ? '' : ' (pass --found-during none when filing unrelated work)'}`] : []));
};

/** A task the call names: one the world created, or one a real workspace holds (an id the fake never saw is taken as existing). */
/** A task the call names: the world's own, one the record holds ('outside'), one prod would not find ('missing'), or null when this world cannot tell. */
function taskRef(ctx: Ctx, id: string): FakeTask | 'outside' | 'missing' | null {
  if (!TASK.test(id)) return ctx.w.known || ctx.w.open ? 'missing' : null;
  const t = own(ctx.w.tasks, id);
  if (t) return t;
  const there = exists(ctx.w, id);
  return there === 'yes' ? 'outside' : there === 'no' ? 'missing' : null;
}

const taskComment: Handler = (p, ctx) => {
  const id = String(p.args[0]);
  const t = taskRef(ctx, id);
  if (!t) return null;
  if (t === 'missing') return fail(`Error: Task not found: ${id}`);
  const body = text(p.args[1]);
  if (!body.trim()) return fail('Error: empty comment');
  if (t !== 'outside') t.comments.push({ type: String(p.opts.type ?? 'note'), text: body, seq: ctx.w.seq });
  return ok(`ok Comment added to ${id}`);
};

/** `task update`: a task the turn created takes the new words; one the record holds is answered as prod would and left as it was. */
const taskUpdate: Handler = (p, ctx) => {
  const id = String(p.args[0]);
  const t = taskRef(ctx, id);
  if (!t) return null;
  if (t === 'missing') return fail(`Error: Task not found: ${id}`);
  if (t !== 'outside') {
    if (p.opts.title !== undefined) t.title = text(p.opts.title);
    if (p.opts.description !== undefined) t.description = text(p.opts.description);
    if (p.opts.assignee !== undefined) t.assignee = String(p.opts.assignee);
    if (p.opts.status !== undefined) t.status = String(p.opts.status);
    if (p.opts.priority !== undefined) t.priority = String(p.opts.priority);
  }
  return ok(`ok Updated ${id}`);
};

/** `task drop`: the task is cancelled, as prod words it. */
const taskDrop: Handler = (p, ctx) => {
  const id = String(p.args[0]);
  const t = taskRef(ctx, id);
  if (!t) return null;
  if (t === 'missing') return fail(`Error: Task not found: ${id}`);
  if (t !== 'outside') t.status = 'dropped';
  return ok(`ok Dropped ${id}`);
};

const taskStart: Handler = (p, ctx) => {
  const id = String(p.args[0]);
  const t = taskRef(ctx, id);
  if (!t) return null;
  if (t === 'missing') return fail(`Error: Task not found: ${id}`);
  if (t !== 'outside') t.status = 'in_progress';
  ctx.w.bound = id;
  return ok(`ok Started ${id}`, ASSIGNEE_NOTE);
};

const taskHandoff: Handler = (p, ctx) => {
  const id = String(p.args[0]);
  const t = taskRef(ctx, id);
  if (!t) return null;
  if (t === 'missing') return fail(`Error: Task not found: ${id}`);
  const status = String(p.opts.status ?? 'done');
  // Blocked evidence leaves the task where it is, held by whatever blocks it: the world does not hold that.
  if (status === 'blocked') return null;
  if (t !== 'outside') t.status = 'in_review';
  let steps = 0;
  if (p.opts.guide !== undefined) {
    try {
      steps = parseChangeGuide(text(p.opts.guide)).steps.length;
    } catch (e) {
      return fail(`Error: ${(e as Error).message}`);
    }
  }
  return ok(`ok Handed off ${id} (${status}) → in_review${steps ? ` · guide, ${steps} steps` : ''}`);
};

const taskVerdict: Handler = (p, ctx) => {
  const [id, verdict] = p.args as [string, string];
  const t = taskRef(ctx, id);
  if (!t) return null;
  if (t === 'missing') return fail(`Error: Task not found: ${id}`);
  const next = verdict === 'approve' ? 'done' : 'in_progress';
  if (t !== 'outside') t.status = next;
  const findings = parseFindings(p.opts.note as string | undefined).findings.length;
  return ok(`ok Verdict ${verdict} on ${id} → ${next}`, ...(findings ? [`${findings}/${findings} findings recorded on ${id}`] : []));
};

/** `task show` answers only for a task the turn created; any other is the record's to answer. */
const taskShow: Handler = (p, ctx) => {
  const id = String(p.args[0]);
  const t = TASK.test(id) ? own(ctx.w.tasks, id) : undefined;
  if (!t) return null;
  const label = { open: 'Open', in_progress: 'In Progress', in_review: 'In Review', done: 'Done' }[t.status] ?? t.status;
  return ok(
    `  ◎ ${t.title}`,
    `  ${t.id} | ${label} | ${t.priority} | ${t.type}`,
    ...(t.plan ? [`  Plan: ${t.plan}`] : []),
    ...(t.description ? ['', ...t.description.split('\n').map((l) => `  ${l}`)] : []),
    ...(t.found_during ? [`  Found during: ${t.found_during}`] : []),
    ...(t.comments.length ? ['', `  Comments (${t.comments.length})`, ...t.comments.map((c) => `  [${c.type}] ${c.text.split('\n')[0]}`)] : []),
  );
};

const triggerAdd: Handler = (p, ctx) => {
  const prompt = text(p.args[0]);
  const first = prompt.split('\n').find((l) => l.trim()) ?? prompt;
  const title = p.opts.title !== undefined ? text(p.opts.title) : first.trim().replace(/^[#*\s]+/, '').slice(0, 60);
  const id = mint(ctx.w, 'tr-');
  // As prod prints it: --at falls through to "queued now", the receipt names only every, an event and in.
  const schedule = p.opts.every ? `every ${p.opts.every}` : p.opts.in ? `in ${p.opts.in}` : 'queued now';
  ctx.w.triggers[id] = { id, title, schedule, status: 'active' };
  return ok(`+ Trigger ${id} ${schedule}: ${title}`);
};

const triggerComplete: Handler = (p, ctx) => {
  const id = String(p.args[0]);
  const t = TRIGGER.test(id) ? own(ctx.w.triggers, id) : undefined;
  const there = TRIGGER.test(id) ? exists(ctx.w, id, !!t) : ctx.w.known || ctx.w.open ? 'no' : 'unsure';
  if (there === 'unsure') return null;
  if (there === 'no') return fail('Trigger not found');
  if (t) t.status = 'completed';
  return ok(`ok Trigger completed: ${id}`);
};

/** The role whose standing session is the caller, if any. */
const ownRole = (w: FakeWorld): { handle: string; title: string } | null => {
  const hit = Object.entries(w.roles).find(([, r]) => r.session === w.self);
  return hit ? { handle: hit[0], title: hit[1].title } : null;
};

/** As the CLI's brief edit (index.ts): its argument checks in order, prod's own patch and budget, the narrative kept in the world. */
const briefEdit: Handler = (p, ctx) => {
  const { w } = ctx;
  const body = p.args[0] as string | undefined;
  const { old, new: replacement, all } = p.opts as { old?: string; new?: string; all?: boolean };
  const patching = old !== undefined || replacement !== undefined;
  if (patching && (old === undefined || replacement === undefined)) return fail('--old and --new go together: --old "text to find" --new "replacement"');
  if (patching && body !== undefined) return fail('Pass the whole narrative or --old/--new, not both');
  if (all && !patching) return fail('--all replaces every occurrence of --old; pass --old "text" --new "replacement" with it');
  if (!patching && body === undefined) return fail('Pass the narrative (cast brief edit - < brief.md) or one change (--old "text" --new "replacement")');
  // Another role's brief, or a patch over a narrative this world never held: the record has no answer the fake could stand behind.
  if (p.opts.for) return null;
  if (!ownRole(w)) return fail("Not inside a role's session: name the role with --for @handle");
  let content = body ?? '';
  let replaced = 0;
  if (patching) {
    if (w.brief === undefined) return null;
    const patched = patchBriefNarrative(w.brief, old!, replacement!, !!all);
    if ('error' in patched) return fail(patched.error);
    ({ content, replaced } = patched);
  }
  const budget = briefBudget(content);
  if (budget.over) return fail(`Error: ${briefOverBudgetMessage(budget)}`);
  w.brief = content;
  return ok(`ok brief updated${patching ? ` (${replaced} replacement${replaced === 1 ? '' : 's'})` : ''} · ${briefBudgetWords(budget)} · state line mirrored onto the standing session`);
};

const roleWake: Handler = (p, ctx) => {
  const handle = String(p.args[0]).replace(/^@/, '');
  const body = text(p.args[1]);
  const session = HANDLE.test(handle) ? own(ctx.w.roles, handle)?.session : undefined;
  // A roster says who exists; without one (and outside an open world) the fake cannot tell.
  if (!session && !ctx.w.open) return Object.keys(ctx.w.roles).length ? fail(`No role "${String(p.args[0])}" in this workspace.`) : null;
  return sendTo(ctx, 'role wake', `@${handle}`, body, session ? `@${handle} (${session})` : `@${handle}`);
};

const splitOptions = (raw: unknown): Array<{ label: string; description?: string }> =>
  ((raw as string[] | undefined) ?? []).map((o) => {
    const [label, description] = o.split('::').map((s) => s.trim());
    return { label: label!, description };
  });

const seeLines = (context: string): string[] => ['', '  ── what they will see ──', ...(context.length > 400 ? `${context.slice(0, 400)}…` : context).split('\n').map((l) => `  ${l}`)];

const NO_CONSEQUENCE = '  Note: no option carries a consequence. "Label :: what happens if chosen" is what makes a choice decidable at a glance.';

/** `decide edit` on a decision the world can vouch for: its question, options and context, as prod lists what changed. */
function decideEdit(p: Parsed, ctx: Ctx, id: string | undefined): Answer | null {
  const { w } = ctx;
  if (!id || !DECISION.test(id)) return null;
  const d = own(w.decisions, id);
  if (exists(w, id, !!d) !== 'yes') return null;
  const { question, option, context, ...others } = p.opts as { question?: string; option?: string[]; context?: string };
  if (Object.values(others).some((v) => v !== undefined && v !== false && !(Array.isArray(v) && !v.length))) return null;
  const options = splitOptions(option);
  const changed = [...(question !== undefined ? ['question'] : []), ...(options.length ? ['options'] : []), ...(context !== undefined ? ['context_md'] : [])];
  if (!changed.length) return null;
  if (d) {
    if (question !== undefined) d.question = text(question);
    if (options.length) d.options = options.map((o) => o.label);
  }
  const lines = [`Decision updated: ${id}`, `  changed: ${changed.join(', ')}`];
  options.forEach((o, i) => lines.push(`  ${i + 1}. ${o.label}${o.description ? `: ${o.description}` : ''}`));
  if (context !== undefined) lines.push(...seeLines(text(context)));
  if (options.every((o) => !o.description)) lines.push(NO_CONSEQUENCE);
  lines.push('The card in the conversation and the queue now show the new text. Do not restate it in prose.');
  return ok(...lines);
}

const DECIDE_READS = new Set(['ls', 'show', 'brief', 'kit']);

const decide: Handler = (p, ctx) => {
  const { w } = ctx;
  const q = p.args[0] as string | undefined;
  const rest = (p.args[1] as string[] | undefined) ?? [];
  if (q === undefined || DECIDE_READS.has(q)) return null;
  if (q === 'recommend') {
    const [id, n] = rest;
    if (!id || !DECISION.test(id)) return null;
    const d = own(w.decisions, id);
    if (d) d.recommended = n;
    const mine = ownRole(w);
    return ok(`Recommended: option ${n} on ${id}${mine ? ` as ${mine.title}` : ''}.`, '  The card is in its people\'s queue now; they decide. If your role holds a grant for this category here, answer instead: cast decide answer.');
  }
  if (q === 'cancel') {
    const id = rest[0];
    if (id && !DECISION.test(id)) return null;
    const d = id ? own(w.decisions, id) : undefined;
    if (d) d.status = 'cancelled';
    return ok(`ok Cancelled ${id ?? 'the open decision'}`);
  }
  if (q === 'answer') {
    const [id, n] = rest;
    if (!id || !DECISION.test(id)) return null;
    const d = own(w.decisions, id);
    if (p.opts.forHuman) {
      const label = d?.options[Number(n) - 1];
      if (!d || !label) return null;
      d.status = 'answered';
      return ok(`Answered: ${id} → ${label} (as your human, at their word).`, '  The answer is delivered to the asking session as a message.');
    }
    // A role answers only what a grant lets it hold, and this world grants nothing: prod points it at recommend.
    const mine = ownRole(w);
    return mine ? fail(`${mine.title} does not hold this decision; recommend instead (cast decide recommend), or a person answers it`) : null;
  }
  if (q === 'edit') return decideEdit(p, ctx, rest[0]);
  if (q === 'pass') return null;
  const question = q;
  const options = splitOptions(p.opts.option);
  const context = p.opts.context !== undefined ? text(p.opts.context) : undefined;
  if (p.opts.advisory && p.opts.default === undefined) return fail('--advisory requires --default <n>: say which option you are proceeding with.');
  if (!context && !p.opts.report && !p.opts.doc && !p.opts.card) return fail('A bare question is not decidable. Pass --context (or --report, --doc or --card) with the reasoning and the tradeoff.');
  const id = mint(w, 'sd-');
  w.decisions[id] = { id, question, options: options.map((o) => o.label), status: 'open' };
  const def = p.opts.default !== undefined ? Number(p.opts.default) - 1 : undefined;
  const task = p.opts.task as string | undefined;
  const lines = [`Decision posted: ${question}`, `  id: ${id}`, `  category: ${p.opts.category ?? 'unknown'}`, ...(task ? [`  task: ${task} held at ${(TASK.test(task) ? own(w.tasks, task)?.status : undefined) ?? 'in_progress'}`] : [])];
  options.forEach((o, i) => lines.push(`  ${i + 1}. ${o.label}${o.description ? `: ${o.description}` : ''}${def === i ? '  (your default)' : ''}`));
  if (context) lines.push(...seeLines(context));
  const chars = (context ?? '').trim().length;
  if (!p.opts.report && chars < 200) lines.push('', `  Note: ${chars} characters of context. They will probably have to open the session to answer this.`, '  Open with what you would pick and why, in words someone who never saw this session follows, then the finding that forces the choice, or attach --report.');
  if (options.length && options.every((o) => !o.description)) lines.push(NO_CONSEQUENCE);
  lines.push('', 'This renders as a card in the conversation and in their queue. Do not repeat the question, options, or reasoning in prose.', 'If the facts change: cast decide edit, never a second decision. If it no longer applies: cast decide cancel.');
  lines.push(p.opts.advisory ? 'Advisory: continue with your default. The human\'s answer arrives as a message and may override you.' : 'Blocking: end your turn now. The answer arrives as a user message.');
  return ok(...lines);
};

/**
 * One chat line as the CLI reports it (index.ts sendChatLine): its id, and
 * the roles its @mentions woke or, in a direct message that woke none, the
 * workspace agent left asleep, since every line an agent writes is
 * agent_authored. In an open world any @handle that is not a person is a role.
 */
function chatLine(ctx: Ctx, kind: string, channel: string, body: string, to: string[] = []): string[] {
  const { w } = ctx;
  const id = `j1${mint(w, 'msg').slice('msg'.length).padStart(30, '0')}`;
  w.sent.push({ seq: w.seq, kind, to: channel, text: body });
  const isRole = (h: string) => !!own(w.roles, h) || (!!w.open && !own(w.people, h) && !to.includes(h));
  const roles = new Set([...body.matchAll(/(?:^|[\s(])@([a-z][a-z0-9-]*)/g)].map((m) => m[1]!).filter(isRole));
  return [
    `✓ sent ${id}`,
    ...(roles.size ? [`  mentions: woke ${roles.size} role${roles.size === 1 ? '' : 's'}`] : to.length ? ["• the workspace's agent was not woken: agent_authored"] : []),
  ];
}

/** The people a direct message names, as prod checks them: an answer when the world knows the team's people, else null. */
function dmCheck(ctx: Ctx, handles: string[]): Answer | 'ok' | null {
  if (!handles.length || handles.every((h) => h === 'me')) return fail('Error: Pick at least one person to message (not yourself)');
  if (ctx.w.open) return 'ok';
  const people = Object.keys(ctx.w.people);
  if (!people.length) return null;
  const nobody = handles.find((h) => !HANDLE.test(h) || !own(ctx.w.people, h));
  return nobody ? fail(`Error: No teammate answers to @${nobody}. People here: ${people.map((h) => `@${h}`).join(', ')}`) : 'ok';
}

const chatSend: Handler = (p, ctx) => {
  const channel = String(p.opts.channel);
  const dm = channel.startsWith('@') ? channel.split(',').map((h) => h.trim().replace(/^@/, '')).filter(Boolean) : [];
  if (channel.startsWith('@')) {
    const check = dmCheck(ctx, dm);
    if (check !== 'ok') return check;
  } else if (!ctx.w.open) {
    // A #name the record's channel list holds; a bare id the fake cannot check.
    const name = channel.replace(/^#/, '').trim().toLowerCase();
    if (!ctx.w.channels || !channel.startsWith('#')) return null;
    if (!ctx.w.channels.includes(name)) return fail(`No channel named #${name}. See: cast chat channels`);
  }
  return ok(...chatLine(ctx, 'chat', channel, text(p.args[0]), dm));
};

const chatDm: Handler = (p, ctx) => {
  const handles = String(p.args[0] ?? '').split(',').map((h) => h.trim().replace(/^@/, '')).filter(Boolean);
  const check = dmCheck(ctx, handles);
  if (check !== 'ok') return check;
  const ref = handles.map((h) => `@${h}`).join(',');
  return ok(`to ${handles.map((h) => own(ctx.w.people, h) ?? h).join(', ')}`, ...chatLine(ctx, 'dm', ref, text(p.args[1]), handles), `  their replies: cast chat read --channel ${ref}`);
};

/** The writes the fake answers, as an agent types them: what a harness note under --fakes tells the agent it may run. */
export const FAKED_WRITES = ['send', 'state', 'task create', 'task comment', 'task update', 'task drop', 'task start', 'task handoff', 'task verdict', 'trigger add', 'trigger complete', 'brief edit', 'role wake', 'decide', 'chat send', 'chat dm', ...BOARD_WRITES];

/** Each modelled command path, joined by spaces. */
export const VERBS: Record<string, Handler> = {
  send,
  state,
  'task create': taskCreate,
  'task comment': taskComment,
  'task update': taskUpdate,
  'task drop': taskDrop,
  'task start': taskStart,
  'task handoff': taskHandoff,
  'task verdict': taskVerdict,
  'task show': taskShow,
  'trigger add': triggerAdd,
  'trigger complete': triggerComplete,
  'brief edit': briefEdit,
  'role wake': roleWake,
  decide,
  'chat send': chatSend,
  'chat dm': chatDm,
  ...BOARD_HANDLERS,
};
