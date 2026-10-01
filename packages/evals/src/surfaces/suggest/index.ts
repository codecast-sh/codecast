import type { CheckResult, ConvoMessage, GateResult, Score } from '@platform/evals';
import { UsageError } from '@platform/evals/cli';

import { stripInjectionNoise } from '@codecast/shared/contracts';

import { cliFetchRead } from '../../../../cli/src/cliHttp';
import { contextFromRows, haikuRequest, isConversationTurn, isGenericNudge, isMachineCarrierText, normalizeForMatch, predictSuggestions, type StoredProfile } from '../../../../convex/convex/composerSuggestions';
import { parseJsonBlock } from '../../../../convex/convex/lib/anthropic';
import { apiConfig, splitLineRef, toConvoMessages, toRows, type CliReadConversation, type CliReadMessage, type MessageRow } from '../../adapters/convo';
import { JUDGE_MAX_TOKENS } from '../../adapters/judge';
import { JUDGE_MODEL } from '../../models';
import type { Captured, CaptureCtx, ReplayCtx, ReplayResult, SurfaceImpl } from '../../surface';

// Composer suggestions, graded against what the developer actually typed
// next. A moment is an agent turn the developer replied to by typing. The
// replay runs prod's whole pipeline (predictSuggestions: prompt, completion,
// parse, sanitize) with its completion sent through the harness, on the
// conversation up to that turn and the developer's stored profile with the
// truth scrubbed out of it. A grader on JUDGE_MODEL then compares the pills
// with the truth:
//   hit          a pill says what they typed, sendable as is or with a trivial edit
//   partial      same direction, materially different content
//   miss         pills shown, none of them right
//   silent       no pills; right when the truth is a correction only they could write
//   nudge-silent / nudge-shown
//                the truth is a bare nudge ("continue"): silence is right, and a
//                shown pill is unknowable rather than wrong (they may have clicked
//                it instead of typing the nudge)
// A rep passes when it showed nothing wrong; hits raise the mean above that.

/** One stored row, cut to the fields contextFromRows reads (tool results kept only as a count). */
export interface SuggestRow {
  _id: string;
  role: string;
  content: string;
  timestamp: number;
  message_uuid?: string;
  tool_results?: Array<Record<string, never>>;
  line?: number;
}

export interface SuggestSnap {
  /** The session metadata the prompt prints. */
  conversation: { title?: string; subtitle?: string; idle_summary?: string; thread_state?: string; project_path?: string; git_branch?: string; status?: string };
  /** Time order, ending at the agent turn the developer replied to. */
  rows: SuggestRow[];
  /** The developer's stored profile, as read; the replay scrubs the truth out of it. */
  profile: StoredProfile;
  /** What the developer actually typed next. Never shown to the suggester. */
  truth: string;
  truthAt: number;
}

export type Grade = 'hit' | 'partial' | 'miss' | 'silent' | 'nudge-silent' | 'nudge-shown';

/** Shown nothing wrong passes (0.7 is the pass mark); a hit is the only full score. */
export const GRADE_SCORE: Record<Grade, number> = { hit: 1, 'nudge-silent': 1, 'nudge-shown': 0.7, silent: 0.7, partial: 0.4, miss: 0 };

/** Rows read before the reply. contextFromRows keeps the newest 60; the rest is headroom for a wider prod window. */
const CONTEXT_HEADROOM = 120;

/**
 * What the developer typed, out of a stored user row. Claude Code 2.1.277+
 * wraps every delivered paste (and the daemon delivers composer sends as
 * pastes) in <pasted_content>; stripInjectionNoise takes that wrapper and the
 * harness's reminders off, so a typed reply is not mistaken for markup.
 */
export const typedText = (content: string): string => stripInjectionNoise(content).trim();

/** A user turn the developer typed, as opposed to a machine carrier (the habit miner's test) or a pasted wall. */
export function isTyped(content: string): boolean {
  const t = typedText(content);
  return !!t && !isMachineCarrierText(t) && t.length <= 2000;
}

/** Whether `reply` is a typed developer answer to the agent turn `turn` right before it. */
export function isMoment(turn: MessageRow | undefined, reply: MessageRow | undefined): boolean {
  return Boolean(turn && reply && turn.role === 'assistant' && isConversationTurn(turn) && reply.role === 'user' && isConversationTurn(reply) && isTyped(reply.content));
}

/** Every agent turn → typed reply pair in a run of rows, newest first: the reply's line, and whether it is a bare nudge. */
export function momentsIn(rows: MessageRow[]): Array<{ line: number; nudge: boolean }> {
  const out: Array<{ line: number; nudge: boolean }> = [];
  for (let i = rows.length - 1; i >= 1; i--) if (isMoment(rows[i - 1], rows[i])) out.push({ line: rows[i]!.line, nudge: isGenericNudge(typedText(rows[i]!.content)) });
  return out;
}

const slimRow = (r: MessageRow): SuggestRow => ({
  _id: r._id,
  role: r.role,
  content: r.content,
  timestamp: r.timestamp,
  ...(r.message_uuid ? { message_uuid: r.message_uuid } : {}),
  ...(r.tool_results?.length ? { tool_results: r.tool_results.map(() => ({})) } : {}),
  line: r.line,
});

/**
 * The stored profile is current, so it can hold the very message the moment
 * predicts; at the moment it had not been typed yet. Removing it keeps the
 * replay's verbatim ban from deleting an exact hit.
 */
export function scrubTruth(profile: StoredProfile, truth: string): StoredProfile {
  const key = normalizeForMatch(truth);
  return {
    ...profile,
    recent: profile.recent.filter((t) => normalizeForMatch(t) !== key),
    frequent: profile.frequent.filter((f) => normalizeForMatch(f.text) !== key),
    patterns: profile.patterns?.filter((p) => normalizeForMatch(p.example) !== key),
  };
}

/** The suggester's context at the moment: prod's own selector over the snapshot rows. */
export const contextOf = (snap: SuggestSnap) => contextFromRows(snap.rows as Parameters<typeof contextFromRows>[0], { user_id: 'eval' as never, ...snap.conversation });

/** The caller's own profile through the self-only route; the token names the user. */
export async function ownSuggestionProfile(): Promise<StoredProfile> {
  const { siteUrl, apiToken } = apiConfig();
  const r = await cliFetchRead(`${siteUrl}/cli/suggestion-profile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_token: apiToken }) });
  const text = await r.text();
  let body: (StoredProfile & { _id?: string; _creationTime?: number; user_id?: string; error?: string }) | null;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`cli/suggestion-profile answered ${r.status}: ${text.slice(0, 120)}`);
  }
  if (body?.error) throw new Error(`cli/suggestion-profile: ${body.error}`);
  if (!body) throw new UsageError('this account has no suggestion profile yet: prod mines one the first time it suggests for you');
  const { _id, _creationTime, user_id, error, ...profile } = body;
  return profile;
}

export type Read = { conversation: CliReadConversation; messages: CliReadMessage[] };

const momentList = (conversation: string, rows: MessageRow[]): string => {
  const found = momentsIn(rows).slice(0, 10);
  return found.length ? found.map((m) => `suggest@${conversation}:${m.line}${m.nudge ? ' (nudge)' : ''}`).join(', ') : 'none in these lines';
};

/** The agent turn and the typed reply at `line`, or a UsageError naming the moments nearby. */
function momentAt(read: Read, conversation: string, line: number): { rows: MessageRow[]; at: number } {
  const rows = toRows(read.messages);
  const at = rows.findIndex((r) => r.line === line);
  if (at < 1 || !isMoment(rows[at - 1], rows[at])) throw new UsageError(`${conversation}:${line} is not a typed reply to an agent turn; moments nearby: ${momentList(conversation, rows)}`);
  return { rows, at };
}

/** A moment as a private freeze: the rows up to the agent turn, the profile, and the reply as the truth. */
export function momentSnapshot(read: Read, conversation: string, line: number, profile: StoredProfile): Captured {
  const { rows, at } = momentAt(read, conversation, line);
  const reply = rows[at]!;
  const turn = rows[at - 1]!;
  const c = read.conversation as CliReadConversation & { project_path?: string | null };
  const snapshot: SuggestSnap = {
    conversation: { ...(c.title ? { title: c.title } : {}), ...(c.project_path ? { project_path: c.project_path } : {}) },
    rows: rows.slice(0, at).map(slimRow),
    profile,
    truth: typedText(reply.content),
    truthAt: reply.timestamp,
  };
  return {
    snapshot,
    name: `suggest ${conversation}:${line}`,
    subject: { kind: 'session', id: c.id, title: c.title ?? c.id },
    asOf: new Date(turn.timestamp).toISOString(),
    anchor: { kind: 'message', id: reply._id },
    meta: {
      conversation_id: c.id,
      line,
      snapshot_approximate: [
        'the profile is the one stored at capture, scrubbed of the truth, not the one prod held at the moment',
        'the title is the current one; branch, idle summary and thread state are not on /cli/read and are left out',
        'the 60 row window counts /cli/read lines, which skip empty rows',
      ],
    },
  };
}

export function graderPrompt(agentTail: string, truth: string, suggestions: string[]): string {
  return `A coding agent said something; the developer then typed a reply. Separately, a system had predicted the developer's reply as one or more suggested messages, shown before they typed. Grade the prediction.

Agent's message (end of it):
"""
${agentTail.slice(-1500)}
"""

What the developer ACTUALLY typed next:
"""
${truth}
"""

Predicted suggestions:
${suggestions.map((s, i) => `${i + 1}. """${s}"""`).join('\n')}

Grade with ONE of:
- hit: at least one suggestion says what the developer typed (same request, same decision or same answer), such that they would have sent it as written or with a trivial edit.
- partial: a suggestion heads the same direction but its content differs materially (asks for something else, adds or drops a real requirement, answers a different question).
- miss: no suggestion matches. Includes: the developer corrected the agent or changed course while the suggestions assumed the agent was right; the developer asked something the suggestions do not touch.

Return ONLY JSON: {"grade": "hit" | "partial" | "miss", "why": "one short sentence"}`;
}

export interface SuggestOutcome {
  suggestions: string[];
  error?: 'provider_failed' | 'invalid_json';
  /** null when the grader returned no grade. */
  grade: Grade | null;
  why: string;
}

/** Grades the pills against the truth; only a moment with pills and a substantive truth needs the grader. */
export async function gradeMoment(snap: SuggestSnap, suggestions: string[], ctx: Pick<ReplayCtx, 'call'>): Promise<{ grade: Grade | null; why: string }> {
  if (isGenericNudge(snap.truth)) return { grade: suggestions.length ? 'nudge-shown' : 'nudge-silent', why: 'the truth is a bare nudge' };
  if (!suggestions.length) return { grade: 'silent', why: 'no pills' };
  const agentTail = [...contextOf(snap).turns].reverse().find((t) => t.role === 'assistant')?.content ?? '';
  const r = await ctx.call({ model: JUDGE_MODEL, prompt: graderPrompt(agentTail, snap.truth, suggestions), max_tokens: JUDGE_MAX_TOKENS }, { grader: true });
  const parsed = parseJsonBlock(r.text) as { grade?: unknown; why?: unknown } | null;
  const grade = parsed?.grade;
  if (grade !== 'hit' && grade !== 'partial' && grade !== 'miss') return { grade: null, why: `the grader returned no grade: ${r.text.slice(0, 160)}` };
  return { grade, why: String(parsed?.why ?? '') };
}

const gate = (id: string, pass: boolean, summary: string): GateResult => ({ id, pass, decidedBy: 'mechanical', evidence: { summary } });
const outcomeOf = (out: ReplayResult): SuggestOutcome => out.parsed as SuggestOutcome;
const GRADE_EVIDENCE = /^grade=([a-z-]+)/;

/** Precision and coverage over a set of graded reps: the cost side and the value side of showing pills. */
export function gradeTotals(grades: Grade[]) {
  const count = (g: Grade) => grades.filter((x) => x === g).length;
  const hit = count('hit'), partial = count('partial'), miss = count('miss'), silent = count('silent');
  const shown = hit + partial + miss;
  const n = shown + silent;
  return {
    n, hit, partial, miss, silent, nudgeSilent: count('nudge-silent'), nudgeShown: count('nudge-shown'),
    // Of the pills shown at substantive moments, how many were right: the cost side.
    precision: shown ? hit / shown : 0,
    // Of all substantive moments, how many got a right pill: the value side.
    coverage: n ? hit / n : 0,
  };
}

const impl: SurfaceImpl = {
  refForms: 'suggest@ needs the session line where the developer typed the reply, like suggest@jx7c6zk:142 (suggest@jx7c6zk lists the moments)',

  async capture(ref: string, ctx: CaptureCtx): Promise<Captured> {
    const { conversation, line } = splitLineRef(ref);
    if (line === null) {
      const head = (await ctx.readConversation(conversation, { from: 1, to: 1 })) as Read;
      const total = head.conversation.message_count ?? 0;
      const tail = (await ctx.readConversation(conversation, { from: Math.max(1, total - 199), to: total })) as Read;
      throw new UsageError(`suggest@ needs a line; the newest moments in ${conversation}: ${momentList(conversation, toRows(tail.messages))}`);
    }
    const read = (await ctx.readConversation(conversation, { from: Math.max(1, line - CONTEXT_HEADROOM), to: line })) as Read;
    momentAt(read, conversation, line);
    return momentSnapshot(read, conversation, line, await ownSuggestionProfile());
  },

  async replay(snap: SuggestSnap, ctx) {
    const predicted = await predictSuggestions(contextOf(snap), scrubTruth(snap.profile, snap.truth), 'anthropic', async (opts) => {
      // prod's anthropic branch posts exactly this request (llmComplete).
      const r = await ctx.call(haikuRequest(opts.prompt, opts.maxTokens));
      // A dry call echoes the prompt; the canned answer is the one the prompt calls most common.
      const text = ctx.dry ? '[]' : r.text.trim();
      return !r.isError && text ? { text } : null;
    });
    const graded = predicted.error ? { grade: null, why: `pipeline failed: ${predicted.error}` } : await gradeMoment(snap, predicted.suggestions, ctx);
    const outcome: SuggestOutcome = { suggestions: predicted.suggestions, ...(predicted.error ? { error: predicted.error } : {}), ...graded };
    return { reply: predicted.suggestions.map((s) => `- ${s}`).join('\n'), parsed: outcome };
  },

  gates(_snap: SuggestSnap, out) {
    const o = outcomeOf(out);
    const gates = [gate('pipeline-ok', !o.error, o.error ? `the pipeline failed: ${o.error}` : `${o.suggestions.length} pill(s) came through parse and sanitize`)];
    if (!o.error) gates.push(gate('graded', o.grade !== null, o.grade ? `graded ${o.grade}` : o.why));
    return gates;
  },

  checks(snap: SuggestSnap, out): CheckResult[] {
    const o = outcomeOf(out);
    if (!o.grade) return [];
    return [{ id: 'grade', ask: 'the pills against what the developer typed next', weight: 1, score: GRADE_SCORE[o.grade], reasoning: o.why, evidence: `grade=${o.grade}; typed: ${snap.truth.slice(0, 160)}` }];
  },

  summarize(scores: Score[]): string[] {
    const grades = scores.flatMap((s) => {
      const m = GRADE_EVIDENCE.exec(s.checks.find((c) => c.id === 'grade')?.evidence ?? '');
      return m ? [m[1] as Grade] : [];
    });
    if (!grades.length) return ['grades: none graded'];
    const t = gradeTotals(grades);
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    return [`grades: hit ${t.hit} partial ${t.partial} miss ${t.miss} silent ${t.silent} | precision ${pct(t.precision)} coverage ${pct(t.coverage)} | nudge moments: silent ${t.nudgeSilent} shown ${t.nudgeShown}`];
  },

  describe(snap: SuggestSnap): ConvoMessage[] {
    const turns = contextOf(snap).turns.map((t, i) => ({ ...t, line: i + 1 }));
    return toConvoMessages([...turns, { role: 'user', content: snap.truth, timestamp: snap.truthAt, line: turns.length + 1 }]);
  },

  productionReply: () => null,
};

export default impl;
