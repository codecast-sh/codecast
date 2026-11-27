#!/usr/bin/env bun
// The authoritative side of Study 2 (ct-102390): for each snapshot time T, the
// priority set an expert reader states from everything that had happened by T,
// in the golden set's shape (Golden in priorities-measure.ts).
//
//   1. universe     the sessions the pass reads over the window (priorityPassInputs:passInputs, read-only)
//   2. transcripts  `cast read <id> 1:100000 --json`, cached raw
//   3. digests      per session, a digest carried forward through segments cut at each T; no step sees past its cut
//   4. synth        one call per T over every session's digest as of T
//   5. validate     the last snapshot scored against the hand-made golden set (score + modelJudge)
//
//   cast vault run --env-file <(echo CODECAST_EVALS_ANTHROPIC_KEY=vault://anthropic-api-key) -- \
//     bun packages/evals/scripts/priorities-snapshots.ts --stage all|universe|transcripts|digests|synth|validate \
//       [--limit N | --only id,id] [--out ~/.codecast/ct-102390]
//
// Everything it writes holds the person's real content: it goes under --out, never in the repo.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { modelCost, parseJsonBlock, postMessages, replyText } from '../../convex/convex/lib/anthropic';
import { evalsApiKey } from '../src/adapters/apiCall';
import { castTaskStatus, convexRun, modelJudge, replayScope, score, type Golden, type GoldenPriority, type Produced } from './priorities-measure';

const MODEL = 'claude-opus-5-5';
const USER = 'jasoncbenn@gmail.com';
const GOLDEN_PATH = join(homedir(), '.codecast/emergent-goals/golden/jason.json');
const WINDOW_START = Date.parse('2026-11-10T00:00:00Z');
const ALL_CUTS = [
  { name: 'T1', at: Date.parse('2026-11-14T00:00:00Z') },
  { name: 'T2', at: Date.parse('2026-11-18T00:00:00Z') },
  { name: 'T3', at: Date.parse('2026-11-21T00:00:00Z') },
  { name: 'T4', at: Date.parse('2026-11-25T00:00:00Z') },
  // Held out: past the hand set, on the forward replay's 90-minute grid.
  { name: 'T5', at: Date.parse('2026-11-27T22:30:00Z') },
];
/** Rendered characters one digest step reads at most; a longer segment is read in sub-chunks. */
const CHUNK_CHARS = 120_000;
const CONCURRENCY = 6;
/** Digesting is careful summary, not hard reasoning: low effort keeps its thinking (billed as output) small. */
const DIGEST_EFFORT = 'low' as const;

const argv = process.argv;
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i > 0 ? argv[i + 1] : undefined; };
const OUT = (flag('out') ?? join(homedir(), '.codecast/ct-102390')).replace(/^~/, homedir());
/**
 * v1 lets a session go unlabeled; v2 accounts for every session the synthesis sees: under a priority
 * (with the milestone it serves), standing, or one_off with a reason. Same granularity rules in both.
 */
const VARIANT = (flag('variant') ?? 'v1') as 'v1' | 'v2';
/** Fail on a digest step that is not cached, rather than pay for it (a synthesis-only rerun). */
const CACHED_ONLY = argv.includes('--cached-only');
/** New spend one run may make before it stops (cached steps cost nothing). */
const BUDGET_USD = Number(flag('budget') ?? 30);
/**
 * The study runs through T4 (validated against the hand set). `--through T5` extends the universe and the
 * digests to T5 and synthesizes T5 alone, reusing every cached digest; its files carry a -T5 suffix.
 */
const THROUGH = flag('through') ?? 'T4';
const CUTS = ALL_CUTS.slice(0, ALL_CUTS.findIndex((c) => c.name === THROUGH) + 1);
if (!CUTS.length) throw new Error(`--through ${THROUGH}: no such cut`);
const LAST = CUTS[CUTS.length - 1]!.at;
const SUFFIX = THROUGH === 'T4' ? '' : `-${THROUGH}`;
const dir = (...p: string[]) => { const d = join(OUT, ...p); mkdirSync(d, { recursive: true }); return d; };
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 2));
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const iso = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ') + 'Z';

// ---------------------------------------------------------------- spend

const spent = { usd: 0, calls: 0, input_tokens: 0, output_tokens: 0 };
function logCost(label: string, usage: { input_tokens: number; output_tokens: number }) {
  const usd = modelCost(MODEL, usage);
  spent.usd += usd;
  spent.calls++;
  spent.input_tokens += usage.input_tokens;
  spent.output_tokens += usage.output_tokens;
  console.error(`  $${usd.toFixed(3)} ${label} (in ${usage.input_tokens}, out ${usage.output_tokens}; total $${spent.usd.toFixed(2)})`);
  return usd;
}

async function ask(label: string, system: string, prompt: string, max_tokens: number, output_schema?: Record<string, unknown>, effort?: 'low' | 'medium' | 'high'): Promise<{ text: string; usd: number }> {
  const apiKey = evalsApiKey();
  if (!apiKey) throw new Error('no evals key: set CODECAST_EVALS_ANTHROPIC_KEY');
  if (spent.usd >= BUDGET_USD) throw new Error(`${label}: this run has spent $${spent.usd.toFixed(2)}, at its --budget of $${BUDGET_USD}`);
  for (let attempt = 0; ; attempt++) {
    const res = await postMessages({ model: MODEL, max_tokens, system, prompt, ...(output_schema ? { output_schema } : {}), ...(effort ? { effort } : {}) }, { apiKey }).catch((e) => { console.error(`  ${label}: ${e}`); return null; });
    if (res?.ok) {
      const body = await res.json();
      const usd = logCost(label, body.usage);
      if (body.stop_reason === 'max_tokens') throw new Error(`${label}: reply hit max_tokens`);
      return { text: replyText(body), usd };
    }
    const status = res?.status ?? 0;
    const detail = res ? (await res.text()).slice(0, 300) : 'no response';
    if (attempt >= 5 || (status >= 400 && status < 500 && status !== 429)) throw new Error(`${label}: ${status} ${detail}`);
    await Bun.sleep(2 ** attempt * 5_000);
  }
}

async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]!, i); }
  }));
  return out;
}

// ---------------------------------------------------------------- 1. universe

type UniSession = { id: string; conversation_id: string; title: string; workspace: 'union' | 'codecast' | 'personal'; kind: string; parent?: string; typed: Array<{ at: number; text: string }> };

function universe(): UniSession[] {
  const path = join(OUT, `universe${SUFFIX}.json`);
  if (existsSync(path)) return readJson(path);
  const sessions = readUniverse(join(OUT, `universe${SUFFIX}${SUFFIX ? '.raw' : ''}.json`));
  if (!SUFFIX) return sessions;
  // A later cut keeps the study's definition: sessions he typed in by then (passInputs now also returns
  // workers he never typed in). A session the study read keeps its title and kind, so its digests are reused.
  const study = new Map(readJson<UniSession[]>(join(OUT, 'universe.json')).map((s) => [s.id, s]));
  const kept = sessions.filter((s) => s.typed.some((t) => t.at <= LAST)).map((s) => (study.has(s.id) ? { ...study.get(s.id)!, typed: s.typed } : s));
  console.error(`universe ${THROUGH}: ${kept.length} of ${sessions.length} passInputs sessions have a message he typed by ${iso(LAST)}`);
  writeJson(path, kept);
  return kept;
}

function readUniverse(path: string): UniSession[] {
  if (existsSync(path)) return readJson(path);
  const golden: Golden = readJson(GOLDEN_PATH);
  const { user_id, workspaces } = replayScope(golden, (name, fallback) => {
    const v = name === 'user' ? USER : name === 'from' ? '2026-11-10' : name === 'to' ? '2026-11-24' : fallback;
    if (v === undefined) throw new Error(`--${name} is required`);
    return v;
  });
  const now = LAST + 5 * 60_000;
  const byId = new Map<string, UniSession>();
  for (const w of workspaces) {
    const ws = w.workspace === `user:${user_id}` ? 'personal' : (w.name.toLowerCase() as UniSession['workspace']);
    let cursor = WINDOW_START;
    for (;;) {
      const read = convexRun<{ input: { sessions: Array<{ id: string; title: string; kind: string; parent?: string; typed: Array<{ at: number; text: string }> }> }; conversations: Record<string, string>; more: boolean; read_to: number }>(
        'priorityPassInputs:passInputs', { user_id, workspace: w.workspace, now, window_start: cursor });
      for (const s of read.input.sessions) {
        const had = byId.get(s.id);
        if (had) { for (const t of s.typed) if (!had.typed.some((x) => x.at === t.at)) had.typed.push(t); continue; }
        byId.set(s.id, { id: s.id, conversation_id: read.conversations[s.id] ?? s.id, title: s.title, workspace: ws, kind: s.kind, ...(s.parent ? { parent: s.parent } : {}), typed: [...s.typed] });
      }
      console.error(`${w.name}: read to ${iso(read.read_to)}, ${byId.size} sessions so far`);
      if (!read.more || read.read_to <= cursor) break;
      cursor = read.read_to;
    }
  }
  const sessions = [...byId.values()];
  for (const s of sessions) s.typed.sort((a, b) => a.at - b.at);
  writeJson(path, sessions);
  return sessions;
}

// ---------------------------------------------------------------- 2. transcripts

type RawMessage = { role: string; content?: string; timestamp?: string; tool_calls?: unknown; tool_results?: unknown; line?: string };

function transcriptPath(s: UniSession) { return join(dir('transcripts'), `${s.conversation_id}.json`); }

/** One read of a line range, retried with backoff while the backend times out. */
async function castRead(s: UniSession, range: string): Promise<{ conversation?: { message_count?: number }; messages: RawMessage[] } | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const p = Bun.spawn(['cast', 'read', s.conversation_id, range, '--json'], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
    if ((await p.exited) === 0) {
      try {
        const d = JSON.parse(out.slice(out.indexOf('{')));
        if (Array.isArray(d.messages)) return d;
      } catch { /* retry */ }
    }
    // A page past the last line: the session ended in the page before.
    if (/is past the/.test(out + err)) return { messages: [] };
    console.error(`  cast read ${s.id} ${range} failed (attempt ${attempt + 1}): ${err.trim().slice(0, 200)}`);
    await Bun.sleep(2 ** attempt * 3_000);
  }
  return null;
}

/** The server reads at most 8192 lines at once: a longer session is read in pages. */
const PAGE = 8_000;

/** Cached transcripts fetched before the last cut whose newer lines could not be read: they stop where the cache does. */
const staleTranscripts: string[] = [];

async function fetchTranscript(s: UniSession): Promise<RawMessage[] | null> {
  const path = transcriptPath(s);
  if (existsSync(path)) {
    const cached = readJson<{ conversation?: unknown; messages: RawMessage[]; fetched_at?: number }>(path);
    if ((cached.fetched_at ?? statSync(path).mtimeMs) >= LAST) return cached.messages;
    // Fetched before the last cut: lines only append, so read the ones added since.
    const messages = [...cached.messages];
    for (let from = Number(messages.at(-1)?.line ?? messages.length) + 1; ; from += PAGE) {
      const page = await castRead(s, `${from}:${from + PAGE - 1}`);
      if (!page) { staleTranscripts.push(s.id); return cached.messages; }
      messages.push(...page.messages);
      if (page.messages.length < PAGE) break;
    }
    writeFileSync(path, JSON.stringify({ conversation: cached.conversation, messages, fetched_at: Date.now() }));
    return messages;
  }
  // One the backend would not serve last time is not asked again (delete the marker to retry).
  const unreadable = `${path}.unreadable`;
  if (existsSync(unreadable)) return null;
  const giveUp = () => { writeFileSync(unreadable, ''); return null; };
  const first = await castRead(s, `1:${PAGE}`);
  if (!first) return giveUp();
  const messages = [...first.messages];
  const total = first.conversation?.message_count ?? 0;
  for (let from = PAGE + 1; from <= total; from += PAGE) {
    const page = await castRead(s, `${from}:${from + PAGE - 1}`);
    if (!page) return giveUp();
    messages.push(...page.messages);
    if (page.messages.length < PAGE) break;
  }
  writeFileSync(path, JSON.stringify({ conversation: first.conversation, messages, fetched_at: Date.now() }));
  return messages;
}

// ---------------------------------------------------------------- rendering

const WRAPPERS = /^\s*(<session-message|<task-notification|<system-reminder|<scheduled-task|<command-|\[Codecast import\]|<local-command|<user-message|<trigger|<workflow|<tool_result|<bash-|Caveat:|<cast-|<task-comment|<artifact-content|<agent-message|<chat-mention|\[codecast\]|This session is being continued|Base directory for this skill|Your agent process exited)/;
/** A message another session sent this one: its gist matters, its bulk does not. */
const RELAY = /^\s*Another Claude session sent you a message/;
const norm = (t: string) => t.replace(/\s+/g, ' ').trim().slice(0, 160);

type Line = { at: number; text: string };
type Rendered = { lines: Line[]; anomalies: string[]; typed_matched: number; typed_total: number };

/** The transcript as lines a reader needs: Jason's typed words verbatim, other user-role text marked, assistant prose capped, tools dropped. */
function render(s: UniSession, messages: RawMessage[]): Rendered {
  // He sends the same words more than once ("status?"): pair each message with the nearest send of its text.
  const sendsOf = new Map<string, number[]>();
  for (const t of s.typed) sendsOf.set(norm(t.text), [...(sendsOf.get(norm(t.text)) ?? []), t.at]);
  const typedByText = { has: (k: string) => sendsOf.has(k) };
  const nearestSend = (k: string, at: number) => sendsOf.get(k)?.reduce((a, b) => (Math.abs(b - at) < Math.abs(a - at) ? b : a));
  const lines: Line[] = [];
  const anomalies: string[] = [];
  let matched = 0, prev = 0, backwards = 0;
  const stamps: number[] = [];
  for (const m of messages) {
    const at = m.timestamp ? Date.parse(m.timestamp) : NaN;
    if (!Number.isFinite(at)) continue;
    stamps.push(at);
    if (at < prev - 1000) backwards++;
    prev = Math.max(prev, at);
    const content = (m.content ?? '').trim();
    if (!content) continue;
    if (m.role === 'user') {
      if (WRAPPERS.test(content)) continue;
      // His answer to a decision card: the answer, then the card's question.
      const decision = content.match(/^Decision: ([\s\S]*?)\n?<cast-decision[^>]*question="([^"]*)"/);
      if (decision) {
        if (typedByText.has(norm(decision[1]!))) matched++;
        lines.push({ at, text: `[${iso(at)}] JASON DECIDED: ${decision[1]!.trim()} (asked: ${cap(decision[2]!, 400, 100)})` });
        continue;
      }
      if (RELAY.test(content)) { lines.push({ at, text: `[${iso(at)}] MESSAGE FROM ANOTHER SESSION: ${cap(content.replace(RELAY, ''), 500, 200)}` }); continue; }
      const typedAt = nearestSend(norm(content), at);
      if (typedAt !== undefined) {
        matched++;
        // The typed log starts at the window: a message before it can only match a later send of the same words.
        if (at >= WINDOW_START && Math.abs(typedAt - at) > 10 * 60_000) anomalies.push(`typed message stamped ${iso(at)} in the transcript but sent ${iso(typedAt)}`);
        lines.push({ at, text: `[${iso(at)}] JASON TYPED: ${content}` });
      } else {
        // Not in his typed log: a brief another agent wrote, a relay, or his own words sent another way.
        lines.push({ at, text: `[${iso(at)}] USER-ROLE TEXT: ${cap(content, 1500, 500)}` });
      }
    } else if (m.role === 'assistant') {
      lines.push({ at, text: `[${iso(at)}] AGENT: ${cap(content, 500, 300)}` });
    }
  }
  if (backwards) anomalies.push(`${backwards} message(s) stamped earlier than the one before`);
  // An import stamps many messages with the same instant.
  const sameSecond = new Map<number, number>();
  for (const t of stamps) sameSecond.set(Math.floor(t / 1000), (sameSecond.get(Math.floor(t / 1000)) ?? 0) + 1);
  const burst = Math.max(0, ...sameSecond.values());
  if (burst >= 20) anomalies.push(`${burst} messages share one second (${iso([...sameSecond.entries()].find(([, n]) => n === burst)![0] * 1000)}): an import stamp?`);
  if (stamps.length && s.typed.length && Math.min(...stamps) > s.typed[0]!.at + 60_000) anomalies.push(`first message ${iso(Math.min(...stamps))} is after the first typed send ${iso(s.typed[0]!.at)}`);
  return { lines, anomalies, typed_matched: matched, typed_total: s.typed.filter((t) => t.at <= LAST).length };
}

function cap(t: string, head: number, tail: number) {
  return t.length <= head + tail + 20 ? t : `${t.slice(0, head)} […${t.length - head - tail} chars…] ${t.slice(-tail)}`;
}

// ---------------------------------------------------------------- 3. digests

const DIGEST_SYSTEM = `You keep a running digest of one of Jason Benn's agent sessions. Jason is a founder at Union (Head of Agentic Quality; Union's product is an AI broker, "outreach", with an eval suite and a Constitution) and builds Codecast (a tool for running fleets of coding-agent sessions). He also runs personal infrastructure (a home server called nose, an M2 Mac, his laptop) and personal projects.

You get the digest as it stood at the end of the previous stretch (or none) and the session's next stretch of messages. Lines marked JASON TYPED are his own words, JASON DECIDED his answer to a question an agent put to him. USER-ROLE TEXT is not in his typed log: usually a brief another agent wrote (a session's opening task), sometimes his own words sent another way; judge from the text. MESSAGE FROM ANOTHER SESSION is a report or request relayed from a different session. AGENT lines are the agent's prose, trimmed.

Write the digest as of the end of this stretch, replacing the old one. It must hold, in under 250 words (a long session keeps only its most decisive facts):
- What Jason is driving at in this session, in his own words where he gave them (quote short phrases), and the larger goal it serves if the session says so.
- What got done, with evidence ids (ct-N tasks, pl-N plans, PR numbers, commits, deploys), and what is only claimed.
- Decisions Jason made or accepted.
- Where it stands at the end of this stretch, and what is open.
- Whether this is a standing role or lead seat (an ongoing role session: a lead, inbox, triage, chief-of-staff seat) rather than work toward one outcome.
Write only what the messages show. Never guess at what happens later.

Begin the reply with the digest itself, no preamble.`;

type DigestStep = { seg: string; chunk: number; until: number; messages: number; chars: number; digest: string; usd: number };
type SessionDigests = { id: string; steps: DigestStep[]; asOf: Record<string, string | null>; usd: number };

/** Messages by segment: before the window, then each (cut_{k-1}, cut_k]. Nothing after the last cut. */
function segments(lines: Line[]) {
  const bounds = [{ name: 'pre', from: -Infinity, to: WINDOW_START }, ...CUTS.map((c, i) => ({ name: c.name, from: i ? CUTS[i - 1]!.at : WINDOW_START, to: c.at }))];
  return bounds.map((b) => ({ name: b.name, to: b.to, lines: lines.filter((l) => l.at > b.from && l.at <= b.to) }));
}

function chunks(lines: Line[]): Line[][] {
  const out: Line[][] = [];
  let cur: Line[] = [], n = 0;
  for (const l of lines) {
    const len = l.text.length + 1;
    if (cur.length && n + len > CHUNK_CHARS) { out.push(cur); cur = []; n = 0; }
    cur.push(l); n += len;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** A long pre-window history is read only over its last stretch: the digest keeps what it needs from it. */
const PRE_WINDOW_CHARS = 2 * CHUNK_CHARS;

async function digestSession(s: UniSession, rendered: Rendered): Promise<SessionDigests> {
  const cacheDir = dir('digests', s.id);
  const result: SessionDigests = { id: s.id, steps: [], asOf: {}, usd: 0 };
  let digest: string | null = null;
  for (const seg of segments(rendered.lines)) {
    let lines = seg.lines;
    if (seg.name === 'pre') {
      let n = 0, i = lines.length;
      while (i > 0 && n + lines[i - 1]!.text.length <= PRE_WINDOW_CHARS) n += lines[--i]!.text.length + 1;
      lines = lines.slice(i);
    }
    const parts = chunks(lines);
    for (let c = 0; c < parts.length; c++) {
      const body = parts[c]!.map((l) => l.text).join('\n');
      const until = seg.to;
      const prompt = `Session ${s.id} · workspace ${s.workspace} · "${s.title}"${s.kind !== 'session' ? ` · ${s.kind}${s.parent ? ` of ${s.parent}` : ''}` : ''}\n\n# Digest so far\n${digest ?? '(none: this is the start of the session)'}\n\n# Next stretch (${seg.name === 'pre' ? `before ${iso(WINDOW_START)}` : `up to ${iso(until)}`}${parts.length > 1 ? `, part ${c + 1} of ${parts.length}` : ''})\n${body}`;
      const key = sha(DIGEST_SYSTEM + MODEL + DIGEST_EFFORT + prompt);
      const cached = join(cacheDir, `${key}.json`);
      let step: DigestStep;
      if (existsSync(cached)) step = readJson(cached);
      else if (CACHED_ONLY) throw new Error(`--cached-only: digest ${s.id} ${seg.name}.${c} is not cached`);
      else {
        const r = await ask(`digest ${s.id} ${seg.name}.${c}`, DIGEST_SYSTEM, prompt, 4_000, undefined, DIGEST_EFFORT);
        step = { seg: seg.name, chunk: c, until, messages: parts[c]!.length, chars: body.length, digest: r.text.trim(), usd: r.usd };
        writeJson(cached, step);
        result.usd += r.usd;
      }
      result.steps.push(step);
      digest = step.digest;
    }
    if (seg.name !== 'pre') result.asOf[seg.name] = digest;
  }
  writeJson(join(dir('digests'), `${s.id}.json`), result);
  return result;
}

// ---------------------------------------------------------------- 4. synthesis

const V1_SESSION_RULES = `- sessions: the session ids whose work serves it. Each session serves at most one priority.
Standing roles and lead seats (a lead, inbox, triage, chief-of-staff or other ongoing role session) are never priorities: list them in standing_sessions. A session that serves no priority and is not standing (a one-off chore, a question) gets no label.
session_labels: one entry per session placed under a priority.`;

const V2_SESSION_RULES = `- sessions: each session whose work serves it, with the milestone its work serves (the exact title of one of this priority's critical milestones, or null when its work serves the goal off the critical path). Each session serves at most one priority.
Standing roles and lead seats (a lead, inbox, triage, chief-of-staff or other ongoing role session) are never priorities: list them in standing_sessions.
Account for every session you are given, leaving none out: each one is under exactly one priority, in standing_sessions, or in one_off_sessions. A one-off session serves no goal of his (a one-off chore, a question, a side errand); give a few words why. Do not invent or widen a goal to give a session a home: a session that serves no goal is one_off.`;

const SYNTH_SYSTEM = (cut: string) => `You are an expert reader stating Jason Benn's priorities as they stood at ${cut}, from digests of every agent session he worked in from Nov 10, 2026 up to that moment. Jason is a Union founder (Head of Agentic Quality; Union's product is an AI broker, "outreach") and builds Codecast; he also runs personal infrastructure and projects. He never wrote these goals down: you infer them.

AS OF ${cut}. Each digest describes its session only up to ${cut}. A goal that is not yet visible by then does not exist yet; leave it out. A milestone done after ${cut} is not done. Never use knowledge of what came later.

A priority is a month-long goal (a day to a month of work) he is driving at, stated in his own terms (use his words where the digests quote them). For each:
- title: the outcome in his terms; short: at most 3 words.
- workspace: union, codecast or personal. A priority never spans workspaces: work toward one outcome in two workspaces is two priorities.
- status: active (being worked on or still wanted at ${cut}), done (its outcome reached by ${cut}, with evidence), or set_aside_or_quiet (started, then dropped or gone quiet).
- critical: the 3 to 6 core milestones on the 80/20 critical path to the goal being done in his sense, each at most 6 words. Leave polish and follow-ups out. done is true only when the digests show evidence by ${cut} (a merge, a deploy, a live check, his word), not an agent's bare claim. task: the ct-N (or pl-N) that carries it, or null.
${VARIANT === 'v2' ? V2_SESSION_RULES : V1_SESSION_RULES}
Labels (titles, shorts, milestone titles) must be safe to show friends: no first names of friends, partner or family, nothing about adult content. Founder and colleague names (Ashot, Samvit, Cam) are fine.
Prefer fewer, real goals over many fragments: a goal is something he would name if asked what he is driving at this month. Give ids in kebab case.`;

const SYNTH_SCHEMA = {
  type: 'object',
  properties: {
    priorities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, title: { type: 'string' }, short: { type: 'string' },
          workspace: { type: 'string', enum: ['union', 'codecast', 'personal'] },
          status: { type: 'string', enum: ['active', 'done', 'set_aside_or_quiet'] },
          evidence: { type: 'string' },
          critical: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, done: { type: 'boolean' }, task: { type: ['string', 'null'] } }, required: ['title', 'done', 'task'], additionalProperties: false } },
          sessions: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'title', 'short', 'workspace', 'status', 'evidence', 'critical', 'sessions'],
        additionalProperties: false,
      },
    },
    standing_sessions: { type: 'array', items: { type: 'string' } },
  },
  required: ['priorities', 'standing_sessions'],
  additionalProperties: false,
};

const SYNTH_SCHEMA_V2 = (() => {
  const schema = structuredClone(SYNTH_SCHEMA) as any;
  schema.properties.priorities.items.properties.sessions = { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, milestone: { type: ['string', 'null'] } }, required: ['id', 'milestone'], additionalProperties: false } };
  schema.properties.one_off_sessions = { type: 'array', items: { type: 'object', properties: { session: { type: 'string' }, why: { type: 'string' } }, required: ['session', 'why'], additionalProperties: false } };
  schema.required.push('one_off_sessions');
  return schema as Record<string, unknown>;
})();

type SnapPriority = GoldenPriority & { workspace: 'union' | 'codecast' | 'personal'; evidence: string; session_milestones?: Record<string, string | null> };
type Snapshot = Omit<Golden, 'priorities'> & {
  as_of: string; priorities: SnapPriority[]; cost_usd: number; variant: string;
  one_off_sessions?: Array<{ session: string; why: string }>;
  /** Sessions the synthesis saw and left nowhere: not under a priority, not standing, not one_off. */
  unaccounted: string[];
};

async function synthesize(cut: { name: string; at: number }, sessions: UniSession[], digests: Map<string, SessionDigests>): Promise<Snapshot> {
  const present = sessions.filter((s) => digests.get(s.id)?.asOf[cut.name]);
  const blocks = present.map((s) => `## ${s.id} · ${s.workspace} · "${s.title}"${s.kind !== 'session' ? ` · ${s.kind}${s.parent ? ` of ${s.parent}` : ''}` : ''}\n${digests.get(s.id)!.asOf[cut.name]}`);
  const prompt = `# Session digests as of ${iso(cut.at)} (${present.length} sessions)\n\n${blocks.join('\n\n')}`;
  const key = sha(SYNTH_SYSTEM(iso(cut.at)) + prompt);
  const cached = join(dir('synth'), `${cut.name}-${key}.json`);
  let reply: { text: string; usd: number };
  if (existsSync(cached)) reply = readJson(cached);
  else {
    const v2 = VARIANT === 'v2';
    reply = await ask(`synth ${VARIANT} ${cut.name} (${present.length} sessions)`, SYNTH_SYSTEM(iso(cut.at)), prompt, v2 ? 48_000 : 32_000, v2 ? SYNTH_SCHEMA_V2 : SYNTH_SCHEMA);
    writeJson(cached, reply);
  }
  type Placed = string | { id: string; milestone: string | null };
  const out = parseJsonBlock(reply.text) as { priorities: Array<Omit<SnapPriority, 'sessions'> & { sessions: Placed[] }>; standing_sessions: string[]; one_off_sessions?: Array<{ session: string; why: string }> } | null;
  if (!out) throw new Error(`synth ${cut.name}: no JSON`);
  const known = new Set(present.map((s) => s.id));
  const session_labels: Record<string, string> = {};
  const priorities: SnapPriority[] = out.priorities.map((p) => {
    const placed = p.sessions.map((x) => (typeof x === 'string' ? { id: x, milestone: null } : x)).filter((x) => known.has(x.id) && !(x.id in session_labels));
    for (const x of placed) session_labels[x.id] = p.id;
    return { ...p, sessions: placed.map((x) => x.id), ...(VARIANT === 'v2' ? { session_milestones: Object.fromEntries(placed.map((x) => [x.id, x.milestone])) } : {}) };
  });
  const standing_sessions = out.standing_sessions.filter((s) => known.has(s) && !(s in session_labels));
  const one_off_sessions = out.one_off_sessions?.filter((o) => known.has(o.session) && !(o.session in session_labels) && !standing_sessions.includes(o.session));
  const accounted = new Set([...Object.keys(session_labels), ...standing_sessions, ...(one_off_sessions ?? []).map((o) => o.session)]);
  return {
    person: USER, window: ['2026-11-10', iso(cut.at).slice(0, 10)], as_of: new Date(cut.at).toISOString(), variant: VARIANT,
    priorities, session_labels, standing_sessions,
    ...(one_off_sessions ? { one_off_sessions } : {}),
    unaccounted: present.map((s) => s.id).filter((s) => !accounted.has(s)),
    cost_usd: reply.usd,
  };
}

// ---------------------------------------------------------------- 5. validate

async function validate(snapshot: Snapshot, sessions: UniSession[]) {
  const golden: Golden = readJson(GOLDEN_PATH);
  const apiKey = evalsApiKey();
  if (!apiKey) throw new Error('no evals key');
  const produced: Produced[] = snapshot.priorities.map((p) => ({
    key: `${p.workspace}:${p.id}`, workspace: p.workspace, title: p.title, summary: p.evidence ?? p.title, status: p.status === 'set_aside_or_quiet' ? 'quiet' : p.status,
    steps: (p.critical ?? []).map((s) => ({ title: s.title, tier: 'critical', done: s.done })), sessions: p.sessions,
  }));
  const read = new Map(sessions.map((s) => [s.id, s.title]));
  const judge = modelJudge(apiKey);
  const result = await score(golden, produced, read, judge.judge, castTaskStatus);
  spent.usd += judge.spent.usd;
  console.error(`  judge $${judge.spent.usd.toFixed(2)} over ${judge.spent.calls} calls`);
  return { ...result, judge_usd: judge.spent.usd };
}

// ---------------------------------------------------------------- main

async function main() {
  const stage = flag('stage') ?? 'all';
  const all = universe();
  console.error(`universe: ${all.length} sessions (${['union', 'codecast', 'personal'].map((w) => `${w} ${all.filter((s) => s.workspace === w).length}`).join(', ')}; kinds ${JSON.stringify(Object.fromEntries([...new Set(all.map((s) => s.kind))].map((k) => [k, all.filter((s) => s.kind === k).length])))})`);
  if (stage === 'universe') return;

  const only = flag('only')?.split(',');
  const limit = flag('limit') ? Number(flag('limit')) : null;
  let pick = only ? all.filter((s) => only.includes(s.id)) : all;
  if (limit) pick = pick.slice(0, limit);

  // Standing roles are never priorities and are never digested: their (very long) transcripts are not read.
  const transcripts = await pool(pick, 8, (s) => (s.kind === 'role' ? Promise.resolve(null) : fetchTranscript(s)));
  const rendered = new Map<string, Rendered>();
  pick.forEach((s, i) => {
    const t = transcripts[i];
    if (t) rendered.set(s.id, render(s, t));
    // A transcript the backend will not serve: read from what he typed in it alone (passInputs), flagged.
    else if (s.kind !== 'role' && s.typed.length) rendered.set(s.id, { lines: s.typed.filter((m) => m.at <= LAST).map((m) => ({ at: m.at, text: `[${iso(m.at)}] JASON TYPED: ${m.text}` })), anomalies: ['transcript unreadable (backend timeouts): digested from his typed messages only'], typed_matched: s.typed.length, typed_total: s.typed.length });
  });
  const missing = pick.filter((s, i) => s.kind !== 'role' && !transcripts[i]).map((s) => s.id);
  const chars = (s: UniSession) => {
    const r = rendered.get(s.id);
    if (!r) return 0;
    return segments(r.lines).reduce((n, seg) => n + Math.min(seg.name === 'pre' ? PRE_WINDOW_CHARS : Infinity, seg.lines.reduce((m, l) => m + l.text.length + 1, 0)), 0);
  };
  // What this run digests anew: the last segment of a session digested before, every segment of a new one.
  const before = SUFFIX ? new Set(readJson<UniSession[]>(join(OUT, 'universe.json')).map((s) => s.id)) : null;
  const newChars = (s: UniSession) => {
    const r = rendered.get(s.id);
    if (!r || !before?.has(s.id)) return chars(s);
    return segments(r.lines).find((seg) => seg.name === THROUGH)!.lines.reduce((m, l) => m + l.text.length + 1, 0);
  };
  const stats = pick.map((s) => ({ id: s.id, workspace: s.workspace, kind: s.kind, title: s.title, chars: chars(s), new_chars: newChars(s), anomalies: rendered.get(s.id)?.anomalies ?? [], typed_matched: rendered.get(s.id)?.typed_matched ?? 0, typed_total: rendered.get(s.id)?.typed_total ?? 0 }));
  writeJson(join(OUT, only || limit ? `transcript-stats${SUFFIX}.partial.json` : `transcript-stats${SUFFIX}.json`), { missing, stale: staleTranscripts, stats });
  const fresh = stats.reduce((n, s) => n + s.new_chars, 0);
  console.error(`transcripts: ${rendered.size} read, ${missing.length} missing, ${staleTranscripts.length} stale; ${stats.reduce((n, s) => n + s.chars, 0)} rendered chars, ${fresh} new (~$${(fresh * 2.03e-6).toFixed(2)} at the T1–T4 rate)`);
  if (stage === 'transcripts') return;

  const toDigest = pick.filter((s) => rendered.has(s.id) && s.kind !== 'role');
  const digested = await pool(toDigest, CONCURRENCY, (s) => digestSession(s, rendered.get(s.id)!));
  const digests = new Map(digested.map((d) => [d.id, d]));
  const digestUsd = digested.reduce((n, d) => n + d.usd, 0);
  const digestChars = toDigest.reduce((n, s) => n + chars(s), 0);
  console.error(`digests: ${digested.length} sessions, $${digestUsd.toFixed(2)} new spend over ${digestChars} chars`);
  if (stage === 'digests') return;

  const roles = pick.filter((s) => s.kind === 'role');
  const snapshots: Snapshot[] = [];
  // A later cut synthesizes only itself: T1–T4 stay as the study wrote them.
  for (const cut of SUFFIX ? CUTS.slice(-1) : CUTS) {
    const snap = await synthesize(cut, pick, digests);
    for (const r of roles) if (!snap.standing_sessions.includes(r.id) && (!r.typed.length || r.typed[0]!.at <= cut.at)) snap.standing_sessions.push(r.id);
    writeJson(join(VARIANT === 'v1' ? dir('snapshots') : dir('snapshots', VARIANT), `${cut.name}.json`), snap);
    snapshots.push(snap);
    console.error(`${cut.name}: ${snap.priorities.length} priorities, ${Object.keys(snap.session_labels).length} sessions placed, ${snap.standing_sessions.length} standing, ${snap.one_off_sessions?.length ?? '-'} one-off, ${snap.unaccounted.length} unaccounted`);
  }
  if (stage === 'synth' || SUFFIX) return console.error(`total spend this run $${spent.usd.toFixed(2)} (${spent.calls} calls)`);

  const v = await validate(snapshots[snapshots.length - 1]!, pick);
  writeJson(join(OUT, VARIANT === 'v1' ? 'validation-T4.json' : `validation-T4-${VARIANT}.json`), v);
  console.error(`T4 vs hand set: ${JSON.stringify(v.metrics)}`);
  console.error(`total spend this run $${spent.usd.toFixed(2)} (${spent.calls} calls)`);
}

if (import.meta.main) await main();
