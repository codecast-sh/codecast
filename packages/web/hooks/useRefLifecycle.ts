// A pull request or commit reference as a change (docs/architecture/changes.md
// CH4): the lifecycle its pill draws after its name, the same track and word
// the Branches grid gives it. A merged pull request and a commit read how far
// they have gone from deploy reach (deploys.md DP16), which this feeds. Relative
// imports only: the phone's pill reads a reference through it too.
import { useMemo } from "react";
import { useInboxStore } from "../store/inboxStore";
import { useDeployReach, type DeployReachRow } from "./useDeployReach";
import { repoObjectRefOf } from "../lib/repoObjects";
import { changeLifecycle, type ChangeFacts, type Lifecycle } from "../lib/changes/lifecycle";
import { isMerged, pullRequestFacts } from "../lib/changes/pullRequest";
import { prPillLook, type PrPillLook } from "../lib/changes/prPill";

/**
 * The lifecycle of a `pr` or `commit` entity row, or null when there is nothing to say yet: a commit says only where it
 * stands in production, so it draws nothing until its reach is read, and nothing when no target deploys it. With
 * `reach: false` (a bare pill on a card) nothing reads deploys, and a merged pull request reads as landed.
 */
export function useRefLifecycle(type: string | null | undefined, entity: any, { reach: readReach = true } = {}): Lifecycle | null {
  const isPr = type === "pr" && !!entity;
  const isCommit = type === "commit" && !!entity;
  const reachRef = !readReach ? null : isPr ? (isMerged(entity) ? repoObjectRefOf("pr", entity, 40) : null) : isCommit ? repoObjectRefOf("commit", entity, 40) : null;
  useDeployReach(reachRef);
  // The row itself, so a question not answered yet tells apart from an answer of "no target".
  const row = useInboxStore((s) => (reachRef ? (s.deployReach?.[reachRef] as DeployReachRow | undefined) : undefined));
  return useMemo(() => {
    const reach = row?.targets?.length ? row : null;
    if (isPr) {
      const facts: ChangeFacts = {
        vehicle: { kind: "pr", number: entity.number, branch: entity.head_ref ?? null, title: entity.title ?? null },
        work: { uncommitted: 0, ahead: null, pushed: true, writers: [] },
        ...pullRequestFacts(entity),
        ...(reachRef ? (row ? { reach } : { reach_pending: true }) : {}),
      };
      return changeLifecycle(facts);
    }
    if (isCommit && reach) {
      return changeLifecycle({
        vehicle: { kind: "commit", sha: entity.sha, branch: entity.branch ?? null },
        land: { state: "landed", how: "pushed", sha: entity.sha },
        reach,
      });
    }
    return null;
  }, [isPr, isCommit, entity, reachRef, row]);
}

/** A pull request pill's look (lib/changes/prPill): its glyph, whether it has settled, and whether something broke. */
export function usePrPillLook(entity: any, { reach = true } = {}): PrPillLook | null {
  const lifecycle = useRefLifecycle("pr", entity, { reach });
  return entity ? prPillLook(entity, lifecycle) : null;
}
