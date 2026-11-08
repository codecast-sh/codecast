// `cast chat read --json`: one row shape whichever route serves the read. The
// paged read (/cli/chat/read) returns raw chat rows (`content`, `user_id`, an
// authors list beside them) and the compact --since read (/cli/chat/lines-since)
// returns `lines` with `text` and `author_name`, so a script written against
// one broke on the other. Every row here carries both routes' common keys.

export type ChatJsonRow = {
  id: string;
  text: string;
  author_name: string;
  is_agent: boolean;
  created_at: number;
  thread_root_id?: string;
  [key: string]: unknown;
};

export type ChatJsonRead = {
  messages: ChatJsonRow[];
  next_cursor?: string | null;
  has_more?: boolean;
  truncated?: boolean;
};

/** A paged /cli/chat/read answer: each raw row keeps its fields and gains the common keys. */
export function chatReadJson(result: { messages?: any[]; authors?: Array<{ _id: string; name?: string; is_bot?: boolean }>; has_more?: boolean; next_cursor?: string | null }): ChatJsonRead {
  const authors = new Map((result.authors ?? []).map((a) => [String(a._id), a]));
  return {
    messages: (result.messages ?? []).map((row) => ({
      ...row,
      id: String(row._id),
      text: row.deleted_at ? "" : String(row.content ?? ""),
      author_name: row.author_kind === "agent" ? authors.get(String(row.user_id))?.name ?? "anchor" : row.origin_session_title ?? authors.get(String(row.user_id))?.name ?? String(row.user_id),
      is_agent: row.author_kind === "agent" || !!row.origin_session_title,
      created_at: row.created_at,
      ...(row.thread_root_id ? { thread_root_id: String(row.thread_root_id) } : {}),
    })),
    has_more: !!result.has_more,
    next_cursor: result.next_cursor ?? null,
  };
}

/** A /cli/chat/lines-since answer, under the same envelope and row keys. */
export function chatLinesJson(result: { lines?: any[]; truncated?: boolean }): ChatJsonRead {
  return {
    messages: (result.lines ?? []).map((line) => ({ ...line, id: String(line.message_id) })),
    truncated: !!result.truncated,
  };
}
