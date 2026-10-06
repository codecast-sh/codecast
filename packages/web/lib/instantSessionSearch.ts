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
import { parseSessionQuery } from "@codecast/shared/search";
import type { WorkState } from "@codecast/shared/contracts";
import {
  useInboxStore,
  filterInboxScopeFromState,
  sessionPlacement,
  isSub,
  type InboxSession,
} from "../store/inboxStore";
import { makeCollectionSig } from "../store/wakeSig";
import { isHostedAgentType } from "@codecast/shared/contracts";
import { promptTitle } from "@codecast/shared/contracts/assistant";
import { ownTitle } from "./conversationTitle";
import { cleanTitle } from "./conversationProcessor";
import { sessionCardTitle } from "./sessionCard";
import { matchScore, textWords } from "./mentionRanking";
import { identityLine, identityRowOf, identitySig, type IdentityRow } from "./sessionIdentity";
import { personifyAllNow } from "../hooks/usePersonifyAll";

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
  /** What the session began as and was called before, when that answers the
   *  query and its current title may not (server: searchCore.originMatch). */
  origin?: { started_as?: string; earlier_titles?: string[] } | null;
  /** Worker sessions that matched and are folded into this row. */
  workerCount?: number;
  /** This row came from the local cache, not from the server search. */
  instant?: boolean;
  /** The text the local match landed in (summary, project path), for a preview line. */
  instantSnippet?: string | null;
  /** Who the session is (docs/architecture/session-characters.md S1), so a
   *  result wears the same face as its inbox card. The server tiers send it
   *  too, so a row reads the same whichever tier produced it. */
  identity?: IdentityRow | null;
};

/** Everything about a cached session a typed query may reasonably name,
 *  including the name it wears (its character's or its role's), so a session
 *  is findable by the name its card leads with. */
type HaystackRow = Partial<IdentityRow> & {
  title?: string;
  agent_type?: string | null;
  last_user_message?: string | null;
  subtitle?: string;
  idle_summary?: string;
  thread_state?: string | null;
  project_path?: string;
  authorName?: string;
  author_name?: string | null;
};
/** The title a search matches: the row's own, or for a hosted conversation
 *  that has none yet, what the person asked (the title every surface shows
 *  it by, lib/conversationTitle). Never a placeholder, which would match
 *  "new". */
function searchTitle(conv: HaystackRow): string {
  if (isHostedAgentType(conv.agent_type)) return ownTitle(conv) || promptTitle(conv.last_user_message);
  return cleanTitle(conv.title || "");
}

// Per row object: a search re-reads the same rows on every keystroke, and a row
// that changed arrives as a new object.
const _haystackCache = new WeakMap<object, { personify: boolean; text: string }>();
export function sessionSearchHaystack(conv: HaystackRow): string {
  const personify = personifyAllNow();
  const hit = _haystackCache.get(conv);
  if (hit && hit.personify === personify) return hit.text;
  const text = buildHaystack(conv, personify);
  _haystackCache.set(conv, { personify, text });
  return text;
}
function buildHaystack(conv: HaystackRow, personify: boolean): string {
  const who = conv._id ? identityLine(identityRowOf(conv as IdentityRow), null, personify) : null;
  return [
    who?.name || "",
    who?.handle || "",
    searchTitle(conv),
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
export function sessionMatchesQuery(conv: HaystackRow, lowerQuery: string): boolean {
  if (!lowerQuery) return true;
  return sessionSearchHaystack(conv).includes(lowerQuery);
}

// ── Ranking ──────────────────────────────────────────────────────────────────
//
// How directly the words name a session leads, as everywhere else we rank
// (lib/mentionRanking): its title or the name it wears starting with what was
// typed, then containing it, then only a secondary field (a summary, a path,
// an author). Inside a tier, where the session stands moves it by about what a
// few doublings of age would: one that needs you or is working rises, one set
// aside, a worker under another session, or a teammate's sinks. Tiers are
// TIER_SPAN apart, so standing reorders a tier and only an old, demoted row
// falls below a fresher row of the next tier.

/** Where a session stands, for ranking and for the row's face. */
export type SessionStanding = {
  /** Who acts next; null for a row this device holds no live facts for. */
  state: WorkState | null;
  /** Set aside by the person: out of the active inbox. */
  shelf: "stashed" | "snoozed" | "dismissed" | "killed" | null;
  /** A worker under another session (Task subagent, spawned worker). */
  sub: boolean;
  mine: boolean;
};

type StandingRow = InboxSession & { isOwn?: boolean };

/** A row's standing from its inbox placement (the store row's own, or the one
 *  the inbox already placed), falling back to its triage stamps when this
 *  device holds no live row for it (a teammate's session from the server). */
export function sessionStanding(
  row: StandingRow,
  meId: string | null,
  live?: { bucket: string; work_state: WorkState } | InboxSession | null,
): SessionStanding {
  const placed = !live ? null : "bucket" in live ? live : sessionPlacement(live);
  const bucket = placed?.bucket;
  const shelf: SessionStanding["shelf"] = row.inbox_killed_at
    ? "killed"
    : bucket === "dismissed" || (!placed && row.inbox_dismissed_at)
    ? "dismissed"
    : bucket === "stashed" || (!placed && row.inbox_stashed_at)
    ? "stashed"
    : bucket === "snoozed"
    ? "snoozed"
    : null;
  const mine = row.isOwn ?? (!row.user_id || !meId || row.user_id === meId || !!row.owned_by_me);
  return { state: placed?.work_state ?? null, shelf, sub: isSub(row), mine };
}

const TIER_SPAN = 10;
const STATE_LIFT: Partial<Record<WorkState, number>> = { needs_input: 3, working: 2 };
const SHELF_COST: Record<NonNullable<SessionStanding["shelf"]>, number> = { snoozed: 2, stashed: 2.5, dismissed: 4, killed: 4 };
const SUB_COST = 4;
const TEAMMATE_COST = 1.5;

/** The state a row surfaces, for its mark and its lift: an ask or live work
 *  only, never on a row set aside, and never a worker's ask (it reports to the
 *  session above it, which is why the inbox chime stands down on it too). */
export function standingMark(standing: SessionStanding | undefined): "needs_input" | "working" | null {
  if (!standing?.state || standing.shelf) return null;
  if (standing.state === "working") return "working";
  return standing.state === "needs_input" && !standing.sub ? "needs_input" : null;
}

// How well the typed words name a text: 0 it starts with them, 1 every word
// starts some word of it, 2 every word is inside it, Infinity otherwise.
function nameScore(text: string, q: string): number {
  const lower = text.toLowerCase();
  if (lower.startsWith(q)) return 0;
  const m = matchScore(lower, q);
  if (m === Infinity) return m;
  const words = textWords(lower);
  return q.split(/\s+/).every((tok) => words.some((w) => w.startsWith(tok))) ? 1 : 2;
}

/** 0: title or worn name starts with the typed words, or each starts one of
 *  its words · 1: contains them · 2: only a secondary field does · null: no
 *  match. An empty query is tier 0. */
export function sessionMatchTier(conv: HaystackRow & { title?: string }, lowerQuery: string): { tier: 0 | 1 | 2; exact: number } | null {
  const q = lowerQuery.trim();
  if (!q) return { tier: 0, exact: 0 };
  const name = conv._id ? identityLine(identityRowOf(conv as IdentityRow), null, personifyAllNow()).name : null;
  const best = Math.min(nameScore(searchTitle(conv), q), name ? nameScore(name, q) : Infinity);
  if (best <= 1) return { tier: 0, exact: best };
  if (best !== Infinity) return { tier: 1, exact: 0 };
  // Every typed word somewhere in what the session is about, in any order.
  return matchScore(sessionSearchHaystack(conv), q) === Infinity ? null : { tier: 2, exact: 0 };
}

/** Lower sorts first. */
export function sessionRankScore(
  match: { tier: number; exact: number },
  standing: SessionStanding,
  updatedAt: number,
  now: number,
): number {
  const ageHours = Math.max(0, now - (updatedAt || 0)) / 3_600_000;
  return (
    match.tier * TIER_SPAN +
    match.exact * 0.5 +
    Math.log2(1 + ageHours) -
    (STATE_LIFT[standingMark(standing) ?? "idle"] ?? 0) +
    (standing.shelf ? SHELF_COST[standing.shelf] : 0) +
    (standing.sub ? SUB_COST : 0) +
    (standing.mine ? 0 : TEAMMATE_COST)
  );
}

/** Match and rank rows best first, keeping at most `cap`. */
export function rankSessions<T extends HaystackRow & { title?: string; updated_at?: number }>(
  rows: Iterable<T>,
  lowerQuery: string,
  standingOf: (row: T) => SessionStanding,
  cap: number,
  now = Date.now(),
): T[] {
  const ranked: Array<{ row: T; score: number }> = [];
  for (const row of rows) {
    const match = sessionMatchTier(row, lowerQuery);
    if (!match) continue;
    ranked.push({ row, score: sessionRankScore(match, standingOf(row), row.updated_at ?? 0, now) });
  }
  ranked.sort((a, b) => a.score - b.score || (b.row.updated_at ?? 0) - (a.row.updated_at ?? 0));
  return ranked.slice(0, cap).map((r) => r.row);
}

// Only the fields a match or a row's face reads (identitySig covers the name). updated_at is deliberately
// absent: it ticks with every heartbeat, and ordering a transient result list
// by a value that is seconds stale is invisible, while re-running this over
// thousands of rows on each tick is not.
export const searchableSessionsSig = makeCollectionSig<InboxSession>(
  (s) =>
    // An untitled row is matched by what was asked (searchTitle).
    `${identitySig(s as any)}|${s.title ?? (s as { last_user_message?: string }).last_user_message ?? ""}|${s.subtitle ?? ""}|${s.idle_summary ?? ""}|${s.thread_state ?? ""}|${s.project_path ?? ""}|${s.author_name ?? ""}|${s.message_count ?? 0}`,
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

  const now = Date.now();
  const ranked: Array<{ row: SessionSearchRow; rank: number }> = [];
  const pool = Object.values(filterInboxScopeFromState(state));
  const scan = pool.length > INSTANT_SCAN_CAP ? pool.slice(0, INSTANT_SCAN_CAP) : pool;
  for (const conv of scan) {
    if (conv.is_subagent) continue;
    if (opts.mineOnly && meId && conv.user_id && conv.user_id !== meId) continue;
    const match = sessionMatchTier(conv, q);
    if (!match) continue;
    const title = sessionCardTitle(conv);
    ranked.push({
      rank: sessionRankScore(match, sessionStanding(conv, meId, conv), conv.updated_at || 0, now),
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
        titleMatch: match.tier < 2,
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
  // A cached row cannot say which files, commits or pull requests its session
  // touched, so an operator query (file:, pr:, ...) has no instant answer; the
  // server tier answers it alone.
  const active = query.trim().length >= 2 && !parseSessionQuery(query).hasFilters;
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
