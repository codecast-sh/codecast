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
  // Provenance. `is_own` says whose ACCOUNT owns the row, not who typed the
  // words: a machine-delivered prompt lands under the owner like any other
  // user-role turn. These two fields say who actually wrote it.
  //
  // A subagent conversation has no human author at all — every user-role turn
  // in it is a prompt its parent agent wrote through the Agent tool.
  //
  // A machine-started conversation (`cast spawn` from another session, a
  // scheduled run) has exactly ONE agent-written turn, the seed prompt that
  // created it; everything after it can still be typed by a person, so the
  // merge resolves that one message id instead of hiding the conversation.
  isSubagent?: boolean;
  machineSeeded?: boolean;
  // Short id of the session that wrote those turns, when known.
  agentSource?: string;
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
  // True when an agent wrote this prompt rather than a person (see
  // FeedCandidate). The feed's "People" and "Mine" views drop these; "All"
  // keeps them and labels them with agent_source.
  from_agent: boolean;
  agent_source?: string;
};

// Fetch the newest user-role messages for one conversation with timestamp <
// cursor (or newest overall when cursor is undefined), capped at `take`.
export type FetchUserMessages = (
  conversationId: string,
  cursor: number | undefined,
  take: number
) => Promise<FeedRawMessage[]>;

// Id of a conversation's OLDEST user-role message — its seed prompt. Called at
// most once per machine-started conversation that reaches the page, so the
// per-page cost stays proportional to what the reader actually sees.
export type FetchSeedMessageId = (conversationId: string) => Promise<string | null>;

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
  fetchSeedMessageId?: FetchSeedMessageId;
}): Promise<{ messages: FeedMessage[]; nextCursor: number | null }> {
  const { candidates, cursor, limit, fetchUserMessages, fetchSeedMessageId } = opts;
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
    // Resolved lazily, once, and only for a machine-started conversation that
    // actually put a message on this page. `undefined` = not looked up yet.
    let seedId: string | null | undefined;
    for (const m of msgs) {
      if (!isMeaningfulFeedContent(m.content)) continue;
      let fromAgent = cand.isSubagent === true;
      if (!fromAgent && cand.machineSeeded && fetchSeedMessageId) {
        if (seedId === undefined) seedId = await fetchSeedMessageId(cand.conversation_id);
        fromAgent = seedId !== null && seedId === m._id;
      }
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
        from_agent: fromAgent,
        ...(fromAgent && cand.agentSource ? { agent_source: cand.agentSource } : {}),
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
