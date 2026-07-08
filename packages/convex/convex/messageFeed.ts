// Pure merge logic for the web message feed (conversations.getMessageFeed).
//
// The feed shows the newest user-role prompts across many conversations, merged
// by timestamp. The conversations the viewer can see are the candidate set; this
// module merges their user-role messages into one page WITHOUT reading the whole
// message table. It is deliberately free of Convex types so it can be unit-tested
// against a plain in-memory fetcher (see messageFeed.test.ts) — the query layer
// injects a real `fetchUserMessages` backed by the by_conversation_role_timestamp
// index.

// One conversation the viewer can see. `title`/`session_id`/`authorName` are
// pre-resolved by the caller so this module stays formatting-agnostic.
export type FeedCandidate = {
  conversation_id: string;
  updated_at: number;
  title: string;
  session_id: string;
  isOwn: boolean;
  authorName: string;
};

// A user-role message as read from the index. Only the fields the feed renders.
export type FeedRawMessage = {
  _id: string;
  conversation_id: string;
  role: string;
  content?: string | undefined;
  timestamp: number;
  tool_calls?: unknown[] | undefined;
  tool_results?: unknown[] | undefined;
};

export type FeedMessage = {
  _id: string;
  conversation_id: string;
  role: string;
  content: string | undefined;
  timestamp: number;
  has_tool_calls: boolean;
  has_tool_results: boolean;
  conversation_title: string;
  conversation_session_id: string;
  author_name: string;
  is_own: boolean;
};

// Fetch the newest user-role messages for one conversation with timestamp <
// cursor (or newest overall when cursor is undefined), capped at `take`.
export type FetchUserMessages = (
  conversationId: string,
  cursor: number | undefined,
  take: number
) => Promise<FeedRawMessage[]>;

// A user message only reaches the feed if it carries real prose. Mirrors the old
// query's guard (and matches the conversation view's "meaningful content" bar).
export function isMeaningfulFeedContent(content: string | undefined): boolean {
  return !!content && content.trim().length > 10;
}

export async function mergeUserMessageFeed(opts: {
  candidates: FeedCandidate[];
  cursor: number | undefined;
  limit: number;
  fetchUserMessages: FetchUserMessages;
}): Promise<{ messages: FeedMessage[]; nextCursor: number | null }> {
  const { candidates, cursor, limit, fetchUserMessages } = opts;
  const KEEP = limit + 1; // the page plus one extra to know whether there's more

  // Newest-activity first. updated_at is an upper bound on any message timestamp
  // in a conversation, which is what lets the early-exit below be sound.
  const sorted = [...candidates].sort((a, b) => b.updated_at - a.updated_at);

  const collected: FeedMessage[] = [];
  let pageCutoff = -Infinity; // timestamp of the weakest message currently on the page

  for (const cand of sorted) {
    const convUpper =
      cursor !== undefined ? Math.min(cand.updated_at, cursor) : cand.updated_at;
    // The page is full and neither this conversation nor any older one (sorted
    // descending) can produce a message newer than the weakest already on the
    // page. Strict `<` keeps fetching on a tie so a boundary message is never
    // missed.
    if (collected.length >= KEEP && convUpper < pageCutoff) break;

    const msgs = await fetchUserMessages(cand.conversation_id, cursor, KEEP);
    for (const m of msgs) {
      if (!isMeaningfulFeedContent(m.content)) continue;
      collected.push({
        _id: m._id,
        conversation_id: m.conversation_id,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        has_tool_calls: !!(m.tool_calls && m.tool_calls.length > 0),
        has_tool_results: !!(m.tool_results && m.tool_results.length > 0),
        conversation_title: cand.title,
        conversation_session_id: cand.session_id,
        author_name: cand.authorName,
        is_own: cand.isOwn,
      });
    }

    if (collected.length >= KEEP) {
      collected.sort((a, b) => b.timestamp - a.timestamp);
      if (collected.length > KEEP) collected.length = KEEP; // keep the top limit+1
      pageCutoff = collected[limit - 1].timestamp;
    }
  }

  collected.sort((a, b) => b.timestamp - a.timestamp);
  const hasMore = collected.length > limit;
  const messages = hasMore ? collected.slice(0, limit) : collected;
  const nextCursor = hasMore ? messages[messages.length - 1].timestamp : null;

  return { messages, nextCursor };
}
