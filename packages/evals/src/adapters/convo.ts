import { spawnSync } from 'node:child_process';

import type { ConvoMessage, ConvoSource, ConvoSubject, Conversation, Freeze, FreezeStore, InboxRow, SearchHit } from '@platform/evals';

import { cliFetchRead, cliSearchRequest } from '../../../cli/src/cliHttp';
import { defaultConfigDir, readAuthConfig } from '../../../cli/src/config/readAuthConfig';

// Codecast's conversations, read only through access-checked doors: /cli/read
// and /cli/search with the CLI's own token, and `cast sessions --json` for
// the inbox. A subject that has a freeze snapshot is read from the snapshot,
// so a frozen moment shows what the replay saw and nothing that came later.

/** One message as /cli/read returns it. */
export interface CliReadMessage {
  id?: string;
  line: number;
  role: string;
  content: string;
  timestamp: string;
  message_uuid?: string;
  tool_calls?: Array<{ id?: string; name?: string; input?: unknown }>;
  tool_results?: Array<{ tool_use_id?: string; content?: string; is_error?: boolean }>;
}

export interface CliReadConversation {
  id: string;
  title?: string;
  session_id?: string;
  agent_type?: string;
  model?: string | null;
  message_count?: number;
  started_at?: string;
  updated_at?: string;
}

/** A message in the shape the convex `messages` table stores, which is what the prod selectors read. */
export interface MessageRow {
  _id: string;
  role: string;
  content: string;
  /** Epoch ms, as stored. */
  timestamp: number;
  message_uuid?: string;
  tool_calls?: CliReadMessage['tool_calls'];
  tool_results?: CliReadMessage['tool_results'];
  /** The /cli/read line number, kept so a snapshot can be cut and cited by line. */
  line: number;
}

/**
 * /cli/read messages to the row fields the prod selectors read. `_id` is the
 * Convex message id when the read carried one, else `line:<n>`; tool payloads
 * are the read's capped copies (500 characters of input, 1000 of a result),
 * which no title, settle or insight selector reads past.
 */
export function toRows(messages: CliReadMessage[]): MessageRow[] {
  return messages.map((m) => ({
    _id: m.id ?? `line:${m.line}`,
    role: m.role,
    content: m.content ?? '',
    timestamp: Date.parse(m.timestamp),
    ...(m.message_uuid ? { message_uuid: m.message_uuid } : {}),
    ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}),
    ...(m.tool_results?.length ? { tool_results: m.tool_results } : {}),
    line: m.line,
  }));
}

/** Rows (or /cli/read messages) as the conversation views show them. */
export function toConvoMessages(rows: Array<Pick<MessageRow, 'role' | 'content' | 'line'> & { _id?: string; id?: string; timestamp: number | string }>): ConvoMessage[] {
  return rows.map((r) => ({
    n: r.line,
    id: r._id ?? r.id ?? `line:${r.line}`,
    at: new Date(r.timestamp).toISOString(),
    channel: 'session',
    isGroup: false,
    direction: r.role === 'user' ? 'in' : r.role === 'assistant' ? 'out' : 'system',
    from: r.role === 'user' ? 'user' : r.role === 'assistant' ? 'assistant' : r.role,
    text: r.content,
  }));
}

export interface ApiConfig {
  siteUrl: string;
  apiToken: string;
}

/** The CLI's own sign-in, decrypted; an error that says how to fix it when there is none. */
export function apiConfig(): ApiConfig {
  const config = readAuthConfig(defaultConfigDir());
  if (!config?.auth_token || !config.convex_url) throw new Error('not signed in to codecast here: run `cast auth`, then retry');
  return { siteUrl: config.convex_url.replace('.cloud', '.site'), apiToken: config.auth_token };
}

const PAGE = 25;

/** A conversation (short id, full id) through /cli/read, full content, paged. */
export async function readConversation(ref: string, opts: { from?: number; to?: number } = {}): Promise<{ conversation: CliReadConversation; messages: CliReadMessage[] }> {
  const { siteUrl, apiToken } = apiConfig();
  const page = async (start: number, end: number) => {
    const r = await cliFetchRead(`${siteUrl}/cli/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_token: apiToken, conversation_id: ref, start_line: start, end_line: end, full_content: true }),
    });
    const body = (await r.json()) as { error?: string; conversation?: CliReadConversation; messages?: CliReadMessage[] };
    if (body.error) throw new Error(`cli/read ${ref}: ${body.error}`);
    return body;
  };
  const from = Math.max(1, opts.from ?? 1);
  const first = await page(from, from + PAGE - 1);
  const total = first.conversation?.message_count ?? 0;
  const last = Math.min(opts.to ?? total, total);
  const messages = [...(first.messages ?? [])];
  for (let line = from + PAGE; line <= last; line += PAGE) {
    const next = await page(line, Math.min(line + PAGE - 1, last));
    if (!next.messages?.length) break;
    messages.push(...next.messages);
  }
  return { conversation: first.conversation!, messages: messages.filter((m) => m.line <= last) };
}

/** `<session>:<line>` → its parts; anything else is a bare conversation ref. */
export function splitLineRef(ref: string): { conversation: string; line: number | null } {
  const m = /^(.+):(\d+)$/.exec(ref);
  return m ? { conversation: m[1]!, line: Number(m[2]) } : { conversation: ref, line: null };
}

const sessionSubject = (c: CliReadConversation): ConvoSubject => ({ kind: 'session', id: c.id, title: c.title ?? c.id });

export interface ConvoDeps {
  freezes: FreezeStore;
  /** A freeze's snapshot as messages, or null when it has none here. */
  describeFreeze(f: Freeze): Promise<ConvoMessage[] | null>;
}

export function codecastConvoSource(deps: ConvoDeps): ConvoSource {
  const fromSnapshot = async (subject: ConvoSubject): Promise<Conversation | null> => {
    const frozen = await deps.freezes.list({ subjectId: subject.id });
    for (const f of frozen.filter((x) => x.subject.id === subject.id)) {
      const messages = await deps.describeFreeze(f).catch(() => null);
      if (messages) return { subject: f.subject, participants: [], messages, total: messages.length };
    }
    return null;
  };

  return {
    async inbox(opts) {
      const r = spawnSync('cast', ['sessions', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (r.status !== 0) throw new Error(`cast sessions --json failed: ${(r.stderr || '').trim().split('\n').pop()}`);
      const sessions = (JSON.parse(r.stdout) as { sessions?: Array<Record<string, unknown>> }).sessions ?? [];
      const rows: InboxRow[] = sessions.map((s) => ({
        messageId: String(s.id),
        at: String(s.updated_at ?? ''),
        subject: { kind: 'session', id: String(s.id), title: String(s.title ?? s.id) },
        from: 'user',
        channel: 'session',
        preview: String(s.last_user_message ?? s.idle_summary ?? '').slice(0, 200),
        unanswered: s.work_state === 'needs_input',
      }));
      return rows.filter((row) => !opts.since || Date.parse(row.at) >= opts.since).filter((row) => !opts.unanswered || row.unanswered).slice(0, opts.limit ?? 40);
    },

    async resolve(ref) {
      const { conversation, line } = splitLineRef(ref);
      const read = await readConversation(conversation, { from: line ?? 1, to: line ?? 1 }).catch(() => null);
      if (!read) return null;
      return { subject: sessionSubject(read.conversation), focusId: read.messages[0]?.id ?? null };
    },

    async load(subject) {
      const frozen = await fromSnapshot(subject);
      if (frozen) return frozen;
      if (subject.kind === 'synthetic') return { subject, participants: [], messages: [], total: 0 };
      const read = await readConversation(subject.id);
      const messages = toConvoMessages(toRows(read.messages));
      return { subject: sessionSubject(read.conversation), participants: [], messages, total: read.conversation.message_count ?? messages.length };
    },

    async message(id) {
      const { conversation, line } = splitLineRef(id);
      if (line === null) return null;
      const read = await readConversation(conversation, { from: line, to: line });
      const m = read.messages[0];
      if (!m) return null;
      return { message: toConvoMessages(toRows([m]))[0]!, subject: sessionSubject(read.conversation), participant: null, raw: m };
    },

    async find(text, opts) {
      const { siteUrl, apiToken } = apiConfig();
      const result = await cliSearchRequest(siteUrl, { api_token: apiToken, query: text, limit: opts.limit ?? 20, start_time: opts.since });
      if (result?.error) throw new Error(`cli/search: ${result.error}`);
      const hits: SearchHit[] = [];
      for (const c of (result?.conversations ?? []) as Array<Record<string, any>>) {
        if (opts.subject && c.id !== opts.subject.id) continue;
        const subject: ConvoSubject = { kind: 'session', id: String(c.id), title: String(c.title ?? c.id) };
        const matches = (c.matches ?? []) as Array<Record<string, any>>;
        for (const m of matches.length ? matches : [{}]) {
          hits.push({ messageId: m.line ? `${c.id}:${m.line}` : String(c.id), at: String(m.timestamp ?? c.updated_at ?? ''), subject, channel: 'session', from: String(m.role ?? 'session'), excerpt: String(m.content ?? c.title ?? '').slice(0, 300) });
        }
      }
      return hits;
    },
  };
}
