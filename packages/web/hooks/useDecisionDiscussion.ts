import { useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useSyncCollection } from "./useSyncCollection";
import { discussionThread } from "../lib/decisionDiscussion";

const api = _api as any;

// A decision's discussion: the per-view feeder (decisionDiscussion.discussion
// into the decisionDiscussions collection) and the thread read from the store,
// local echoes included. `enabled: false` mounts nothing, for a card that has
// not been opened and has never been discussed.
export function useDecisionDiscussion(decisionId: string, enabled = true) {
  const { ready } = useSyncCollection(
    "decisionDiscussions",
    api.decisionDiscussion.discussion,
    enabled ? { decision_id: decisionId } : "skip",
    { select: (row: any) => (row ? [row] : []) },
  );
  const row = useInboxStore((s) => s.decisionDiscussions[decisionId]);
  const sends = useInboxStore((s) => s.discussionSends[decisionId]);
  const thread = useMemo(() => discussionThread(row, sends), [row, sends]);
  return { ready, owner: row?.owner ?? null, thread };
}
