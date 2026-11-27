import React, { useCallback, useMemo } from "react";
import { freshReviveRequestIds, fullRowsCounts, isOwnedChildRow, isSessionHidden, resolveSubagentFilter, resolveSubagentRows, sectionHeaderCount, subagentRowsOf, useInboxStore, type ClientUI, type InboxSectionKey, type InboxSession, type PlacedInbox, type SessionDecisionItem, type SubagentActivityOf, type SubagentRow } from "../store/inboxStore";
import { dormantActivityOf } from "../lib/railActivity";
import { awaitingOkIds } from "../lib/decisionQueue";
import { withSafetyBlock } from "@codecast/shared/contracts";
import { isBlockedConversation, isCurrentBlock } from "@codecast/convex/convex/ccAccountsShared";
import { standingRoleIdOf } from "../lib/sessionIdentity";
import { CardSubagentRows, CardSubagentsLine } from "../components/inbox/SessionCardParts";

// The rail's subagents on cards (GlobalSessionPanel): which of a card's
// subagents and waiting workers it shows under the person's "Subagents on
// cards" and "Which ones" picks, as a line, short rows or nested cards, and
// what the section headers count for them.

const EMPTY_SUBAGENT_ROWS: readonly SubagentRow[] = [];

/** A nested row filed Dormant reads the rail's split, as a card of its own would (lib/railActivity). */
const nestedActivityOf = (now: number): SubagentActivityOf => (session, bucket) => dormantActivityOf(useInboxStore.getState(), session, bucket, now);

/** What the rail's stale sweep would dismiss: EVERY non-hidden session
 *  untouched since `cutoff`, minus pinned (explicit keep), snoozed or stashed
 *  ones and the one you're viewing. Read from the full session map, not the
 *  active buckets, on purpose: subagents nested under a parent are held out of
 *  those buckets, but dismissing their parent promotes them to top-level, so
 *  they must be in the dismiss set or they refill the inbox after a sweep. A
 *  child its session owns (isOwnedChildRow) is in nobody's inbox and rides its
 *  owner's card, so it is never counted; one whose wait reached the viewer is
 *  theirs, and counts. Newest first, so the borderline ones lead the review
 *  list. */
export function staleInboxSessions(sessions: Record<string, InboxSession>, activeSessionId: string | null | undefined, cutoff: number, meId: string | null | undefined): InboxSession[] {
  return Object.values(sessions)
    .filter(
      (sess) =>
        !isSessionHidden(sess) &&
        !isOwnedChildRow(sess, meId) &&
        !sess.is_pinned &&
        !sess.inbox_snoozed_until &&
        sess._id !== activeSessionId &&
        // An unstamped row is unknown, not ancient: never offer it for dismissal.
        !!sess.updated_at && sess.updated_at < cutoff,
    )
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
}

/** Sessions parked on a limit/auth/connection banner: the fleet revive
 *  banner's and the blocked pill's input, by the server selection's predicate
 *  and window (isBlockedConversation, isCurrentBlock). A session the person
 *  just told to continue or switch (a fresh revive stamp) is out at once, not
 *  on the daemon round trip; if it never resumes the stamp expires and it
 *  comes back. A child its session owns (isOwnedChildRow) rides its owner's
 *  card, in nobody's inbox, so it never counts; one whose wait reached the
 *  viewer is theirs, and counts. */
export function blockedInboxSessions(sessions: Record<string, InboxSession>, reviveRequestedAt: Record<string, number> | undefined, now: number, meId: string | null | undefined): InboxSession[] {
  const reviving = freshReviveRequestIds(reviveRequestedAt, now);
  return Object.values(sessions).filter(
    (sess) => !isSessionHidden(sess) && !isOwnedChildRow(sess, meId) && !reviving.has(sess._id) && isCurrentBlock(sess, now),
  ).map(withSafetyBlock).filter(
    (sess) => isBlockedConversation(sess.agent_type != null ? sess : { ...sess, agent_type: "claude_code" }),
  );
}

/** A section's rows up to its cap of `cards`. A row drawn under its card
 *  (`underParent`: the flat views' nested subagents) rides that card's slot,
 *  so only the others count toward `cards`; `rows` still bounds every row
 *  mounted, for the panel's global card budget. */
export function sectionWindow<T extends { _id: string }>(items: readonly T[], cards: number, rows: number, underParent: ReadonlySet<string> | null): readonly T[] {
  let n = 0;
  for (let top = 0; n < items.length && n < Math.max(cards, rows); n++) {
    if (underParent?.has(items[n]._id)) continue;
    if (top++ === cards) break;
  }
  return n === items.length ? items : items.slice(0, n);
}

export function useCardSubagents({ ui, decisions, liveKeys, placed, now, activeSessionId, onOpen }: {
  ui: ClientUI | undefined;
  decisions: Record<string, SessionDecisionItem> | undefined;
  /** The other live facts a state reads (an unconfirmed send, a revive stamp, a hosted stop): a change re-reads the states. */
  liveKeys: readonly unknown[];
  placed: Pick<PlacedInbox, "subsByParent" | "workersNeedingYouByParent" | "nestedSectionOf" | "counts">;
  now: number;
  activeSessionId: string | null | undefined;
  onOpen: (session: InboxSession, e?: React.MouseEvent) => void;
}) {
  const mode = resolveSubagentRows(ui);
  const showSubagents = mode === "full";
  const filter = resolveSubagentFilter(ui);
  const hidden = mode === "hidden";
  const { subsByParent, workersNeedingYouByParent, nestedSectionOf, counts } = placed;
  const askingIds = awaitingOkIds(decisions);
  // Each card's subagents and the workers waiting on the person, with their
  // states, as the filter keeps them, the open one always. Worked out once per
  // change to the lists, the clock, the filter, the open session or a live
  // fact a state reads, never per card per render. Hidden reads none.
  const rowsByParent = useMemo(() => {
    const out = new Map<string, SubagentRow[]>();
    if (hidden) return out;
    for (const id of new Set([...subsByParent.keys(), ...workersNeedingYouByParent.keys()])) {
      out.set(id, subagentRowsOf([...(subsByParent.get(id) ?? []), ...(workersNeedingYouByParent.get(id) ?? [])], now, filter, activeSessionId, nestedActivityOf(now)));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden, subsByParent, workersNeedingYouByParent, now, filter, activeSessionId, askingIds, ...liveKeys]);
  // The nested rows the filter keeps: what Full rows draw as cards.
  const keptSubIds = useMemo(() => {
    const ids = new Set<string>();
    for (const rows of rowsByParent.values()) for (const r of rows) ids.add(String(r.session._id));
    return ids;
  }, [rowsByParent]);
  // A set-aside bucket's cards nest their own rows (hiddenBucketTree), so
  // their rows are worked out where the open bucket draws them.
  const rowsUnder = (parent: InboxSession, bucketSubs?: readonly InboxSession[]): readonly SubagentRow[] =>
    hidden ? EMPTY_SUBAGENT_ROWS : bucketSubs ? subagentRowsOf(bucketSubs, now, filter, activeSessionId, nestedActivityOf(now)) : (rowsByParent.get(parent._id) ?? EMPTY_SUBAGENT_ROWS);
  // Whether the open session is one of these rows in Compact: its row stands
  // in for its card. A role lead's card draws no rows, so there it keeps its card.
  const openIsCompactRow = (parent: InboxSession, rows: readonly SubagentRow[]) =>
    mode === "compact" && !standingRoleIdOf(parent) && rows.some((r) => r.session._id === activeSessionId);
  // The nested cards under a card: in Full rows the ones the filter keeps,
  // otherwise only the open one, unless its Compact row stands in. Whatever
  // the mode, the open session is on the list.
  const nestedCardsOf = (parent: InboxSession, subs: readonly InboxSession[], rows: readonly SubagentRow[]) => {
    if (subs.length === 0) return subs;
    if (!showSubagents) return subs.filter((sub) => sub._id === activeSessionId && !openIsCompactRow(parent, rows));
    const kept = new Set(rows.map((r) => String(r.session._id)));
    return subs.filter((sub) => sub._id === activeSessionId || kept.has(sub._id));
  };
  // Folded and Compact rows: under a card, its subagents and the workers
  // waiting on the person, as one line or one short row each. A role lead's
  // card keeps its session count instead. Folded leaves out the open one,
  // which is on the list as a card of its own.
  const cardSubagents = (parent: InboxSession, rows: readonly SubagentRow[]) => {
    if ((mode !== "folded" && mode !== "compact") || standingRoleIdOf(parent)) return null;
    return mode === "compact"
      ? <CardSubagentRows rows={rows} activeSessionId={activeSessionId} onOpen={onOpen} />
      : <CardSubagentsLine rows={rows.some((r) => r.session._id === activeSessionId) ? rows.filter((r) => r.session._id !== activeSessionId) : rows} onOpen={onOpen} />;
  };
  // Full rows draw only the nested rows the filter keeps, so the header
  // counts only those.
  const fullCounts = useMemo(
    () => showSubagents ? fullRowsCounts({ counts, nestedSectionOf, subsByParent }, (sub) => sub._id === activeSessionId || keptSubIds.has(sub._id)) : counts,
    [showSubagents, counts, nestedSectionOf, subsByParent, keptSubIds, activeSessionId],
  );
  const countOf = (shown: InboxSession[], full: InboxSession[], key: InboxSectionKey) =>
    sectionHeaderCount(shown, full, fullCounts[key], showSubagents);
  // Compact rows in a flat view: the open subagent is listed as its own row,
  // but when its parent's card is listed too, the parent's Compact row for it
  // stands in, as in the grouped view.
  const withoutCompactOpen = useCallback((flatList: InboxSession[]) => {
    if (mode !== "compact" || !activeSessionId) return flatList;
    const listed = new Map(flatList.map((sess) => [sess._id, sess]));
    for (const [parentId, subs] of subsByParent) {
      const parent = listed.get(parentId);
      if (!parent || !subs.some((sub) => sub._id === activeSessionId)) continue;
      if (standingRoleIdOf(parent) || !(rowsByParent.get(parentId) ?? []).some((r) => r.session._id === activeSessionId)) break;
      return flatList.filter((sess) => sess._id !== activeSessionId);
    }
    return flatList;
  }, [mode, activeSessionId, subsByParent, rowsByParent]);
  return { mode, showSubagents, filter, hidden, keptSubIds, rowsUnder, nestedCardsOf, cardSubagents, countOf, withoutCompactOpen };
}
