import { join } from 'node:path';

import { mapLimit } from '@codecast/shared/async';

import { cliFetchRead, cliSearchRequest } from '../../../cli/src/cliHttp';
import { parseJsonBlock } from '../../../convex/convex/lib/anthropic';
import { typedWords } from '../../../convex/convex/lib/userSend';
import { REDIRECT_WORDS } from '../../../shared/contracts/redirectWords';
import { renderGuidanceFile } from '../../../shared/contracts/snippets';
import { apiConfig, readConversation, toRows, type MessageRow } from '../adapters/convo';
import { runCall } from '../adapters/dryRun';
import { JUDGE_MODEL } from '../models';
import { homePaths } from '../paths';
import { correctionId, loadCorrections, saveCorrection, type Correction, type GuidanceDraft } from './store';

// A correction is a line a person typed to redirect an agent: stop, no, not
// like that, take that step yourself. This finds them in a window of sessions through
// the access-checked reads, keeps the ones about how an agent works (not about
// the thing it was building), and drafts for each a guidance case: a request
// that puts a fresh agent at the same choice, and the check a right answer
// passes. Everything here is real content, so it lives in EVALS_HOME, never git.

/** Words a person uses when an agent did the wrong kind of thing: cast-lessons' REDIRECT_WORDS, and the ones that complain about a habit. */
export const CORRECTION_QUERIES = [...REDIRECT_WORDS, 'why did you', 'why do you', 'I said', 'keep asking', 'asking me', 'yourself', 'waiting on me', 'just do'];

/** Relayed or framed lines that typedWords lets through: another session's brief, a role's relay, a delivery notice. */
const RELAYED = /^(From @|From jx|Your message to session|Reply to session|You (own|are)\b|# Task|\[Codecast Task|Done:|Monitor event)/;

/** Whether a user line is a person's own short line, which a correction is. */
export function isTypedLine(content: string): boolean {
  if (content.length > 1500 || RELAYED.test(content.trim())) return false;
  const words = typedWords(content);
  return words !== null && words > 0;
}

interface Hit {
  conversation: string;
  title: string;
  messageId: string;
  content: string;
  timestamp: string;
}

/** Every typed line in the window that holds a correction word: the person's own sessions, or the team's with `team`. */
export async function searchCandidates(o: { since: number; team?: boolean; onLine?: (l: string) => void }): Promise<Hit[]> {
  const { siteUrl, apiToken } = apiConfig();
  const hits = new Map<string, Hit>();
  for (const q of CORRECTION_QUERIES) {
    for (let page = 1; page <= 5; page++) {
      const r = await cliSearchRequest(siteUrl, { api_token: apiToken, query: `"${q}"`, limit: 50, page, start_time: o.since, user_only: true, mine_only: o.team ? undefined : true });
      if (r?.error) throw new Error(`cli/search: ${r.error}`);
      const convs = (r?.conversations ?? []) as Array<{ id: string; title?: string; matches?: Array<{ role: string; content: string; message_id: string; timestamp: string }> }>;
      for (const c of convs)
        for (const m of c.matches ?? [])
          if (m.role === 'user' && m.message_id && isTypedLine(m.content ?? '')) hits.set(m.message_id, { conversation: c.id, title: c.title ?? c.id, messageId: m.message_id, content: m.content, timestamp: m.timestamp });
      if (convs.length < 50) break;
    }
  }
  o.onLine?.(`${hits.size} typed lines hold a correction word`);
  return [...hits.values()];
}

/** One row as a reader of the excerpt sees it: text, and each tool call as `Tool: input`. */
export function rowText(r: Pick<MessageRow, 'role' | 'content' | 'tool_calls' | 'line'>, max = 600): string {
  const calls = (r.tool_calls ?? []).map((t) => {
    const input = (t.input ?? {}) as Record<string, unknown>;
    return `  [${t.name}] ${String(typeof input.command === 'string' ? input.command : JSON.stringify(input)).slice(0, 200)}`;
  });
  const text = (r.content ?? '').trim();
  return [`${r.line} ${r.role}: ${text.length > max ? `${text.slice(0, max)}…` : text}`, ...calls].join('\n');
}

/** The rows around a line: `before` rows up to it and `after` past it, tool results left out. */
export async function excerpt(conversation: string, line: number, before: number, after: number): Promise<{ rows: MessageRow[]; title: string }> {
  const read = await readConversation(conversation, { from: Math.max(1, line - before), to: line + after });
  const rows = toRows(read.messages).filter((r) => !(r.role === 'user' && r.tool_results?.length && !r.content?.trim()));
  return { rows, title: read.conversation.title ?? conversation };
}

/** Where a message sits: its session's full id and its line. A short id two sessions share is read as whichever /cli/read picks, so a miss there is null. */
export async function locate(conversation: string, messageId: string): Promise<{ conversation: string; line: number } | null> {
  const { siteUrl, apiToken } = apiConfig();
  const r = await cliFetchRead(`${siteUrl}/cli/read`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_token: apiToken, conversation_id: conversation, around_message_id: messageId, context: 0 }) });
  const body = (await r.json()) as { error?: string; target_line?: number; target_missing?: boolean; conversation?: { id?: string } };
  if (body.error || !body.target_line || body.target_missing) return null;
  return { conversation: body.conversation?.id ?? conversation, line: body.target_line };
}

/**
 * Whether this conversation's text may go to Anthropic, by the server's vendor
 * guard (/cli/read with vendor: anthropic): null when it may, else the reason
 * it may not. A server that does not answer the question refuses, so nothing
 * leaves for a model on a guess.
 */
const vendorChecked = new Map<string, Promise<string | null>>();
export function anthropicRefusal(conversation: string): Promise<string | null> {
  let hit = vendorChecked.get(conversation);
  if (!hit) {
    hit = (async () => {
      const { siteUrl, apiToken } = apiConfig();
      const r = await cliFetchRead(`${siteUrl}/cli/read`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_token: apiToken, conversation_id: conversation, start_line: 1, end_line: 1, vendor: 'anthropic' }) });
      const body = (await r.json()) as { error?: string; vendor_refusal?: string | null };
      if (body.error) return `the read was refused: ${body.error}`;
      if (!('vendor_refusal' in body)) return 'this server does not say whether the conversation may go to a model vendor (/cli/read vendor_refusal)';
      return body.vendor_refusal ?? null;
    })().catch((e) => `the vendor check failed: ${(e as Error).message}`);
    vendorChecked.set(conversation, hit);
  }
  return hit;
}

const scratch = (name: string): string => join(homePaths().scratch, 'corrections', `${name}-${Date.now()}`);

async function ask(prompt: string, name: string, maxTokens: number): Promise<unknown> {
  const r = await runCall({ model: JUDGE_MODEL, max_tokens: maxTokens, prompt }, scratch(name), { dry: false });
  if (r.isError) throw new Error(`${name} call failed: ${r.harnessFailure ?? r.text.slice(0, 200)}`);
  return parseJsonBlock(r.text);
}

export const TRIAGE_PROMPT = `You sort lines people typed to AI coding agents. Each item below is one line a person typed, with what the agent said or did just before it.

The goal is to find the lines that correct how the agent works, so each can become a test the agent's standing instructions must pass. A line corrects how the agent works when the person is redirecting a habit of the agent that would be wrong in any project: asking the person to do something the agent could do itself, waiting on the person when it could proceed, using the wrong tool or channel, not verifying, going off without saying so, asking for a permission it already had, interrupting the person with something they did not need. The same habit described by the person about another session counts too ("the agent in the other thread wants me to click through the setup again").

Not a correction of how the agent works:
- a correction of the work itself: a wrong fix, a design the person dislikes, a bug in what was built, a product decision;
- a plain instruction or a "don't" that sets the scope of a new task, with nothing the agent did wrong before it;
- a line that is not addressed to an agent's behavior at all.

Items:
{ITEMS}

Answer with one JSON object and nothing else: {"behavior": [{"i": <item number>, "habit": "<the agent's habit the person corrected, one short line>"}]}. List only the items that correct how the agent works; an empty list is a fine answer.`;

/** Which candidates correct how an agent works, in batches; the rest are recorded as not-behavior so a rerun skips them. */
export async function triage(all: Correction[], onLine?: (l: string) => void): Promise<void> {
  const cands: Correction[] = [];
  for (const c of all) {
    const refused = await anthropicRefusal(c.conversation);
    if (!refused) cands.push(c);
    else saveCorrection(Object.assign(c, { status: 'withheld', why: `vendor guard: ${refused}` }));
  }
  if (cands.length < all.length) onLine?.(`${all.length - cands.length} withheld by the vendor guard: their conversations may not go to a model`);
  let behavior = 0;
  for (let i = 0; i < cands.length; i += 20) {
    const batch = cands.slice(i, i + 20);
    const items = batch.map((c, k) => `<item n="${k + 1}">\n<before>\n${c.before}\n</before>\n<typed>\n${c.said}\n</typed>\n</item>`).join('\n');
    const parsed = (await ask(TRIAGE_PROMPT.replace('{ITEMS}', items), 'triage', 2000)) as { behavior?: Array<{ i: number; habit: string }> } | null;
    if (!parsed) throw new Error('triage returned no JSON');
    const kept = new Map((parsed.behavior ?? []).map((b) => [b.i, b.habit]));
    batch.forEach((c, k) => {
      const habit = kept.get(k + 1);
      c.status = habit ? 'candidate' : 'not-behavior';
      c.habit = habit;
      c.why = habit ?? 'triage: about the work, or no correction';
      saveCorrection(c);
    });
    behavior += kept.size;
    onLine?.(`triaged ${Math.min(i + 20, cands.length)}/${cands.length}: ${behavior} correct how an agent works`);
  }
}

export const DRAFT_PROMPT = `A person corrected an AI coding agent. Your job is to turn that correction into a test of the agent's standing instructions, so a rewrite of those instructions can be measured against it.

The standing instructions are the codecast guidance below: the sections codecast installs into every agent's global CLAUDE.md. They govern how an agent works with codecast and with the person: how it asks for a decision, delegates, schedules, messages, verifies, publishes and uses the person's browser, and which of codecast's tools it reaches for instead of a native one.

<guidance>
{GUIDANCE}
</guidance>

The session where the correction happened (title: {TITLE}). Lines are numbered; the correction is line {LINE}, and a few lines after it show what the agent did next.

<session>
{EXCERPT}
</session>

The habit the person corrected, as a first read put it: {HABIT}

First decide whether this guidance is where the right behavior belongs. It is when the habit concerns how the agent works with codecast or with the person, and a sentence in guidance like the above would change what any agent does in that situation. It is not when the habit is specific to one codebase or task, or is about the quality of the work itself.

If it belongs, write the test:
- request: the message a person would type to a fresh agent that has no history, which puts it at the same choice point where this agent went wrong. The agent starts in an empty directory on the person's machine, in a rehearsal where codecast commands are recorded rather than executed, and is told to take the first step it would take for real and then stop. So the request must stand alone: set it at a made-up company with made-up names, put any content the task needs (a draft, a list, an error) in the request itself rather than in a file, and keep the situation that made the choice matter. Leave out real names, ids and anything the correction says, so the request neither hints at the answer nor gives the agent a real system or credential to reach for.
- want and avoid: JavaScript regular expressions, matched case-insensitively against each tool call the agent makes, written as "Tool: input". A shell call is "Bash: <command>" and often chains several commands, so a pattern for a command matches it anywhere in the call (for example \\bcast\\s+decide\\b.*--run), and a native tool is anchored by its name (for example ^AskUserQuestion:). The first call that matches either list decides the test, so every pattern, in either list, names the act itself (the command that does the step, with the subcommand that does it), never a read that only explores: an agent reading --help, a cast guide or a list first is finding its way, and a pattern that matches that read decides the test on something the agent did not do. Give patterns only when the right behavior is a choice of action, keep them tight enough that an unrelated read does not match, and leave both lists empty when the behavior shows in what the agent says rather than what it runs.
- criteria: one sentence stating the behavior a correct reply shows, in terms a grader who reads only the request, the agent's actions and its reply can check. Most commands are refused in the rehearsal, so judge what the agent attempts and what it says it will do, never whether it finished.
- rule: the general rule the agent should have followed, one sentence, as it would read in the guidance.
- title: what the test checks, under 45 characters, for a list of tests (for example "Signs in from the Vault itself").

Answer with one JSON object and nothing else:
{"belongs": true|false, "why": "<one line>", "title": "...", "rule": "...", "request": "...", "want": [], "avoid": [], "criteria": "..."}
When belongs is false, give only belongs and why.`;

export async function draft(c: Correction, habit: string): Promise<void> {
  const refused = await anthropicRefusal(c.conversation);
  if (refused) {
    Object.assign(c, { status: 'withheld', why: `vendor guard: ${refused}`, draft: undefined });
    saveCorrection(c);
    return;
  }
  const { rows, title } = await excerpt(c.conversation, c.line, 12, 3);
  c.said = rows.find((r) => r.line === c.line)?.content.trim() ?? c.said;
  const prompt = DRAFT_PROMPT.replace('{GUIDANCE}', renderGuidanceFile('full', 'eval'))
    .replace('{TITLE}', title)
    .replace('{LINE}', String(c.line))
    .replace('{EXCERPT}', rows.map((r) => rowText(r, r.line === c.line ? 3000 : 900)).join('\n\n'))
    .replace('{HABIT}', habit);
  const d = (await ask(prompt, 'draft', 3000)) as (Partial<GuidanceDraft> & { belongs?: boolean; why?: string }) | null;
  if (!d) throw new Error(`draft for ${c.id} returned no JSON`);
  if (!d.belongs) {
    c.status = 'not-guidance';
    c.why = d.why ?? 'the guidance is not where this belongs';
    c.draft = undefined;
  } else {
    const patterns = (xs: unknown) => (Array.isArray(xs) ? xs.map((p) => shellAnywhere(String(p))).filter((p) => compiles(p)) : []);
    c.status = 'drafted';
    c.why = d.why;
    c.draft = { title: String(d.title ?? d.rule ?? '').slice(0, 60), rule: String(d.rule ?? ''), request: String(d.request ?? ''), want: patterns(d.want), avoid: patterns(d.avoid), criteria: String(d.criteria ?? '') };
  }
  saveCorrection(c);
}

/** A shell pattern written as "Bash: cast x" matches only a call that starts with it; agents chain commands, so it matches the command anywhere in a shell call. */
export const shellAnywhere = (p: string): string => p.replace(/^\^?Bash:\s*(?:\.\*\s*)?(?!\.)/, 'Bash:.*');

const compiles = (p: string): boolean => {
  try {
    new RegExp(p, 'i');
    return true;
  } catch {
    return false;
  }
};

/**
 * Finds the corrections in a window and drafts a guidance case for each one
 * that belongs there. A line already on file keeps its status, so a rerun
 * over an overlapping window only reads what is new.
 */
export async function findCorrections(o: { since: number; team?: boolean; limit?: number; onLine?: (l: string) => void }): Promise<Correction[]> {
  const known = new Set(loadCorrections().map((c) => c.messageId));
  const hits = (await searchCandidates(o)).filter((h) => !known.has(h.messageId)).slice(0, o.limit ?? 400);
  const read = await mapLimit(hits, 6, async (h): Promise<Correction | null> => {
    const at = await locate(h.conversation, h.messageId).catch(() => null);
    if (!at) return null;
    const { conversation, line } = at;
    const { rows } = await excerpt(conversation, line, 3, 0).catch(() => ({ rows: [] as MessageRow[] }));
    const typed = rows.find((r) => r.line === line);
    const before = rows.filter((r) => r.line < line && r.role === 'assistant').slice(-2);
    const c: Correction = { id: correctionId(conversation, line), conversation, line, messageId: h.messageId, at: h.timestamp, title: h.title, said: (typed?.content ?? h.content).trim(), before: before.map((r) => rowText(r, 500)).join('\n'), status: 'candidate' };
    // A line set aside here is still recorded, so a rerun over the same window does not read it again.
    if (!typed || !isTypedLine(typed.content)) Object.assign(c, { status: 'not-behavior', why: 'relayed or delivered by a program, not typed by a person' });
    else if (!before.length) Object.assign(c, { status: 'not-behavior', why: 'answers no agent turn' });
    saveCorrection(c);
    return c.status === 'candidate' ? c : null;
  });
  const fresh = read.filter((c): c is Correction => Boolean(c));
  o.onLine?.(`${fresh.length} new lines answer an agent's turn`);
  await triage(fresh, o.onLine);
  const toDraft = loadCorrections().filter((c) => c.status === 'candidate');
  await mapLimit(toDraft, 4, async (c) => {
    await draft(c, c.habit ?? c.why ?? '').catch((e) => o.onLine?.(`draft ${c.id} failed: ${(e as Error).message}`));
    o.onLine?.(`drafted ${c.id}: ${c.status}`);
  });
  return loadCorrections();
}
