import type { ConvoMessage } from '@platform/evals';

import { insightRequest, parseInsightReply, selectInsightContext, type InsightMessageRow, type InsightRequestContext } from '../../../../convex/convex/sessionInsights';
import { toConvoMessages } from '../../adapters/convo';
import { readSessionMoment, SESSION_LINE_FORMS } from '../../adapters/moment';
import { gate, type SurfaceImpl } from '../../surface';

// The session insight replayed from the rows getConversationContextForInsight
// reads: the newest 80 rows before the moment, oldest first. prod's own
// selectInsightContext samples them and insightRequest prints the prompt, so
// the replay sends what prod would have sent at that line.

/** The rows the insight query reads, plus the line each sits on (for describe). */
type Row = InsightMessageRow & { line: number };

export interface InsightSnap {
  rows: Row[];
  conversation: InsightRequestContext['conversation'];
  commits: InsightRequestContext['commits'];
  prs: InsightRequestContext['prs'];
  /** The run reason the prompt prints: idle, commit, manual or periodic. */
  source: string;
  approximate?: string[];
}

/** How many of the newest rows the insight query reads. */
export const INSIGHT_ROWS = 80;

const REF_FORMS = `insight@ needs a session and line, like insight@jx7c6zk:142 (${SESSION_LINE_FORMS})`;

export function insightSurfaceRequest(snap: InsightSnap) {
  return insightRequest({ ...selectInsightContext(snap.rows), conversation: snap.conversation, commits: snap.commits, prs: snap.prs }, snap.source);
}

/** The fields the prompt asks for, after prod's parser: what a stored insight needs to be whole. */
export function missingInsightFields(parsed: ReturnType<typeof parseInsightReply>): string[] {
  if (!parsed.ok) return [parsed.reason];
  const missing: string[] = [];
  if (!parsed.headline) missing.push('headline');
  if (!parsed.turns?.length) missing.push('turns');
  if (typeof parsed.summary !== 'string' || !parsed.summary.trim()) missing.push('summary');
  if (!parsed.themes.length) missing.push('themes');
  if (parsed.confidence === undefined) missing.push('confidence');
  return missing;
}

const impl: SurfaceImpl = {
  refForms: REF_FORMS,

  async capture(ref) {
    const m = await readSessionMoment(ref, REF_FORMS);
    // The query reads 80 rows of any role; only the turns' first 500
    // characters and the tool names ever reach the prompt.
    const rows: Row[] = m.rows.slice(-INSIGHT_ROWS).map((r) => ({
      role: r.role,
      content: r.content.slice(0, 500),
      timestamp: r.timestamp,
      line: r.line,
      ...(r.tool_calls?.length ? { tool_calls: r.tool_calls.map((t) => ({ name: String(t.name ?? '') })) } : {}),
    }));
    const snapshot: InsightSnap = {
      rows,
      // /cli/read names the project and nothing else about the session; the
      // rest is what can be known at the moment without later passes.
      conversation: {
        project_path: m.conversation.project_path ?? undefined,
        status: 'active',
        started_at: m.rows[0]?.timestamp,
        updated_at: m.at.timestamp,
      },
      commits: [],
      prs: [],
      source: 'periodic',
      approximate: ['title, subtitle, idle_summary and git_branch are blank: /cli/read has no history of them', 'commits and linked PRs are empty: no access-checked read lists them'],
    };
    return {
      snapshot,
      subject: { kind: 'session', id: m.conversation.id, title: m.conversation.title ?? m.conversation.id },
      asOf: new Date(m.at.timestamp).toISOString(),
      anchor: { kind: 'message', id: `${m.conversation.id}:${m.line}` },
      name: `insight ${m.conversation.id.slice(0, 7)}:${m.line}`,
      meta: { conversation_id: m.conversation.id, line: m.line },
    };
  },

  async replay(snap: InsightSnap, ctx) {
    const r = await ctx.call(insightSurfaceRequest(snap));
    let parsed: ReturnType<typeof parseInsightReply>;
    try {
      parsed = parseInsightReply(r.text);
    } catch {
      parsed = { ok: false, reason: 'invalid_json' };
    }
    if (!parsed.ok) return { reply: r.text, parsed };
    const turns = (parsed.turns ?? []).map((t) => `- ${t.ask}\n${t.did.map((d) => `  - ${d}`).join('\n')}`);
    return { reply: [parsed.headline, ...turns, String(parsed.summary ?? ''), `outcome: ${parsed.outcomeType}`].filter(Boolean).join('\n'), parsed };
  },

  gates(_snap, out) {
    const missing = missingInsightFields(out.parsed as ReturnType<typeof parseInsightReply>);
    return [gate('parse', missing.length === 0, missing.length ? `prod's parser leaves out: ${missing.join(', ')}` : 'headline, turns, summary, themes and confidence all parse')];
  },

  describe(snap: InsightSnap): ConvoMessage[] {
    return toConvoMessages(snap.rows.filter((r) => (r.role === 'user' || r.role === 'assistant') && r.content).map((r) => ({ ...r, content: r.content ?? '' })));
  },

  productionReply: () => null,
};

export default impl;
