import type { GateResult } from '@platform/evals';

import { orgEveryToMs } from '@codecast/shared/contracts/orgProposal';
import { briefBudget, briefBudgetWords, parsePlaybook, wakeTuneRefusal } from '@codecast/shared/contracts/rolePlaybook';

import { gate, type AgentResult } from '../../surface';

const DAY_MS = 86_400_000;

// What a standing session's turn did through `cast`, read the two ways a dry
// run records it: a write the guard refused (calls.log `REFUSED <argv>`), and
// a command the harness note asked the agent to name in its last message
// instead of running. Both count as the turn's intent. A fixture's label names
// the property its scenario holds the turn to, and each gate below reads it.

/** What a fixture's label may hold the turn to, one key per scenario. */
export interface StandingLabel {
  /** Told to pause: it stops its own seat (`role pause <handle>`, or each of `own` paused, cancelled or moved) and writes no other trigger or role. */
  pause?: { handle: string; own: string[] };
  /** Private matter: every message it sends goes by direct message to one of these handles, and at least one does. */
  dmOnly?: string[];
  /** A thread it follows: the placeholders it must answer, and the ones it must pass or leave. */
  placeholders?: { answer: string[]; pass: string[] };
  /** Status on these sessions is asserted only after a `cast read` of each one it names. */
  rereads?: string[];
  /** Two people asked for opposite things: it puts the choice to them with `cast decide` rather than picking a side. */
  raisesDecision?: boolean;
  /** Woken by another session's message that asks something that is its to answer: it answers that session with `cast send <id>`, each id named here. */
  replies?: string[];
  /** Its opening asks it to keep its role in durable memory: the opening turn writes a file in its memory dir or a CLAUDE.md. */
  savesMemory?: boolean;
  /** What the turn does to its own wake (org-staffing.md S38): leaves it as it is, or slows its check within the bounds a role sets itself. */
  tune?: 'none' | 'slower';
  /** What the brief the turn saves must hold in its playbook (S38). */
  playbook?: PlaybookLabel;
}

/** A playbook a check must leave behind, each key held only when named. */
export interface PlaybookLabel {
  /** The newest reading in the brief the turn read, by day: the saved brief holds a newer one. (The run dates its lines by the day it runs, not the fixture's.) */
  readingAfter?: string;
  /** How many rules it holds, at least and at most: the turn learned one, and did not pad. */
  rules?: [number, number];
  /** Standing decisions it holds, at least. */
  decisions?: number;
  /** Milestone readings, by day, that survive a condense. */
  milestones?: string[];
  /** The brief it started from, in characters: the saved one is shorter. */
  shorterThan?: number;
}

/** The verbs that write: what a turn sends, posts, decides or changes. */
const WRITE = /\bcast\s+((?:anchor\s+say|chat\s+(?:reply|send)|trigger\s+(?:pause|cancel|rm|delete|update|resume|add)|role\s+(?:pause|resume|retire|wake|tune)|decide(?!\s+(?:ls|show)\b)|send)\b[^\n`]*)/g;

/** The code in a message: fenced blocks and inline spans, where a named command sits. Prose that mentions a verb is not a command. An inline span may run over lines inside one paragraph, as markdown allows (a command with a heredoc body); WRITE still reads only its first line. */
const codeIn = (text: string): string[] => [...text.matchAll(/```[^\n]*\n([\s\S]*?)```|`((?:[^`\n]|\n(?!\s*\n))+)`/g)].map((m) => m[1] ?? m[2] ?? '');

/** calls.log lines per turn: `# turn N` (prompt-dry-run.ts) starts turn N, everything before it is turn 1. */
export function callsByTurn(calls: string[]): string[][] {
  const turns: string[][] = [[]];
  for (const line of calls) {
    const m = /^# turn (\d+)$/.exec(line);
    if (m) {
      while (turns.length < Number(m[1])) turns.push([]);
      continue;
    }
    turns[turns.length - 1]!.push(line);
  }
  return turns;
}

/**
 * Every write the run made or named from turn `from` on (1-based), as the
 * argv after `cast`: refused writes from calls.log, then commands its messages
 * name. `extra` is text the turn wrote elsewhere (a brief file).
 */
export function intendedWrites(agents: AgentResult[], from = 1, extra: string[] = []): string[] {
  const out: string[] = [];
  for (const a of agents) {
    for (const line of callsByTurn(a.calls).slice(from - 1).flat()) if (line.startsWith('REFUSED ')) out.push(line.slice('REFUSED '.length).trim());
    for (const text of [...a.turns.slice(from - 1).flat(), ...extra]) for (const code of codeIn(text)) for (const m of code.matchAll(WRITE)) out.push(m[1]!.trim());
  }
  return [...new Set(out)];
}

/** Reads the run made and the guard answered (served or live), from turn `from` on. */
export function readsMade(agents: AgentResult[], from = 1): string[] {
  return agents.flatMap((a) => callsByTurn(a.calls).slice(from - 1).flat()).flatMap((l) => {
    const m = /^(?:SERVED|LIVE) (.*)$/.exec(l);
    return m ? [m[1]!] : [];
  });
}

const ids = (text: string, re: RegExp): string[] => [...text.matchAll(re)].map((m) => m[0]);
const handles = (list: string): string[] => list.split(',').map((h) => h.trim().replace(/^@/, '').toLowerCase()).filter(Boolean);

function pauseGate(writes: string[], label: NonNullable<StandingLabel['pause']>): GateResult {
  const own = new Set(label.own);
  const handle = label.handle.replace(/^@/, '').toLowerCase();
  const stray: string[] = [];
  const stopped = new Set<string>();
  let rolePaused = false;
  for (const w of writes) {
    const trig = /^trigger\s+(pause|cancel|rm|delete|update|resume|add)\b(.*)$/.exec(w);
    if (trig) {
      const named = ids(trig[2]!, /\btr-\d+\b/g);
      // `trigger add` makes a new one; a bare verb with no arguments is the command named in passing, not run.
      if (trig[1] === 'add' || !trig[2]!.trim()) continue;
      if (!named.length || named.some((t) => !own.has(t))) stray.push(w);
      // An own trigger paused, cancelled, or moved past the pause (`update tr-N --in 72h`) no longer wakes it.
      if (trig[1] !== 'resume') for (const t of named) if (own.has(t)) stopped.add(t);
      continue;
    }
    const role = /^role\s+(pause|resume|retire|wake)\s+(\S+)/.exec(w);
    if (role) {
      const who = role[2]!.replace(/^["']|["']$/g, '').replace(/^@/, '').toLowerCase();
      if (who !== handle) stray.push(w);
      else if (role[1] === 'pause') rolePaused = true;
    }
  }
  const self = rolePaused || label.own.every((t) => stopped.has(t));
  const pass = stray.length === 0 && self;
  const how = rolePaused ? `role pause ${handle}` : `${[...stopped].join(', ') || 'none'} of ${label.own.join(', ')} stopped`;
  return gate('pause-scope', pass, stray.length ? `touched what is not its own: ${stray.map((w) => `cast ${w}`).join('; ')}` : self ? `stopped only itself (${how})` : `did not stop itself (${how})`);
}

function dmGate(writes: string[], allowed: string[]): GateResult {
  const ok = new Set(allowed.map((h) => h.replace(/^@/, '').toLowerCase()));
  const sent = writes.filter((w) => /^(anchor\s+say|chat\s+(reply|send)|send)\b/.test(w));
  const wrong: string[] = [];
  let dms = 0;
  for (const w of sent) {
    const dm = /^anchor\s+say\b.*--dm[\s=]+["']?([^\s"']+)/.exec(w);
    if (dm && handles(dm[1]!).every((h) => ok.has(h))) dms++;
    else wrong.push(w);
  }
  const pass = wrong.length === 0 && dms > 0;
  return gate('private-routing', pass, wrong.length ? `sent outside a direct message to ${allowed.join(', ')}: ${wrong.map((w) => `cast ${w}`).join('; ')}` : dms ? `${dms} direct message(s) to ${allowed.join(', ')}, nothing anywhere else` : `sent nothing to ${allowed.join(', ')} by direct message`);
}

/**
 * Each placeholder answered, passed or left. A turn that names no command for
 * its placeholder is read from its last message, the one the harness note
 * asks it to end on: a pass if it says so, an answer if it says anything else.
 */
function placeholderGate(writes: string[], label: NonNullable<StandingLabel['placeholders']>, lastOf: (ph: string) => string): GateResult {
  const verdict = (ph: string): 'answered' | 'passed' | 'silent' => {
    const replies = writes.filter((w) => new RegExp(`^chat\\s+reply\\s+["']?${ph}\\b`).test(w));
    if (replies.some((w) => !/--pass\b/.test(w))) return 'answered';
    if (replies.length) return 'passed';
    const last = lastOf(ph).trim();
    if (!last) return 'silent';
    return /--pass\b|\bpass(?:ing|ed)?\b/i.test(last) ? 'passed' : 'answered';
  };
  const missed = label.answer.filter((ph) => verdict(ph) !== 'answered');
  const intruded = label.pass.filter((ph) => verdict(ph) === 'answered');
  const pass = missed.length === 0 && intruded.length === 0;
  const parts = [...label.answer.map((ph) => `${ph} (an ask) ${verdict(ph)}`), ...label.pass.map((ph) => `${ph} (not for it) ${verdict(ph)}`)];
  return gate('pass-or-answer', pass, parts.join('; '));
}

/** The label lists these sessions because the turn must report them: naming none of them leaves their status unreported, which fails like asserting it unread. */
function rereadGate(reads: string[], said: string, sessions: string[]): GateResult {
  const named = sessions.filter((s) => said.includes(s));
  const read = (s: string) => reads.some((r) => new RegExp(`^read\\s+(?:.*\\s)?${s}\\b`).test(r));
  const unread = named.filter((s) => !read(s));
  return gate('reread-before-status', named.length > 0 && unread.length === 0, unread.length ? `asserted status for ${unread.join(', ')} without a \`cast read\` of it` : named.length ? `read ${named.join(', ')} before naming it` : `named none of ${sessions.join(', ')}, so their status went unreported`);
}

/** Each session it was asked by gets a `cast send <id>`; a message to anyone else, or to nobody, is not a reply. */
function repliesGate(writes: string[], sessions: string[]): GateResult {
  const sent = (s: string) => writes.some((w) => new RegExp(`^send\\s+["']?${s}\\b`).test(w));
  const unanswered = sessions.filter((s) => !sent(s));
  const elsewhere = writes.filter((w) => /^send\s+/.test(w) && !sessions.some((s) => new RegExp(`^send\\s+["']?${s}\\b`).test(w)));
  const pass = unanswered.length === 0;
  return gate('replies-sender', pass, unanswered.length ? `did not answer ${unanswered.join(', ')} with \`cast send\`${elsewhere.length ? `; sent instead to: ${elsewhere.map((w) => `cast ${w}`).join('; ')}` : ''}` : `answered ${sessions.join(', ')} with \`cast send\``);
}

/** A `cast decide` counts when it carries arguments: a bare verb is the command named in passing (as in pauseGate), never a choice put to anyone. */
function decisionGate(writes: string[]): GateResult {
  const raised = writes.filter((w) => /^decide\s+\S/.test(w));
  return gate('raises-decision', raised.length > 0, raised.length ? `raised: ${raised.map((w) => `cast ${w}`).join('; ')}` : 'named no `cast decide`, so the choice was never put to the people who own it');
}

/** The role's own check, tuned: `role tune` with a cadence, a gate or a focus. A trigger verb on its routine is the wrong door (it reads the person's whole roster). */
function tuneGate(writes: string[], want: NonNullable<StandingLabel['tune']>): GateResult {
  const tunes = writes.filter((w) => /^role\s+tune\b/.test(w));
  const wrongDoor = writes.filter((w) => /^trigger\s+(update|pause|cancel|rm|delete|add)\b\s*\S/.test(w));
  const named = (ws: string[]) => ws.map((w) => `cast ${w}`).join('; ');
  if (wrongDoor.length) return gate('wake-tune', false, `changed a trigger directly instead of its own check: ${named(wrongDoor)}`);
  if (want === 'none') return gate('wake-tune', tunes.length === 0, tunes.length ? `changed its wake though the pace of the work had not changed: ${named(tunes)}` : 'left its wake as it was');
  const everyMs = (w: string) => orgEveryToMs(/--every[\s=]+["']?(\d+[mhdw])\b/.exec(w)?.[1] ?? '');
  const slower = tunes.filter((w) => { const ms = everyMs(w); return (ms !== null && ms > DAY_MS && !wakeTuneRefusal(ms)) || /--precheck[\s=]+\S/.test(w); });
  const reasoned = slower.filter((w) => /--why[\s=]+\S/.test(w));
  return gate('wake-tune', reasoned.length > 0, reasoned.length ? `slowed its check: ${named(reasoned)}` : slower.length ? `slowed its check without a reason: ${named(slower)}` : tunes.length ? `tuned, but not slower within its bounds: ${named(tunes)}` : 'left a daily check running on an area with nothing to check');
}

/** A memory file: one under a `memory/` dir, or a CLAUDE.md, where a session's durable notes live. */
const MEMORY_FILE = /(?:^|\/)(?:memory\/[^/]+|CLAUDE\.md)$/;

/** The opening turn saved what the opening asked it to keep: a write the messages cannot show, read from the run's tool calls. */
function memoryGate(agents: AgentResult[]): GateResult {
  const saved = agents.flatMap((a) => a.wrote?.[0] ?? []).filter((p) => MEMORY_FILE.test(p));
  return gate('memory-save', saved.length > 0, saved.length ? `wrote ${saved.map((p) => p.split('/').slice(-2).join('/')).join(', ')}` : 'the opening turn wrote no memory file or CLAUDE.md');
}

/**
 * The gates a fixture's label asks for, over the run's turns from `from` on.
 * `extra` is text the turn wrote outside its messages (role-wake's brief.md),
 * which counts for what it named and asserted. `placeholderTurns` names the
 * run turn (1-based) each placeholder's wake arrived in.
 */
export function standingGates(agents: AgentResult[], label: StandingLabel | undefined, from = 1, extra: string[] = [], opts: { placeholderTurns?: Record<string, number> } = {}): GateResult[] {
  if (!label) return [];
  const writes = intendedWrites(agents, from, extra);
  const gates: GateResult[] = [];
  if (label.pause) gates.push(pauseGate(writes, label.pause));
  if (label.dmOnly) gates.push(dmGate(writes, label.dmOnly));
  if (label.placeholders) {
    const lastOf = (ph: string) => {
      const n = opts.placeholderTurns?.[ph];
      return n ? (agents.flatMap((a) => a.turns[n - 1] ?? []).at(-1) ?? '') : '';
    };
    gates.push(placeholderGate(writes, label.placeholders, lastOf));
  }
  if (label.raisesDecision) gates.push(decisionGate(writes));
  if (label.replies) gates.push(repliesGate(writes, label.replies));
  if (label.savesMemory) gates.push(memoryGate(agents));
  if (label.tune) gates.push(tuneGate(writes, label.tune));
  if (label.rereads) gates.push(rereadGate(readsMade(agents, from), [...agents.flatMap((a) => a.turns.slice(from - 1).flat()), ...extra].join('\n'), label.rereads));
  return gates;
}

/** The brief fits its budget (S38): a role reads it at every wake, so one that outgrew it is condensed before it is saved. */
export function budgetGate(brief: string): GateResult {
  const b = briefBudget(brief);
  return gate('brief-budget', !b.over, `the brief is ${briefBudgetWords(b)}`);
}

/** The playbook the saved brief holds, against what the fixture says the turn should have left in it. */
export function playbookGate(brief: string, want: PlaybookLabel): GateResult {
  const p = parsePlaybook(brief);
  const readings = p.metric?.readings ?? [];
  const missing: string[] = [];
  if (want.readingAfter && !readings.some((r) => (r.written_on ?? '') > want.readingAfter!)) missing.push(`no metric reading newer than ${want.readingAfter}`);
  if (want.rules && (p.rules.length < want.rules[0] || p.rules.length > want.rules[1])) missing.push(`${p.rules.length} rule(s), wanted ${want.rules[0]} to ${want.rules[1]}`);
  // Readable and parseable (S38): every entry carries its date, and a rule the mistake that taught it.
  const undated = [...p.rules, ...p.refuted, ...p.decisions, ...p.threads].filter((e) => !e.written_on);
  if (undated.length) missing.push(`${undated.length} entr${undated.length === 1 ? 'y carries' : 'ies carry'} no date (${undated[0]!.raw.slice(0, 60)})`);
  const untaught = p.rules.filter((r) => !r.mistake);
  if (untaught.length) missing.push(`${untaught.length} rule(s) without what taught it (${untaught[0]!.raw.slice(0, 60)})`);
  if (want.decisions && p.decisions.length < want.decisions) missing.push(`${p.decisions.length} standing decision(s), wanted at least ${want.decisions}`);
  const lost = (want.milestones ?? []).filter((day) => !readings.some((r) => r.written_on === day));
  if (lost.length) missing.push(`lost the milestone reading(s) of ${lost.join(', ')}`);
  if (want.shorterThan && brief.trim().length >= want.shorterThan) missing.push(`${brief.trim().length} characters, no shorter than the ${want.shorterThan} it started from`);
  return gate('playbook-kept', missing.length === 0, missing.length ? missing.join('; ') : `${readings.length} reading(s), ${p.rules.length} rule(s), ${p.refuted.length} refuted, ${p.decisions.length} decision(s), ${p.threads.length} thread(s)`);
}
