// Instant tier: the sessions already in the local store, matched as the user
// types. The message-content search runs on the server and takes as long as it
// takes; the store holds every session the inbox has loaded, so the first
// keystroke can already answer "which session was that?" the way ⌘K does. The
// server tiers land on top of these rows later and supersede them by id.
//
// The rows carry the SAME shape searchConversations/searchConversationTitles
// return, so a surface renders one list and never branches on where a row came
// from — except to say, honestly, that content search is still running.
import { useMemo } from "react";
import {
  useInboxStore,
  filterInboxScopeFromState,
  type InboxSession,
} from "../store/inboxStore";
import { makeCollectionSig } from "../store/wakeSig";
import { cleanTitle } from "./conversationProcessor";
import { matchScore } from "./mentionRanking";
import { identityRowOf, type IdentityRow } from "./sessionIdentity";

export type SessionSearchRow = {
  conversationId: string;
  title: string;
  matches: Array<{ messageId: string; content: string; role: string; timestamp: number }>;
  matchCount: number;
  updatedAt: number;
  authorName: string;
  authorAvatar?: string | null;
  isOwn: boolean;
  messageCount: number;
  projectPath?: string | null;
  agentType?: string | null;
  titleMatch?: boolean;
  /** This row came from the local cache, not from the server search. */
  instant?: boolean;
  /** The text the local match landed in (summary, project path), for a preview line. */
  instantSnippet?: string | null;
  /** Who the session is (docs/architecture/session-characters.md S1), so a
   *  result wears the same face as its inbox card. The server tiers send it
   *  too, so a row reads the same whichever tier produced it. */
  identity?: IdentityRow | null;
};

/** Everything about a cached session a typed query may reasonably name. */
export function sessionSearchHaystack(conv: {
  title?: string;
  subtitle?: string;
  idle_summary?: string;
  thread_state?: string | null;
  project_path?: string;
  authorName?: string;
  author_name?: string | null;
}): string {
  return [
    cleanTitle(conv.title || ""),
    conv.subtitle || "",
    conv.idle_summary || "",
    conv.thread_state || "",
    conv.project_path || "",
    conv.authorName || conv.author_name || "",
  ]
    .join(" ")
    .toLowerCase();
}

/** Substring test over that haystack — the ⌘K recents filter and the instant tier share it. */
export function sessionMatchesQuery(conv: Parameters<typeof sessionSearchHaystack>[0], lowerQuery: string): boolean {
  if (!lowerQuery) return true;
  return sessionSearchHaystack(conv).includes(lowerQuery);
}

// Only the fields a match or a row's face reads. updated_at is deliberately
// absent: it ticks with every heartbeat, and ordering a transient result list
// by a value that is seconds stale is invisible, while re-running this over
// thousands of rows on each tick is not.
export const searchableSessionsSig = makeCollectionSig<InboxSession>(
  (s) =>
    `${s.title ?? ""}|${s.subtitle ?? ""}|${s.idle_summary ?? ""}|${s.thread_state ?? ""}|${s.project_path ?? ""}|${s.author_name ?? ""}|${s.message_count ?? 0}`,
);

const INSTANT_SCAN_CAP = 1500;

/** The preview line for an instant row: where in the session the query landed. */
function instantSnippetFor(conv: InboxSession, lowerQuery: string): string | null {
  const candidates = [conv.idle_summary, conv.subtitle, conv.thread_state, conv.project_path];
  for (const text of candidates) {
    if (text && text.toLowerCase().includes(lowerQuery)) return text;
  }
  return conv.idle_summary || conv.subtitle || null;
}

export type InstantSearchOpts = {
  /** Match only sessions the viewer owns — the /search page's "Only mine" scope. */
  mineOnly?: boolean;
};

export function instantSessionRows(
  state: Parameters<typeof filterInboxScopeFromState>[0] & { currentUser?: { _id: unknown } | null },
  query: string,
  cap = 12,
  opts: InstantSearchOpts = {},
): SessionSearchRow[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const meId = state.currentUser?._id?.toString?.() ?? null;

  const ranked: Array<{ row: SessionSearchRow; rank: number }> = [];
  const pool = Object.values(filterInboxScopeFromState(state));
  const scan = pool.length > INSTANT_SCAN_CAP ? pool.slice(0, INSTANT_SCAN_CAP) : pool;
  for (const conv of scan) {
    if (conv.is_subagent) continue;
    if (opts.mineOnly && meId && conv.user_id && conv.user_id !== meId) continue;
    if (!sessionMatchesQuery(conv, q)) continue;
    const title = cleanTitle(conv.title || "") || "New Session";
    // How directly the words name the session leads; recency breaks ties —
    // the same rule the @-mention list and the palette rank by.
    const titleRank = matchScore(title, q);
    const rank = titleRank === Infinity ? 100 : titleRank;
    ranked.push({
      rank,
      row: {
        conversationId: conv._id,
        title,
        matches: [],
        matchCount: 0,
        updatedAt: conv.updated_at || 0,
        authorName: conv.author_name || "",
        authorAvatar: conv.author_avatar ?? null,
        isOwn: !conv.user_id || !meId || conv.user_id === meId,
        messageCount: conv.message_count || 0,
        projectPath: conv.project_path || null,
        agentType: conv.agent_type || null,
        titleMatch: titleRank !== Infinity,
        instant: true,
        instantSnippet: instantSnippetFor(conv, q),
        identity: identityRowOf(conv as any),
      },
    });
  }
  ranked.sort((a, b) => a.rank - b.rank || b.row.updatedAt - a.row.updatedAt);
  return ranked.slice(0, cap).map((r) => r.row);
}

/**
 * Instant rows for a query, live off the store. Inactive (short query) costs
 * nothing: the selector returns a constant, so neither the signature pass nor a
 * re-render happens while the search is closed.
 */
export function useInstantSessionRows(query: string, cap = 12, opts: InstantSearchOpts = {}): SessionSearchRow[] {
  const active = query.trim().length >= 2;
  const mineOnly = !!opts.mineOnly;
  const sig = useInboxStore((s) => (active ? searchableSessionsSig(s.sessions) : ""));
  const scope = useInboxStore((s) => s.clientState.ui?.inbox_scope ?? "mine");
  return useMemo(
    () => (active ? instantSessionRows(useInboxStore.getState() as any, query, cap, { mineOnly }) : []),
    // sig/scope stand in for the store read inside; query drives the match.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active, sig, scope, query, cap, mineOnly],
  );
}

/**
 * One result list from several tiers, best first. Earlier tiers win a
 * conversation outright; a later tier only fills in what the winner lacks, so a
 * server row that arrives with no snippet keeps the preview the instant row had.
 */
export function mergeSearchRows(...tiers: Array<SessionSearchRow[] | undefined>): SessionSearchRow[] {
  const byId = new Map<string, SessionSearchRow>();
  const order: string[] = [];
  for (const tier of tiers) {
    for (const row of tier ?? []) {
      const prev = byId.get(row.conversationId);
      if (!prev) {
        byId.set(row.conversationId, row);
        order.push(row.conversationId);
        continue;
      }
      byId.set(row.conversationId, {
        ...prev,
        instantSnippet: prev.instantSnippet ?? row.instantSnippet,
        projectPath: prev.projectPath ?? row.projectPath,
        messageCount: prev.messageCount || row.messageCount,
        identity: prev.identity ?? row.identity,
      });
    }
  }
  return order.map((id) => byId.get(id)!);
}
