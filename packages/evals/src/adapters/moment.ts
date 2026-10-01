import { UsageError } from '@platform/evals/cli';

import { parseConversationRef } from '../../../cli/src/conversationRef';
import { cliFetchRead } from '../../../cli/src/cliHttp';
import { apiConfig, readConversation, splitLineRef, toRows, type CliReadConversation, type MessageRow } from './convo';

// A moment in a session, as a call surface freezes it: the session's rows up
// to and including one message, read through /cli/read. Every surface whose
// ref is a session line (title, insight, settle, suggest, ask, handoff) reads
// its moment here, so the ref grammar and the cut are the same everywhere.

export const SESSION_LINE_FORMS = '<session>:<line>, or a session URL with #msg-<id>';

export interface SessionMoment {
  conversation: CliReadConversation;
  /** Every row from line 1 through the moment's line, oldest first. */
  rows: MessageRow[];
  /** The moment's own row: the last of `rows`. */
  at: MessageRow;
  line: number;
}

/** The line a `#msg-<id>` anchor sits on, from a zero-context read around it. */
async function lineOfMessage(conversationId: string, messageId: string): Promise<number> {
  const { siteUrl, apiToken } = apiConfig();
  const r = await cliFetchRead(`${siteUrl}/cli/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_token: apiToken, conversation_id: conversationId, around_message_id: messageId, context: 0 }),
  });
  const body = (await r.json()) as { error?: string; target_line?: number; target_missing?: boolean };
  if (body.error) throw new Error(`cli/read ${conversationId}: ${body.error}`);
  if (!body.target_line || body.target_missing) throw new UsageError(`message ${messageId} is not in session ${conversationId}`);
  return body.target_line;
}

/** Parses `<session>:<line>` or `<url or id>#msg-<id>`; null for anything else. */
export function parseSessionLineRef(ref: string): { conversation: string; line: number } | { conversation: string; messageId: string } | null {
  if (ref.includes('#')) {
    const { conversationId, messageId } = parseConversationRef(ref);
    return conversationId && messageId ? { conversation: conversationId, messageId } : null;
  }
  const { conversation, line } = splitLineRef(ref);
  return line !== null && line > 0 ? { conversation, line } : null;
}

/** Reads a session up to the moment a ref names. `forms` is the surface's ref line for the error. */
export async function readSessionMoment(ref: string, forms: string): Promise<SessionMoment> {
  const parsed = parseSessionLineRef(ref);
  if (!parsed) throw new UsageError(forms);
  const line = 'line' in parsed ? parsed.line : await lineOfMessage(parsed.conversation, parsed.messageId);
  const read = await readConversation(parsed.conversation, { from: 1, to: line });
  const rows = toRows(read.messages);
  const at = rows.find((r) => r.line === line);
  if (!at) throw new UsageError(`session ${parsed.conversation} has no line ${line} (it has ${read.conversation.message_count ?? 0})`);
  return { conversation: read.conversation, rows: rows.filter((r) => r.line <= line), at, line };
}
