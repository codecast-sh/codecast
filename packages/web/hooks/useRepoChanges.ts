// Every change on a repository, each with its lifecycle (docs/architecture/
// changes.md), for the chips the branches, deploys and pipeline pages and a
// message's branch reference draw. Mounts the feeders the pages already mount
// (checkouts, deploy targets, the repository's pull requests; GitHub's branch
// list only when asked), reads the store, and assembles (lib/changes/assemble).
// A landed change's reach is read from the store's deployReach rows; the row
// that draws a change feeds and pins its own with useChangeReach, so a chip
// nobody draws costs no subscription.
import type { RepoChangeRows } from "../lib/changes/assemble";
import { useMemo } from "react";
import type { CheckoutRow } from "@codecast/shared/contracts/checkouts";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { activeTeamIdOf } from "../lib/activeTeam";
import { joinPullRequestDetail, type PullRequestDetailRow } from "../lib/detailRows";
import { assemble, findChange, withReach, type AssembledChange, type ChangePullRequest } from "../lib/changes/assemble";
import { changeLifecycle, type Lifecycle } from "../lib/changes/lifecycle";
import { useCheckouts, useSyncCheckouts } from "./useSyncCheckouts";
import { useDeployTargets } from "./useSyncDeployTargets";
import { useSyncPullRequests } from "./useSyncTimeline";
import { useCollectionRows } from "./useCollectionRows";
import { useCoarseNow } from "./useCoarseNow";
import { useDeployReach, type DeployReachRow } from "./useDeployReach";

export type RepoChange = AssembledChange & { lifecycle: Lifecycle };

/** How many of the repository's newest pull requests are fed: enough to hold a week's merged ones and every open one touched lately. */
const PR_LIMIT = 50;

const prSig = (p: ChangePullRequest) => `${p.state}|${p.files_synced_at ?? 0}|${p.draft ? 1 : 0}|${p.auto_merge ? 1 : 0}|${p.closed_at ?? 0}|${p.head_ref ?? ""}|${p.head_sha ?? ""}|${p.checks_state ?? ""}|${p.review_decision ?? ""}|${p.mergeable_state ?? ""}|${p.merge_commit_sha ?? ""}|${p.linked_session_ids?.length ?? 0}`;
const detailSig = (d: PullRequestDetailRow) => `${d.checks_state ?? ""}|${d.checks?.length ?? 0}`;
const reachSig = (r: DeployReachRow) => `${r.state}|${r.targets?.map((t) => `${t.target}:${t.state}:${t.deploy?.short_id ?? ""}:${t.now?.short_id ?? ""}`).join(",") ?? ""}`;

type TitleRow = { title?: string | null; user_id?: string | null; owner_user_id?: string | null };
type TitleStore = { sessions: unknown; conversations: unknown };

const writerRow = (s: TitleStore, id: string) =>
  ((s.sessions as Record<string, TitleRow>)[id] ?? (s.conversations as Record<string, TitleRow>)[id]) as TitleRow | undefined;

/** A session's author and routed owner, as the viewer's store holds them. */
const ownersOfRow = (r: TitleRow | undefined) => [r?.user_id, r?.owner_user_id].filter((x): x is string => !!x).map(String);

/** The writers' titles and owners as one FNV-1a number: moves when any does, and costs no allocation on a store write. */
function titleDigest(s: TitleStore, ids: ReadonlyArray<string>): number {
  let h = 0x811c9dc5;
  for (const id of ids) {
    const r = writerRow(s, id);
    for (const t of [r?.title ?? "", r?.user_id ?? "", r?.owner_user_id ?? ""]) {
      for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193);
      h = Math.imul(h ^ 0x2c, 0x01000193);
    }
  }
  return h >>> 0;
}

const writersOf = (s: TitleStore, ids: ReadonlyArray<string>) =>
  Object.fromEntries(ids.map((id) => { const r = writerRow(s, id); return [id, { title: r?.title ?? null, owners: ownersOfRow(r) }]; }));

/** The conversations a change names, for their titles. */
function writerIds(checkouts: ReadonlyArray<CheckoutRow>, prs: ReadonlyArray<ChangePullRequest>): string {
  const ids = new Set<string>();
  for (const r of checkouts) for (const s of r.uncommitted.sessions) if (s.conversation_id) ids.add(s.conversation_id);
  for (const p of prs) for (const id of p.linked_session_ids ?? []) ids.add(String(id));
  return [...ids].sort().join(",");
}

/**
 * Every change on `repository` in flight or finished within the week, freshest first. `teamId` defaults to the active
 * team. `branches`, GitHub's branch list a page already read (the branches page): a pushed branch with commits main lacks
 * that no checkout or pull request names becomes a change of its own.
 */
export function useRepoChanges(repository: string | null | undefined, teamId?: string | null, opts?: { branches?: RepoChangeRows["branches"] }): { ready: boolean; changes: RepoChange[] } {
  const activeTeam = useInboxStore((s) => {
    const id = activeTeamIdOf(s);
    return id && isConvexId(id) ? id : null;
  });
  const team = teamId === undefined ? activeTeam : teamId;
  const repo = repository?.toLowerCase() ?? null;

  const checkoutsFeed = useSyncCheckouts(team);
  const checkouts = useCheckouts(team, repo);
  const { targets, ready: targetsReady } = useDeployTargets(team);
  const prsFeed = useSyncPullRequests(repo ? { repository: repo, limit: PR_LIMIT } : "skip");

  const prWhere = useMemo(() => (p: ChangePullRequest) => !!repo && p.repository?.toLowerCase() === repo, [repo]);
  const prRows = useCollectionRows<ChangePullRequest & { _id: string }>("pullRequests", { where: prWhere, sig: prSig });
  // Checks live on a pull request's detail row, held only for the few a person opened: laid on when present.
  const details = useCollectionRows<PullRequestDetailRow>("pullRequestDetails", { sig: detailSig });
  const prs = useMemo(() => {
    const byId = new Map(details.map((d) => [d._id, d]));
    return prRows.map((p) => joinPullRequestDetail(p, byId.get(String(p._id))));
  }, [prRows, details]);

  const ids = useMemo(() => writerIds(checkouts, prs), [checkouts, prs]);
  // A wake signature is a digest (CLAUDE.md typing budget): every store write runs this, so it hashes the writers'
  // titles into one number rather than building and comparing a long string; the titles are read when it moves.
  const idList = useMemo(() => (ids ? ids.split(",") : []), [ids]);
  const titleSig = useInboxStore((s) => titleDigest(s, idList));

  const now = useCoarseNow(60_000);
  const assembled = useMemo(() => {
    if (!repo) return [];
    const writers = writersOf(useInboxStore.getState(), idList);
    return assemble({
      repository: repo,
      now,
      checkouts,
      pullRequests: prs,
      targets: targetsReady ? targets : undefined,
      branches: opts?.branches ?? null,
      titleOf: (id) => writers[id]?.title,
      ownersOf: (id) => writers[id]?.owners,
    });
  }, [repo, now, checkouts, prs, targets, targetsReady, opts?.branches, titleSig, idList]);

  // Reach rows some surface fed (useChangeReach, a pill): read, never fed, here.
  const refsKey = assembled.map((c) => c.reach_ref).filter(Boolean).join("\n");
  const reachWhere = useMemo(() => {
    const refs = new Set(refsKey ? refsKey.split("\n") : []);
    return (r: DeployReachRow) => refs.has(r._id);
  }, [refsKey]);
  const reach = useCollectionRows<DeployReachRow>("deployReach", { where: reachWhere, sig: reachSig });

  const changes = useMemo(() => {
    const byRef = new Map(reach.filter((r) => r.targets?.length).map((r) => [r._id, r]));
    // A row with no targets is an answer (it touches none); no row is a question not answered yet.
    const read = new Set(reach.map((r) => r._id));
    return assembled.map((c) => {
      const laid = withReach(c, c.reach_ref ? byRef.get(c.reach_ref) : undefined, !c.reach_ref || read.has(c.reach_ref));
      return { ...laid, lifecycle: changeLifecycle(laid.facts) };
    });
  }, [assembled, reach, now]);

  const ready = !!repo && checkoutsFeed.ready && targetsReady && prsFeed.ready;
  return { ready, changes };
}

/** Feed and pin a landed change's reach while its row is drawn; useRepoChanges reads it back. Call it in each row. */
export function useChangeReach(reachRef: string | null | undefined): DeployReachRow | undefined {
  return useDeployReach(reachRef ?? null);
}
