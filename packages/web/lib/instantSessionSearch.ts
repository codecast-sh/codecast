// Instant tier: the sessions already in the local store, matched as the user
// types. The message-content search runs on the server and takes as long as it
// takes; the store holds every session the inbox has loaded, so the first
// keystroke can already answer "which session was that?" the way ⌘K does. The
// server tiers land on top of these rows later and supersede them by id.
//
// The rows carry the SAME shape searchConversations/searchConversationTitles
// return, so a surface renders one list and never branches on where a row came
// from — except to say, honestly, that content search is still running.
import { useDeferredValue, useMemo } from "react";
import { normalizeQueryQuotes, parseSessionQuery } from "@codecast/shared/search";
import { isInboxMember, personWorkState, underOwnersModel, type InboxBucket, type WorkState } from "@codecast/shared/contracts";
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
import { sessionCardTitle, sessionTitleText } from "./sessionCard";
import { matchScore, textWords } from "./mentionRanking";
import { identityLine, identityRowOf, identitySig, type IdentityPrefs, type IdentityRow } from "./sessionIdentity";
import { identityPrefsNow } from "../hooks/useIdentityPrefs";

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
  /** The workspace the session belongs to (team:<id> or user:<id>). */
  workspace?: string;
  /** Its team's name, sent when the search spans every team. */
  teamName?: string;
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
  /** What the session began as; the palette's session index carries it. */
  first_prompt?: string | null;
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
  return cleanTitle(sessionTitleText(conv));
}

// Per row object: a search re-reads the same rows on every keystroke, and a row
// that changed arrives as a new object.
// The entry also keeps the title and worn name a tier is scored on, lowered,
// so a keystroke that reaches a row re-cleans neither.
type HaystackEntry = { personify: IdentityPrefs; text: string; words?: string[]; title?: string; titleWords?: string[]; name?: string | null; nameWords?: string[] };
const _haystackCache = new WeakMap<object, HaystackEntry>();
function haystackEntry(conv: HaystackRow, personify: IdentityPrefs = identityPrefsNow()): HaystackEntry {
  const hit = _haystackCache.get(conv);
  if (hit && hit.personify === personify) return hit;
  const entry: HaystackEntry = { personify, text: buildHaystack(conv, personify) };
  _haystackCache.set(conv, entry);
  return entry;
}
function entryTitle(conv: HaystackRow, entry: HaystackEntry): string {
  return (entry.title ??= searchTitle(conv).toLowerCase());
}
function entryName(conv: HaystackRow, entry: HaystackEntry): string | null {
  if (entry.name === undefined) {
    const name = conv._id ? identityLine(identityRowOf(conv as IdentityRow), null, entry.personify).name : null;
    entry.name = name ? name.toLowerCase() : null;
  }
  return entry.name;
}
/** Builds the search entries of `rows` from `from` on, until `hasTime` says
 *  stop; returns where it stopped (rows.length when done). For warming the
 *  cache in idle time, so the first typed key ranks warm rows. */
export function warmSessionSearch(rows: readonly HaystackRow[], from: number, hasTime: () => boolean): number {
  const personify = identityPrefsNow();
  let i = from;
  for (; i < rows.length && (i % 256 !== 0 || hasTime()); i++) {
    const entry = haystackEntry(rows[i], personify);
    entryTitle(rows[i], entry);
    entryName(rows[i], entry);
  }
  return i;
}

export function sessionSearchHaystack(conv: HaystackRow): string {
  return haystackEntry(conv).text;
}
// The haystack's words, split once per row rather than on every keystroke.
function sessionSearchWords(conv: HaystackRow): string[] {
  const entry = haystackEntry(conv);
  return (entry.words ??= textWords(entry.text));
}
function buildHaystack(conv: HaystackRow, personify: IdentityPrefs): string {
  const who = conv._id ? identityLine(identityRowOf(conv as IdentityRow), null, personify) : null;
  return [
    who?.name || "",
    who?.handle || "",
    searchTitle(conv),
    conv.first_prompt || "",
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
  const facts = live && !("bucket" in live) ? live : row;
  // Under the owners model "mine" is owning it, whoever runs it.
  const mine = row.isOwn ?? (underOwnersModel(facts) ? isInboxMember(facts, meId) : !row.user_id || !meId || row.user_id === meId || !!row.owned_by_me);
  // As a person reads it: a wait its agent owner answers is working.
  const state = placed ? personWorkState(facts, placed as { bucket: InboxBucket; work_state: WorkState }) : null;
  return { state, shelf, sub: isSub(row), mine };
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
// The same rungs over a lowered text whose words are already split (cached
// per row), so scanning thousands of rows allocates nothing per row.
function nameScoreOf(lower: string, words: () => string[], q: string, tokens: string[]): number {
  if (lower.startsWith(q)) return 0;
  // matchScore is finite exactly when every typed word is inside the text.
  for (const tok of tokens) if (!lower.includes(tok)) return Infinity;
  const ws = words();
  for (const tok of tokens) if (!startsSomeWord(ws, tok)) return 2;
  return 1;
}
function startsSomeWord(words: string[], tok: string): boolean {
  for (const w of words) if (w.startsWith(tok)) return true;
  return false;
}

/** 0: title or worn name starts with the typed words, or each starts one of
 *  its words · 1: contains them · 2: each typed word starts a word of a
 *  secondary field (a summary, a path) · 3: only inside a secondary word
 *  ("dent" in "identified") · null: no match. An empty query is tier 0. */
export function sessionMatchTier(conv: HaystackRow & { title?: string }, lowerQuery: string): { tier: 0 | 1 | 2 | 3; exact: number } | null {
  const q = lowerQuery.trim();
  if (!q) return { tier: 0, exact: 0 };
  return matchTier(conv, q, q.split(/\s+/));
}

// sessionMatchTier with the query already trimmed and split, for a scan that
// tests one query against thousands of rows. `weakTierCannotRank` says the
// caller has no use for a tier 2 or 3 hit (its list is full of better ones):
// the hit then answers tier 3 without the per-word check.
function matchTier(conv: HaystackRow, q: string, tokens: string[], personify?: IdentityPrefs, weakTierCannotRank?: () => boolean): { tier: 0 | 1 | 2 | 3; exact: number } | null {
  // The cached haystack holds the title and the worn name, so a typed word
  // absent from it rules out every tier. This cheap reject is what lets a
  // search scan the whole cache rather than only its most recent rows.
  const entry = haystackEntry(conv, personify);
  const hay = entry.text;
  for (const tok of tokens) if (!hay.includes(tok)) return null;
  const name = entryName(conv, entry);
  const title = entryTitle(conv, entry);
  const titleScore = nameScoreOf(title, () => (entry.titleWords ??= textWords(title)), q, tokens);
  const best = titleScore === 0 || !name ? titleScore : Math.min(titleScore, nameScoreOf(name, () => (entry.nameWords ??= textWords(name)), q, tokens));
  if (best <= 1) return { tier: 0, exact: best };
  if (best !== Infinity) return { tier: 1, exact: 0 };
  if (weakTierCannotRank?.()) return WEAK_UNRANKED;
  // Every typed word is somewhere in what the session is about (the reject
  // above): starting a word there, or only inside one.
  const words = (entry.words ??= textWords(hay));
  for (const tok of tokens) if (!startsSomeWord(words, tok)) return { tier: 3, exact: 0 };
  return { tier: 2, exact: 0 };
}
const WEAK_UNRANKED = { tier: 3 as const, exact: 0 };

/** Hits this many or more at a stronger tier leave the mid-word ones out. */
const WEAK_HIT_CUTOFF = 3;

/** `ranked` without its mid-word hits (tier 3) when enough stronger ones
 *  answer the query, so "dent" finds the dentist and not every summary that
 *  says "identified". */
export function dropWeakHits<T extends { tier: number }>(ranked: T[]): T[] {
  const strong = ranked.filter((r) => r.tier < 3);
  return strong.length >= WEAK_HIT_CUTOFF ? strong : ranked;
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

/** What one ranking scan matched (rankSessions' `out`). */
export type SessionScan<T> = { q: string; matched: T[]; complete: boolean };

/** The rows a query must scan, given the last scan over the same pool: a
 *  query that extends a fully scanned one ("sync r" after "sync") can only
 *  match rows that one matched, since every typed word must appear in a
 *  row's haystack. */
export function narrowSessionScan<T>(pool: readonly T[], lowerQuery: string, last: (SessionScan<T> & { pool: readonly T[] }) | null): readonly T[] {
  const q = lowerQuery.trim();
  return last && last.pool === pool && last.complete && last.q && q.startsWith(last.q) ? last.matched : pool;
}

/** The most a row's standing can lift it (STATE_LIFT's largest), so a bound
 *  on its score from its age alone. */
const MAX_LIFT = Math.max(...Object.values(STATE_LIFT));

/** Match and rank rows best first, keeping at most `cap`. Rows given newest
 *  first (`newestFirst`) stop the scan once a row's age alone ranks it below
 *  every row kept: every later row is older still, so the answer is the same
 *  as a full scan's. */
export function rankSessions<T extends HaystackRow & { title?: string; updated_at?: number }>(
  rows: Iterable<T>,
  lowerQuery: string,
  standingOf: (row: T) => SessionStanding,
  cap: number,
  now = Date.now(),
  opts: {
    newestFirst?: boolean;
    /** Filled with every row that matched, in scan order, and whether the
     *  scan saw every row (an early stop leaves it partial). A later query
     *  that extends this one can rank these rows alone (narrowSessionScan). */
    out?: SessionScan<T>;
  } = {},
): T[] {
  const q = lowerQuery.trim();
  const tokens = q ? q.split(/\s+/) : [];
  const personify = identityPrefsNow();
  const out = opts.out;
  if (out) { out.q = q; out.matched = []; out.complete = true; }
  // The best `cap` rows of all hits and of the strong ones (tier < 3), worst
  // last; dropWeakHits chooses between them by how many strong hits there are.
  type Hit = { row: T; score: number; tier: number; at: number };
  const all: Hit[] = [];
  const strong: Hit[] = [];
  let strongCount = 0;
  const before = (a: Hit, b: Hit) => a.score < b.score || (a.score === b.score && a.at > b.at);
  const keep = (top: Hit[], hit: Hit) => {
    if (top.length === cap && !before(hit, top[cap - 1])) return;
    let i = top.length < cap ? top.length : cap - 1;
    while (i > 0 && before(hit, top[i - 1])) { top[i] = top[i - 1]; i--; }
    top[i] = hit;
  };
  const bound = (top: Hit[], floor: number) => top.length === cap && top[cap - 1].score <= floor;
  for (const row of rows) {
    const at = row.updated_at ?? 0;
    if (opts.newestFirst && cap > 0) {
      const floor = Math.log2(1 + Math.max(0, now - at) / 3_600_000) - MAX_LIFT;
      if (bound(strong, floor) && (strongCount >= WEAK_HIT_CUTOFF || bound(all, floor))) {
        if (out) out.complete = false;
        break;
      }
    }
    // A tier 2 or 3 hit scores at least 2 * TIER_SPAN plus its age's floor;
    // once the strong list is full of better rows it cannot place, so it
    // skips the per-word check (its weak tier is only kept for narrowing).
    const weakCannotRank = () => bound(strong, 2 * TIER_SPAN + Math.log2(1 + Math.max(0, now - at) / 3_600_000) - MAX_LIFT);
    const match = q ? matchTier(row, q, tokens, personify, weakCannotRank) : { tier: 0 as const, exact: 0 };
    if (match === WEAK_UNRANKED) { out?.matched.push(row); continue; }
    if (!match) continue;
    out?.matched.push(row);
    const hit = { row, tier: match.tier, at, score: sessionRankScore(match, standingOf(row), at, now) };
    keep(all, hit);
    if (hit.tier < 3) { strongCount++; keep(strong, hit); }
  }
  return (strongCount >= WEAK_HIT_CUTOFF ? strong : all).map((h) => h.row);
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
  // Cached fields are matched word by word, so a "quoted phrase" is its words.
  const q = normalizeQueryQuotes(query).replace(/"/g, " ").trim().replace(/\s+/g, " ").toLowerCase();
  if (q.length < 2) return [];
  const meId = state.currentUser?._id?.toString?.() ?? null;

  const now = Date.now();
  const ranked: Array<{ row: SessionSearchRow; rank: number; tier: number }> = [];
  for (const conv of Object.values(filterInboxScopeFromState(state))) {
    if (conv.is_subagent) continue;
    if (opts.mineOnly && meId && conv.user_id && conv.user_id !== meId) continue;
    const match = sessionMatchTier(conv, q);
    if (!match) continue;
    const title = sessionCardTitle(conv);
    ranked.push({
      tier: match.tier,
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
  const kept = dropWeakHits(ranked);
  kept.sort((a, b) => a.rank - b.rank || b.row.updatedAt - a.row.updatedAt);
  return kept.slice(0, cap).map((r) => r.row);
}

/**
 * Instant rows for a query, live off the store. Inactive (short query) costs
 * nothing: the selector returns a constant, so neither the signature pass nor a
 * re-render happens while the search is closed.
 */
export function useInstantSessionRows(typed: string, cap = 12, opts: InstantSearchOpts = {}): SessionSearchRow[] {
  // Matching scans every cached session, so it runs on a deferred copy of
  // the query: the box takes each key at once and the scan re-runs in a
  // background render the next key interrupts.
  const query = useDeferredValue(typed);
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
