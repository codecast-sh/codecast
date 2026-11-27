// Timeline lanes (commits, pull requests) — store-fed delta overlays.
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { normalizeRepository } from "@codecast/shared/contracts";
import { useCallback, useMemo, useState } from "react";
import { useConvex } from "convex/react";
import { applyCollectionFeed, useSyncCollection, entityIdArgs } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { useCoarseNow } from "./useCoarseNow";
import { useWatchEffect } from "./useWatchEffect";
import { activeWorkspaceKeyOf } from "../lib/workspaceScope";
import { CARD_BUCKETS, cardBuckets, rankCardSessions, stableCardIds } from "../lib/sessionPullRequests";
import { isFullPullRequest, overlayCardPullRequests } from "../lib/cardPullRequestRows";
import { joinPullRequestDetail, pinDetailRows, pullRequestDetailRow, type PullRequestDetailRow } from "../lib/detailRows";
import type { OpenPr } from "../lib/deploys/board";

const api = _api as any;

export function useSyncPullRequests(args: { repository?: string; limit?: number } | "skip" = {}) {
  return useSyncCollection("pullRequests", api.pull_requests.getPRsForTimeline, args);
}

/** What an open pull request's Deploys card draws: a change to any of it redraws the column. */
const deployCardSig = (p: OpenPr) => `${p.state}|${p.title}|${p.created_at}|${p.author_github_username ?? ""}|${p.task_ids?.join(",") ?? ""}|${p.draft ? 1 : 0}|${p.checks_state ?? ""}|${p.review_decision ?? ""}|${p.mergeable_state ?? ""}|${p.behind_by ?? ""}|${p.head_ref ?? ""}`;

/**
 * Reader with its feeder: one repository's open pull requests (the Deploys page's Shipping column); null while nothing
 * is held and unread. A repository's answer holds every open PR it read (pull_requests.getPRsForTimeline), in the
 * order their rows were stored until its read budget runs out, so a row the store holds as open, stored no later than
 * the last open one the answer holds, and missing from it, has closed out of sight: it leaves rather than stand as a
 * card forever. One stored after that may only be past a cut, and stays; so does every row when the answer holds no
 * open row (another team's rows of the repository can spend the budget before any of the viewer's). A drop never
 * reaches IndexedDB (rows keyed by Convex ids are not deleted there), so the rows are drawn only once this window's
 * feeder has answered: a cached copy of a PR that closed meanwhile is never shown as open. `failed`: the read failed.
 */
export function useOpenPullRequests(repository: string | null): { prs: OpenPr[] | null; failed: boolean } {
  const repo = repository ? normalizeRepository(repository) : null;
  const isOpenHere = useMemo(() => (p: OpenPr) => !!repo && p.state === "open" && typeof p.title === "string" && typeof p.created_at === "number" && normalizeRepository(p.repository) === repo, [repo]);
  // Which repository's answer the store holds: set as the answer is applied (select runs inside the apply), so the rows
  // turn on in the same render the store changes, never a frame early on what the cache held.
  const [applied, setApplied] = useState<string | null>(null);
  const feed = useMemo(() => {
    const stored = (p: OpenPr) => (p as { _creationTime?: number })._creationTime ?? Infinity;
    let lastSent = -Infinity;
    return {
      select: (rows: OpenPr[] | null | undefined) => {
        const open = (rows ?? []).filter(isOpenHere).map(stored);
        lastSent = open.length ? Math.max(...open) : -Infinity;
        if (rows) setApplied(repo);
        return rows;
      },
      dropAbsent: (p: OpenPr) => isOpenHere(p) && stored(p) <= lastSent,
    };
  }, [isOpenHere, repo]);
  const { ready, error } = useSyncCollection("pullRequests", api.pull_requests.getPRsForTimeline, repository ? { repository } : "skip", feed);
  const rows = useCollectionRows<OpenPr>("pullRequests", { where: isOpenHere, sig: deployCardSig });
  const live = !!repo && applied === repo;
  return useMemo(() => ({ prs: live ? rows : null, failed: !ready && !!error }), [live, rows, ready, error]);
}

const commitSig = (c: any) => `${c.message}|${c.timestamp}|${c.pr_number ?? ""}|${c.conversation_id ?? ""}`;
const prSig = (p: any) => `${p.title}|${p.state}|${p.updated_at}|${p.merged_at ?? ""}|${p.linked_session_ids?.length ?? 0}`;
export const byTimestampDesc = (a: any, b: any) => (b.timestamp ?? 0) - (a.timestamp ?? 0);
const byUpdatedDesc = (a: any, b: any) => (b.updated_at ?? 0) - (a.updated_at ?? 0);

export function useCommits(where?: (c: any) => boolean): any[] {
  return useCollectionRows<any>("commits", { where, sig: commitSig, sort: byTimestampDesc });
}

// A row only the inbox's chip feed has written lacks the body and authorship
// the timeline and the PR page draw: they treat it as not loaded rather than
// paint it half empty.
const fullRow = (p: any) => isFullPullRequest(p);

export function usePullRequests(where?: (p: any) => boolean): any[] {
  const full = useMemo(() => (where ? (p: any) => fullRow(p) && where(p) : fullRow), [where]);
  return useCollectionRows<any>("pullRequests", { where: full, sig: prSig, sort: byUpdatedDesc });
}

// One PR, fed into the same collection the timeline fills. The page reads the
// store, so a PR the timeline already cached paints before this answers.
// Module-level: a fresh select per render re-applied the same payload.
const oneRow = (row: any) => (row ? [row] : []);
const ONE_ROW = { select: oneRow };

// A pull request's files, commits and checks live apart from its list row
// (lib/detailRows), in pullRequestDetails. The surfaces that draw them (its
// page, an opened diff) feed that row from the same answer that feeds the
// list row: Convex shares the subscription between the two calls.
const oneDetail = (row: any) => {
  if (!row) return [];
  const held = (useInboxStore.getState() as any).pullRequestDetails as Record<string, PullRequestDetailRow> | undefined;
  const detail = pullRequestDetailRow(row, held?.[String(row._id)], Date.now());
  return detail ? [detail] : [];
};
const ONE_DETAIL = { select: oneDetail };

/** One full pull request answer as useSyncPullRequest applies it: its detail
 *  row, then its list row. For a test that plays the server's push. */
export function applyPullRequestAnswer(row: any): void {
  applyCollectionFeed("pullRequestDetails", row, oneDetail);
  applyCollectionFeed("pullRequests", row, oneRow);
}

/** Feeder: one pull request by repository and number, its list row and its detail (the PR page). */
export function useSyncPullRequest(args: { repository: string; number: number } | "skip") {
  useSyncCollection("pullRequestDetails", api.pull_requests.getPRByNumber, args, ONE_DETAIL);
  return useSyncCollection("pullRequests", api.pull_requests.getPRByNumber, args, ONE_ROW);
}

/** What usePullRequestMerge draws from a row: one stable function, so the reader keeps its memo across renders. */
export const prMergeSig = (p: any) => `${p.state}|${p.merge_commit_sha ?? ""}`;

/** Whether GitHub merged one pull request, and as what commit: its list row only (fed here, never its detail), for a
 *  surface that says where a change stands (a change run's page). Undefined while the store holds no row. */
export function usePullRequestMerge(ref: { repository: string; number: number } | null): { merged: boolean; merge_sha: string | null } | undefined {
  useSyncCollection("pullRequests", api.pull_requests.getPRByNumber, ref ? { repository: ref.repository, number: ref.number } : "skip", ONE_ROW);
  const repository = ref ? normalizeRepository(ref.repository) : null;
  const number = ref?.number ?? null;
  const where = useMemo(() => (p: any) => !!repository && normalizeRepository(p.repository) === repository && p.number === number, [repository, number]);
  const rows = useCollectionRows<any>("pullRequests", { where, sig: prMergeSig });
  const row = rows[0];
  return useMemo(() => (row ? { merged: row.state === "merged", merge_sha: row.merge_commit_sha ?? null } : undefined), [row?.state, row?.merge_commit_sha]);
}

/** Feeder: one pull request's detail by id, for a surface that opens its diff
 *  from a row already in the store (an expanded card). Mount it only while
 *  the diff is open. */
export function useSyncPullRequestDetail(id: string | undefined) {
  return useSyncCollection("pullRequestDetails", api.pull_requests.webGet, entityIdArgs("id", id), ONE_DETAIL);
}

/** Open pull requests whose files, commits and checks each window reads ahead of any open. */
const PREFETCHED_PR_DETAILS = 20;
const prDetailRead = new Map<string, number>();
const openPrSig = (p: any) => (p?.state === "open" ? `${p.updated_at ?? 0}` : "");
const isOpenPr = (p: any) => p?.state === "open" && isConvexId(String(p._id));

/** Feeder, every window (the detail rows are per window): the newest open
 *  pull requests' details, read once per update with one-shot reads, so a PR
 *  opened from a card, the timeline or a link shows its diff at once. */
export function usePrefetchOpenPullRequestDetails(): void {
  const convex = useConvex();
  const open = useCollectionRows<any>("pullRequests", { where: isOpenPr, sig: openPrSig, sort: byUpdatedDesc });
  useWatchEffect(() => {
    const held = ((useInboxStore.getState() as any).pullRequestDetails ?? {}) as Record<string, PullRequestDetailRow>;
    const need = open.slice(0, PREFETCHED_PR_DETAILS).filter((p) => {
      const id = String(p._id);
      const at = p.updated_at ?? 0;
      if (prDetailRead.get(id) === at) return false;
      return !held[id] || ((held[id] as any)._cachedAt ?? 0) < at;
    });
    if (!need.length) return;
    let cancelled = false;
    void (async () => {
      for (const p of need) {
        if (cancelled) return;
        const id = String(p._id);
        prDetailRead.set(id, p.updated_at ?? 0);
        try {
          const row = await convex.query(api.pull_requests.webGet, { id });
          if (!cancelled && row) applyCollectionFeed("pullRequestDetails", row, oneDetail);
        } catch {
          prDetailRead.delete(id);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [convex, open]);
}

/** A pull request's files, commits and checks from the store; undefined until
 *  a surface has opened it. A mounted reader has the row on screen, so it
 *  holds it against the collection's cap (lib/detailRows pinDetailRows). */
export function usePullRequestDetail(id: string | undefined): PullRequestDetailRow | undefined {
  useWatchEffect(() => (id ? pinDetailRows("pullRequestDetails", [id]) : undefined), [id]);
  return useInboxStore((s) => (id ? ((s as any).pullRequestDetails as Record<string, PullRequestDetailRow> | undefined)?.[id] : undefined));
}

// The PR page paints far more of a row than the timeline lane does, so it wakes
// on its own signature rather than widening the lane's. The detail row wakes
// it by identity: the store keeps that row while its contents hold.
const prDetailSig = (p: any) =>
  [
    p.title, p.state, p.draft, p.updated_at, p.merged_at ?? "", p.body,
    p.head_sha ?? "", p.mergeable_state ?? "", p.behind_by ?? "", p.review_decision ?? "",
    p.checks_state ?? "", p.unresolved_review_count ?? "",
    (p.requested_reviewers ?? []).join(","), (p.linked_session_ids ?? []).join(","),
    (p.task_ids ?? []).join(","), p.changed_files ?? "",
    p.shepherd_state ?? "", p.shepherd_enabled ?? "", p.shepherd_conversation_id ?? "",
    p.shepherd_last_wake_at ?? "", p.shepherd_wake_count ?? "",
    (p.labels ?? []).map((l: any) => l.name).join(","), (p.assignees ?? []).join(","), p.commits_count ?? "",
  ].join("|");

/** One pull request as its page reads it: the list row with its files,
 *  commits and checks laid on once useSyncPullRequest has fed them. */
export function usePullRequest(repository: string, number: number): any | undefined {
  const canonicalRepository = normalizeRepository(repository);
  const where = useMemo(
    () => (p: any) => fullRow(p) && normalizeRepository(p.repository) === canonicalRepository && p.number === number,
    [canonicalRepository, number],
  );
  const rows = useCollectionRows<any>("pullRequests", { where, sig: prDetailSig });
  const row = rows[0];
  const detail = usePullRequestDetail(row?._id);
  return useMemo(() => (row ? joinPullRequestDetail(row, detail) : undefined), [row, detail]);
}

// One commit, fed into the same collection the timeline fills. Same trick as
// useSyncPullRequest: the commit page paints from whatever the timeline already
// cached, and this refreshes the row with everything the lane leaves out.
export function useSyncCommit(sha: string | undefined) {
  return useSyncCollection("commits", api.commits.getCommitBySha, sha ? { sha } : "skip", ONE_ROW);
}

// The commit page paints the whole row, files included, so it wakes on its own
// signature rather than widening the lane's.
const commitDetailSig = (c: any) =>
  [
    c.message, c.timestamp, c.branch ?? "", c.conversation_id ?? "",
    c.pr_id ?? "", c.pr_number ?? "", (c.task_ids ?? []).join(","),
    (c.files ?? []).length, c.insertions ?? "", c.deletions ?? "",
    // A fetch fills in the patches of files the row already named and counted,
    // so the page must wake on their arrival, not only on the file list.
    (c.files ?? []).filter((f: any) => f.patch !== undefined).length,
  ].join("|");

export function useCommit(sha: string | undefined): any | undefined {
  const where = useMemo(() => (c: any) => !!sha && c.sha === sha, [sha]);
  const rows = useCollectionRows<any>("commits", { where, sig: commitDetailSig });
  return rows[0];
}

// ── One conversation's commits and pull requests ──
//
// The transcript shows a commit or a pull request inline when it was made
// outside the transcript (a push the webhook linked to this session, a PR
// opened from a terminal on its branch); the ones made by a Bash call in the
// transcript already render on that call. These feeders bring the linked
// rows into the same collections the timeline lane uses, and the readers
// narrow to this conversation.

// The answer is EVERY commit linked to the conversation, but the collection is
// a delta, where a missing row means "unchanged". So a cached row that still
// names the conversation and is missing from the answer was unlinked on the
// server; it goes back in without the link, and stays for the repo and PR
// timelines that show it too.
export function detachUnlinkedCommits(answer: any[], cached: Record<string, any>, conversationId: string): any[] {
  const answered = new Set(answer.map((row) => row._id));
  const detached: any[] = [];
  for (const row of Object.values(cached)) {
    if (row?.conversation_id !== conversationId || answered.has(row._id)) continue;
    const { conversation_id: _unlinked, ...rest } = row;
    detached.push(rest);
  }
  return detached.length ? [...answer, ...detached] : answer;
}

export function useSyncConversationCommits(conversationId: string | undefined) {
  const select = useCallback(
    (answer: any) => (Array.isArray(answer) && conversationId
      ? detachUnlinkedCommits(answer, useInboxStore.getState().commits ?? {}, conversationId)
      : answer),
    [conversationId],
  );
  return useSyncCollection("commits", api.commits.getCommitsForConversation, entityIdArgs("conversation_id", conversationId), { select });
}

const selectCardPRs = (d: any) => {
  const state = useInboxStore.getState() as any;
  return overlayCardPullRequests(d?.pull_requests, state.pullRequests, state.pending);
};
const selectCardLinks = (d: any) => d?.links;
// Each answer names the sessions it is complete for; a cached link of one of
// those that the answer lacks was removed, and only those prune.
const answeredScope = (d: any) => {
  const answered = new Set<string>((d?.answered ?? []).map(String));
  return { pruneAbsentScope: (row: any) => answered.has(String(row.conversation_id)) };
};
export const LINK_OPTS = { select: selectCardLinks, syncOpts: answeredScope };
export const CARD_PR_OPTS = { select: selectCardPRs };

// The selector runs on every store write; counting thousands of keys each
// time is the cost, so the count is kept per sessions object.
const sessionCounts = new WeakMap<object, number>();
function sessionCountOf(sessions: Record<string, unknown>): number {
  let n = sessionCounts.get(sessions);
  if (n === undefined) {
    n = 0;
    for (const _ in sessions) n++;
    sessionCounts.set(sessions, n);
  }
  return n;
}

/**
 * The sessions the inbox chip feed asks about, in CARD_BUCKETS stable groups
 * by id: the inbox can list (pinned first, then newest; rankCardSessions),
 * read on a coarse clock, when a session arrives and when the workspace
 * changes. Each group is its own
 * subscription, so a new session re-runs the small query of its group, not
 * one over every card. A group keeps its array while its members do. A
 * session that leaves keeps the links it last had: they stop refreshing
 * rather than being tombstoned (each prune's exclude is a pending entry every
 * sync reads), and it is the oldest sessions that leave. Mounted once, on the
 * sync host.
 */
export function useSessionCardBuckets(): readonly (readonly string[])[] {
  const now = useCoarseNow(20_000);
  const sessionCount = useInboxStore((s) => sessionCountOf(s.sessions));
  const workspace = useInboxStore((s) => activeWorkspaceKeyOf(s as any));
  const [held, setHeld] = useState<{ ids: string[]; buckets: string[][] }>(NONE_HELD);
  useWatchEffect(() => {
    const ranked = rankCardSessions(useInboxStore.getState().sessions as any);
    const next = stableCardIds(ranked, held.ids);
    if (next === held.ids) return;
    setHeld({ ids: next, buckets: cardBuckets(next, held.buckets, ranked) });
  }, [now, sessionCount, workspace, held]);
  return held.buckets;
}

/** Feeder: one bucket of the inbox chip feed. One query, two collections: Convex shares the subscription between the calls. */
export function useSyncSessionCardBucket(ids: readonly string[]) {
  const args = useMemo(() => (ids.length ? { conversation_ids: ids } : "skip"), [ids]);
  useSyncCollection("pullRequests", api.pull_requests.sessionCardPRs, args as any, CARD_PR_OPTS);
  useSyncCollection("pullRequestSessions", api.pull_requests.sessionCardPRs, args as any, LINK_OPTS);
}

const NONE_HELD = { ids: [] as string[], buckets: Array.from({ length: CARD_BUCKETS }, () => [] as string[]) };

/** Feeder: the open conversation's pull request links, in any window, whatever the inbox list holds. */
export function useSyncConversationPullRequestLinks(conversationId: string | undefined) {
  const id = conversationId && isConvexId(conversationId) ? conversationId : null;
  const args = useMemo(() => (id ? { conversation_ids: [id] } : "skip"), [id]);
  useSyncCollection("pullRequestSessions", api.pull_requests.sessionCardPRs, args as any, LINK_OPTS);
}

export function useSyncConversationPullRequests(conversationId: string | undefined) {
  return useSyncCollection("pullRequests", api.pull_requests.getPRsForConversation, entityIdArgs("conversation_id", conversationId));
}

export function useConversationCommits(conversationId: string | undefined): any[] {
  const where = useMemo(() => (c: any) => !!conversationId && c.conversation_id === conversationId, [conversationId]);
  return useCollectionRows<any>("commits", { where, sig: commitDetailSig, sort: byTimestampDesc });
}

export function useConversationPullRequests(conversationId: string | undefined): any[] {
  const where = useMemo(
    () => (p: any) => !!conversationId && Array.isArray(p.linked_session_ids) && p.linked_session_ids.includes(conversationId),
    [conversationId],
  );
  return useCollectionRows<any>("pullRequests", { where, sig: prSig, sort: byUpdatedDesc });
}
