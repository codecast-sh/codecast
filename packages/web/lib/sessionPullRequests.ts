// The pull requests a session links, read at render from the one home of each
// fact: the link and its tier in pullRequestSessions (the server's
// pull_request_sessions rows), the pull request's state in pullRequests. One
// index per change of either collection, shared by every card; a card
// subscribes to its own entry as a short digest, so a push that changes
// nothing it draws wakes nothing.
import { isConvexId } from "./entityLinks";
import { isSessionHidden } from "../store/inboxStore";
import { nestParentIdOf } from "@codecast/convex/convex/ccAccountsShared";
import type { ExternalEventAccent } from "./externalEvents";
import { SESSION_CARD_MAX_SESSIONS } from "@codecast/convex/convex/lib/prSessions";

export { isFullPullRequest, overlayCardPullRequests } from "./cardPullRequestRows";

export type LinkedPrState = "open" | "draft" | "merged" | "closed";
export type LinkedPrCi = "success" | "failure" | "pending" | null;
export type LinkedPrTier = "committed" | "observed";

export type LinkedPr = {
  id: string;
  repository: string;
  number: number;
  state: LinkedPrState;
  ci: LinkedPrCi;
  tier: LinkedPrTier;
  title?: string;
};

type PrRow = { _id: string; repository?: string; number?: number; state?: string; draft?: boolean; checks_state?: string; title?: string };
type LinkRow = { _id: string; pull_request_id: string; conversation_id: string; tier?: string };

type CardSession = Parameters<typeof isSessionHidden>[0] & Parameters<typeof nestParentIdOf>[0] & { _id: string; updated_at?: number; is_pinned?: boolean; inbox_killed_at?: number | null };

/** The sessions the inbox lists as cards, best first for the chip feed: pinned, then the newest of the active list, then the newest set aside (stashed, dismissed, killed: their buckets still list them, and one just set aside may still be open). Nested subagents draw no chips. */
export function rankCardSessions(sessions: Record<string, CardSession> | undefined): string[] {
  const rows = Object.values(sessions ?? {}).filter((s) => s && isConvexId(String(s._id)) && !nestParentIdOf(s));
  const aside = (s: CardSession) => (isSessionHidden(s) || !!s.inbox_killed_at ? 1 : 0);
  rows.sort((a, b) => Number(!!b.is_pinned) - Number(!!a.is_pinned) || aside(a) - aside(b) || (b.updated_at ?? 0) - (a.updated_at ?? 0));
  return rows.map((s) => String(s._id));
}

// A session joins the asked set once it ranks in the first CARD_ENTER and
// stays until it falls past CARD_LEAVE: a heartbeat that swaps two sessions at
// the edge must not change the query's arguments. Free room fills from the
// top of the ranking, so the set is as large as the cap allows.
const CARD_ENTER = SESSION_CARD_MAX_SESSIONS - 30;
const CARD_LEAVE = SESSION_CARD_MAX_SESSIONS + 40;

/** The sessions the chip feed asks about, sorted, as stable as the ranking allows. Returns `held` itself when nothing changed. */
export function stableCardIds(ranked: readonly string[], held: readonly string[]): string[] {
  const rank = new Map(ranked.map((id, i) => [id, i]));
  const next = new Set(held.filter((id) => (rank.get(id) ?? Infinity) < CARD_LEAVE));
  for (const id of ranked.slice(0, CARD_ENTER)) next.add(id);
  let ids = [...next];
  if (ids.length > SESSION_CARD_MAX_SESSIONS) {
    ids.sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity));
    ids = ids.slice(0, SESSION_CARD_MAX_SESSIONS);
  } else {
    for (const id of ranked) {
      if (ids.length >= SESSION_CARD_MAX_SESSIONS) break;
      if (!next.has(id)) { next.add(id); ids.push(id); }
    }
  }
  ids.sort();
  return ids.length === held.length && ids.every((id, i) => id === held[i]) ? (held as string[]) : ids;
}

/** How many subscriptions the inbox chip feed splits its sessions over. */
export const CARD_BUCKETS = 8;

function bucketOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  return Math.abs(h) % CARD_BUCKETS;
}

/**
 * The asked ids split into CARD_BUCKETS groups by a hash of each id, each
 * group best first by `ranked` (the server's caps cut a group from its end).
 * A group whose members are the same as before keeps its previous array, and
 * so its subscription, whatever their order now.
 */
export function cardBuckets(ids: readonly string[], prev: readonly (readonly string[])[], ranked: readonly string[] = []): string[][] {
  const rank = new Map(ranked.map((id, i) => [id, i]));
  const groups: string[][] = Array.from({ length: CARD_BUCKETS }, () => []);
  for (const id of ids) groups[bucketOf(id)].push(id);
  const members = (g: readonly string[]) => [...g].sort().join(",");
  return groups.map((g, i) => {
    const old = prev[i];
    if (old && old.length === g.length && members(old) === members(g)) return old as string[];
    return g.sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity) || (a < b ? -1 : 1));
  });
}

// Committed links first; within a tier an open pull request with failing
// checks leads, then open, draft, merged, closed.
const STATE_RANK: Record<LinkedPrState, number> = { open: 1, draft: 2, merged: 3, closed: 4 };
const rank = (p: LinkedPr) => (p.tier === "committed" ? 0 : 10) + (p.state === "open" && p.ci === "failure" ? 0 : STATE_RANK[p.state]);

function linkedPr(row: PrRow, tier: LinkedPrTier): LinkedPr | null {
  if (!row?.repository || typeof row.number !== "number") return null;
  const state: LinkedPrState = row.state === "merged" ? "merged" : row.state === "closed" ? "closed" : row.draft ? "draft" : "open";
  const ci = row.checks_state === "success" || row.checks_state === "failure" || row.checks_state === "pending" ? row.checks_state : null;
  return { id: String(row._id), repository: row.repository, number: row.number, state, ci, tier };
}

function buildIndex(links: Record<string, LinkRow> | undefined, prs: Record<string, PrRow> | undefined): Map<string, LinkedPr[]> {
  const index = new Map<string, LinkedPr[]>();
  for (const link of Object.values(links ?? {})) {
    const row = prs?.[String(link?.pull_request_id)];
    if (!row) continue;
    const pr = linkedPr(row, link.tier === "committed" ? "committed" : "observed");
    if (!pr) continue;
    const key = String(link.conversation_id);
    const list = index.get(key);
    const twin = list?.findIndex((p) => p.id === pr.id) ?? -1;
    if (!list) index.set(key, [pr]);
    else if (twin < 0) list.push(pr);
    else if (pr.tier === "committed") list[twin] = pr;
  }
  for (const list of index.values()) list.sort((a, b) => rank(a) - rank(b) || b.number - a.number);
  return index;
}

type Built = { prs: unknown; index: Map<string, LinkedPr[]>; sigs: Map<string, string> };
// Keyed on the links collection (a frozen whole per change), so two store
// snapshots read in turn never rebuild each other's index.
const built = new WeakMap<object, Built>();
const NO_LINKS = {};

function indexOf(s: PrState): Built {
  const key = s.pullRequestSessions ?? NO_LINKS;
  const hit = built.get(key);
  if (hit && hit.prs === s.pullRequests) return hit;
  const entry: Built = { prs: s.pullRequests, index: buildIndex(s.pullRequestSessions, s.pullRequests), sigs: new Map() };
  built.set(key, entry);
  return entry;
}

type PrState = { pullRequests?: Record<string, any>; pullRequestSessions?: Record<string, any> };

/** A session's linked pull requests, the ones that need something first. */
export function sessionPullRequests(s: PrState, conversationId: string | null | undefined): readonly LinkedPr[] {
  return conversationId ? indexOf(s).index.get(conversationId) ?? [] : [];
}

/** FNV-1a over a string, as a short base-36 digest. */
function digest(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** One session's linked pull requests as a short digest, "" for none: a dep for a card's subscription (a wake signature is a digest, never the rows spelled out). Titles stay out; they are read at render. */
export function sessionPullRequestsSig(s: PrState, conversationId: string | null | undefined): string {
  if (!conversationId) return "";
  const entry = indexOf(s);
  const cached = entry.sigs.get(conversationId);
  if (cached !== undefined) return cached;
  const list = entry.index.get(conversationId) ?? [];
  const sig = list.length ? `${list.length}.${digest(list.map((p) => `${p.id}|${p.state}|${p.ci ?? ""}|${p.tier}`).join(","))}` : "";
  entry.sigs.set(conversationId, sig);
  return sig;
}

/** A session's linked pull requests for drawing, each titled from the store's row when it has one. */
export function titledSessionPullRequests(s: PrState, conversationId: string | null | undefined): LinkedPr[] {
  const prs = s.pullRequests as Record<string, { title?: string }> | undefined;
  return sessionPullRequests(s, conversationId).map((p) => {
    const title = prs?.[p.id]?.title;
    return title ? { ...p, title } : p;
  });
}

export const LINKED_PR_LOOK: Record<LinkedPrState, { label: string; accent: ExternalEventAccent }> = {
  open: { label: "open", accent: "green" },
  draft: { label: "draft", accent: "muted" },
  merged: { label: "merged", accent: "violet" },
  closed: { label: "closed", accent: "muted" },
};

export const CI_WORDS: Record<Exclude<LinkedPrCi, null>, { words: string; accent: ExternalEventAccent }> = {
  success: { words: "checks passed", accent: "green" },
  failure: { words: "checks failing", accent: "red" },
  pending: { words: "checks running", accent: "yellow" },
};

/** Whether the chip draws a checks dot: only while the pull request can still change. */
export function showsCi(pr: Pick<LinkedPr, "state" | "ci">): boolean {
  return !!pr.ci && (pr.state === "open" || pr.state === "draft");
}
