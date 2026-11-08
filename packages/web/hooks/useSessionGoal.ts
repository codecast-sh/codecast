// A session's goal (convex sessionGoals.ts): fed per conversation while it is
// open, read from the store. The newest row is the session's goal.
import { useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { SessionGoal } from "@codecast/shared/contracts/sessionGoal";
import { entityIdArgs, useSyncCollection } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";

const api = _api as any;

const goalSig = (g: SessionGoal) => `${g._id}|${g.status}|${g.rounds}|${g.stalls}|${g.reason ?? ""}|${g.next_step ?? ""}|${g.objective.length}|${g.created_at}`;
const newestFirst = (a: SessionGoal, b: SessionGoal) => b.created_at - a.created_at;

export function useSessionGoal(conversationId: string | undefined): SessionGoal | null {
  useSyncCollection("sessionGoals", api.sessionGoals.forConversation, entityIdArgs("conversation_id", conversationId));
  const where = useMemo(() => (g: SessionGoal) => !!conversationId && String(g.conversation_id) === conversationId, [conversationId]);
  return useCollectionRows<SessionGoal>("sessionGoals", { where, sig: goalSig, sort: newestFirst })[0] ?? null;
}
