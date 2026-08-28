import { useCallback, useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { MentionItem } from "../components/editor/MentionList";
import { memberHandle } from "@codecast/shared/chat";
import { useInboxStore, convBucketMap, isConvexId } from "../store/inboxStore";
import type { BucketItem, BucketAssignmentItem } from "../store/inboxStore";
import { useDebounce } from "./useDebounce";
import { inActiveWorkspace } from "../lib/workspaceScope";

export type MentionScope =
  | { kind: "team"; teamId: string }
  | { kind: "personal"; userId: string }
  | { kind: "any" };

const RECENT_LIMIT_PER_TYPE = 6;
const SEARCH_LIMIT_PER_TYPE = 12;

function inScope(item: { team_id?: string | null; user_id?: string | null }, scope: MentionScope): boolean {
  if (scope.kind === "any") return true;
  if (scope.kind === "team") return inActiveWorkspace(item, scope.teamId);
  return inActiveWorkspace(item, null) && (item.user_id ? String(item.user_id) === scope.userId : true);
}

const EMPTY_SERVER_ITEMS: MentionItem[] = [];

// People are fully covered by the local roster cache; these are the types whose
// cache is windowed and therefore worth re-querying server-side on @-mention.
export const SERVER_MENTION_TYPES = ["session", "task", "doc", "plan"];

/** Scope for a surface tied to a specific entity/conversation workspace. */
export function mentionScopeFor(
  teamId: string | null | undefined,
  userId: string | null | undefined,
): MentionScope {
  if (teamId) return { kind: "team", teamId: String(teamId) };
  if (userId) return { kind: "personal", userId: String(userId) };
  return { kind: "any" };
}

/**
 * The ACTIVE workspace as a mention scope. Mentions follow the same strict
 * boundary as every other list (lib/workspaceScope): in a team space the @
 * popover offers only that team's items; in the personal space only teamless
 * ones. Generic surfaces (doc editors, create modals, the vault) use this;
 * the conversation composer scopes to its conversation's workspace instead.
 */
export function useActiveMentionScope(): MentionScope {
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id);
  const userId = useInboxStore((s) => s.currentUser?._id);
  return useMemo(
    () => mentionScopeFor(activeTeamId ? String(activeTeamId) : null, userId ? String(userId) : null),
    [activeTeamId, userId],
  );
}

/**
 * Debounced server-side mention lookup that reaches past the local cache —
 * sessions older than the inbox sync window, entities never pulled down.
 * Pass `null` while the dropdown is closed to fully disable it. `loading`
 * covers both the debounce settling and the in-flight query, so callers can
 * show a "searching" affordance from the first keystroke.
 */
export function useMentionServerSearch(
  rawQuery: string | null,
  opts?: { teamId?: string | null; types?: string[] },
): { items: MentionItem[]; loading: boolean } {
  const current = (rawQuery ?? "").trim();
  const debounced = useDebounce(current, 250);
  const wantNow = rawQuery != null && current.length >= 2;
  const settled = debounced === current;
  // A just-created team scope carries an optimistic stub id until the server
  // echoes; a stub is not an Id<"teams">. Skip rather than fall back to
  // personal, which would leak personal items into a team surface.
  const stubTeam = !!opts?.teamId && !isConvexId(String(opts.teamId));
  const results = useQuery(
    api.docs.mentionSearch,
    wantNow && settled && !stubTeam
      ? {
          query: current,
          // Explicit workspace either way: without it the server falls back to
          // the active team, which would leak team items into personal surfaces.
          workspace: opts?.teamId ? ("team" as const) : ("personal" as const),
          ...(opts?.teamId ? { teamId: opts.teamId } : {}),
          ...(opts?.types ? { types: opts.types } : {}),
        }
      : "skip",
  ) as MentionItem[] | undefined;
  // Convex full-text search ORs the terms and prefix-matches the last one, so
  // a phrase like "jasonbenn lets do" returns every title with a "do…" word.
  // Hold server rows to the same every-word rule the local cache uses, so a
  // mention that has drifted into prose settles on zero matches instead of a
  // dropdown full of strangers.
  const items = useMemo(
    () => (wantNow && settled && results ? results.filter((m) => mentionItemMatches(m, current)) : EMPTY_SERVER_ITEMS),
    [wantNow, settled, results, current],
  );
  return {
    items,
    loading: wantNow && !stubTeam && (!settled || results === undefined),
  };
}

// Labels (inbox buckets) as mention items. They're the user's personal filing —
// always theirs, so team scope doesn't narrow them (like people, they come from
// a local roster). Shared by every mention source: the hook below and
// ConversationView's buildMentionItems (which feeds the conversation and
// new-session composers).
export function labelMentionItems(s: {
  buckets?: Record<string, BucketItem>;
  bucketAssignments?: Record<string, BucketAssignmentItem>;
}): MentionItem[] {
  const counts = new Map<string, number>();
  for (const bucketId of Object.values(convBucketMap(s.bucketAssignments || {}))) {
    if (bucketId) counts.set(bucketId, (counts.get(bucketId) ?? 0) + 1);
  }
  return Object.values(s.buckets || {})
    .filter((b) => !b.archived_at)
    .map((b) => {
      const n = counts.get(String(b._id)) ?? 0;
      return {
        id: String(b._id),
        type: "label",
        label: b.name,
        sublabel: `${n} session${n === 1 ? "" : "s"}`,
        shortId: `label:${b._id}`,
        updatedAt: b.updated_at || 0,
      };
    });
}

export function score(label: string, q: string): number {
  const l = label.toLowerCase();
  if (l === q) return 0;
  if (l.startsWith(q)) return 1;
  const idx = l.indexOf(q);
  return idx === -1 ? Infinity : 2 + idx;
}

// Multi-word query support. A single-word query falls straight through to
// score() so existing ranking is byte-for-byte unchanged. A query with spaces
// is split into words, and EVERY word must match some word in the text (as an
// exact/prefix/substring hit), order-independent — so "plain road" finds
// "...The Roadmap, in Plain Language". Returns Infinity when any required word
// is absent, so callers drop the candidate exactly as they do for score().
export function matchScore(text: string, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length <= 1) return score(text, q);
  const lower = text.toLowerCase();
  const words = lower.split(/[\s\-—,.;:/\\]+/).filter(Boolean);
  let total = 0;
  for (const tok of tokens) {
    let best = Infinity;
    for (const w of words) {
      if (w === tok) { best = 0; break; }
      if (w.startsWith(tok)) best = Math.min(best, 1);
      else if (w.includes(tok)) best = Math.min(best, 2);
    }
    if (best === Infinity) {
      if (lower.includes(tok)) best = 3; // spans a word boundary; still a hit
      else return Infinity; // a required word is absent → not a match
    }
    total += best;
  }
  return total;
}

// The one predicate every mention surface filters by: a query hits an item
// through its label, its sublabel (handle, path, project), its short id, or a
// session's idle summary. Empty query matches everything.
export function mentionItemMatches(m: MentionItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    matchScore(m.label, q) !== Infinity ||
    (!!m.shortId && m.shortId.toLowerCase().includes(q)) ||
    (!!m.sublabel && matchScore(m.sublabel, q) !== Infinity) ||
    (!!m.idleSummary && matchScore(m.idleSummary, q) !== Infinity)
  );
}

export function useMentionQuery(scope: MentionScope = { kind: "any" }) {
  const getStore = useInboxStore.getState;
  const scopeKey = scope.kind === "team"
    ? `team:${scope.teamId}`
    : scope.kind === "personal"
      ? `personal:${scope.userId}`
      : "any";

  return useCallback(async (rawQ: string): Promise<MentionItem[]> => {
    const q = rawQ.trim().toLowerCase();
    const s = getStore();
    const idx = s.mentionIndex || { tasks: {}, docs: {}, plans: {} };

    // The index is a 50-row cross-team window (webMentionList caps 25 per team
    // and stops at 50, so a third team can miss it entirely). The store's own
    // collections hold the ACTIVE workspace in full — the same source the
    // session rows below already read. Union them, store row winning: it is
    // fresher and carries local-first edits.
    const merged = (windowRows: Record<string, any>, storeRows: Record<string, any> | undefined) => {
      const out = new Map<string, any>();
      for (const r of Object.values(windowRows)) if (r?._id) out.set(String(r._id), r);
      for (const r of Object.values(storeRows || {})) if (r?._id && r?.title) out.set(String(r._id), r);
      return out.values();
    };

    const taskItems: Array<{ item: MentionItem; rank: number; updated: number }> = [];
    for (const t of merged(idx.tasks, s.tasks)) {
      if (!inScope(t, scope)) continue;
      const r = q ? matchScore(t.title || "", q) : 0;
      if (q && r === Infinity) {
        if (!t.short_id?.toLowerCase().includes(q)) continue;
      }
      taskItems.push({
        item: {
          id: t._id,
          type: "task",
          label: t.title,
          sublabel: t.short_id,
          shortId: t.short_id,
          status: t.status,
          priority: t.priority,
        },
        rank: r === Infinity ? 99 : r,
        updated: t.updated_at || 0,
      });
    }

    const docItems: Array<{ item: MentionItem; rank: number; updated: number }> = [];
    for (const d of merged(idx.docs, s.docs)) {
      if (!inScope(d, scope)) continue;
      const r = q ? matchScore(d.title || "", q) : 0;
      if (q && r === Infinity) continue;
      docItems.push({
        item: {
          id: d._id,
          type: "doc",
          label: d.title,
          sublabel: d.doc_type || "note",
          docType: d.doc_type,
        },
        rank: r === Infinity ? 99 : r,
        updated: d.updated_at || 0,
      });
    }

    const planItems: Array<{ item: MentionItem; rank: number; updated: number }> = [];
    for (const p of merged(idx.plans, s.plans)) {
      if (!inScope(p, scope)) continue;
      const labelHit = q ? matchScore(p.title || "", q) : 0;
      const goalHit = q && p.goal ? matchScore(p.goal, q) : Infinity;
      const r = Math.min(labelHit, goalHit);
      if (q && r === Infinity) {
        if (!p.short_id?.toLowerCase().includes(q)) continue;
      }
      planItems.push({
        item: {
          id: p._id,
          type: "plan",
          label: p.title,
          sublabel: p.short_id,
          shortId: p.short_id,
          status: p.status,
          goal: p.goal,
        },
        rank: r === Infinity ? 99 : r,
        updated: p.updated_at || 0,
      });
    }

    const sessionItems: Array<{ item: MentionItem; rank: number; updated: number }> = [];
    for (const sess of Object.values(s.sessions)) {
      if (!inScope(sess, scope)) continue;
      const titleHit = q ? matchScore(sess.title || "", q) : 0;
      const summaryHit = q && sess.idle_summary ? matchScore(sess.idle_summary, q) : Infinity;
      const r = Math.min(titleHit, summaryHit);
      if (q && r === Infinity) continue;
      sessionItems.push({
        item: {
          id: sess._id,
          type: "session",
          label: sess.title || "Untitled Session",
          sublabel: sess.idle_summary?.slice(0, 80) || undefined,
          // cc id (`jx…`), the 7-char prefix of _id — see ConversationView mention builder.
          shortId: sess._id.slice(0, 7).toLowerCase(),
          messageCount: sess.message_count,
          projectPath: sess.project_path,
          status: sess.agent_status,
          agentType: sess.agent_type,
          updatedAt: sess.updated_at,
          idleSummary: sess.idle_summary,
        },
        rank: r === Infinity ? 99 : r,
        updated: sess.updated_at || 0,
      });
    }

    const labelItems: Array<{ item: MentionItem; rank: number; updated: number }> = [];
    for (const item of labelMentionItems(s)) {
      const r = q ? matchScore(item.label, q) : 0;
      if (q && r === Infinity) continue;
      labelItems.push({ item, rank: r, updated: item.updatedAt || 0 });
    }

    const personItems: Array<{ item: MentionItem; rank: number; updated: number }> = [];
    for (const m of s.teamMembers || []) {
      const name = (m.name || "").toLowerCase();
      const username = (m.github_username || "").toLowerCase();
      // The handle chat's server resolves (github → email local → bot name
      // slug). Carried on the item so a chat composer can insert something a
      // send will actually honour — the display label is not addressable.
      const handle = memberHandle(m) ?? undefined;
      if (q && !name.includes(q) && !username.includes(q) && !(handle ?? "").includes(q)) continue;
      personItems.push({
        item: {
          id: String(m._id),
          type: "person",
          label: m.name || m.github_username || "Unknown",
          sublabel: m.github_username ? `@${m.github_username}` : handle ? `@${handle}` : m.email,
          image: m.image || m.github_avatar_url,
          shortId: m.github_username ? `@${m.github_username}` : undefined,
          handle,
          isBot: !!m.is_bot,
        },
        rank: 0,
        updated: 0,
      });
    }

    const limit = q ? SEARCH_LIMIT_PER_TYPE : RECENT_LIMIT_PER_TYPE;
    const sortAndTake = (arr: typeof taskItems) =>
      arr
        .sort((a, b) => a.rank - b.rank || b.updated - a.updated)
        .slice(0, limit)
        .map((x) => x.item);

    return [
      ...sortAndTake(personItems),
      ...sortAndTake(labelItems),
      ...sortAndTake(sessionItems),
      ...sortAndTake(taskItems),
      ...sortAndTake(docItems),
      ...sortAndTake(planItems),
    ];
  }, [getStore, scopeKey]);
}
