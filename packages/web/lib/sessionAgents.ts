// One of a session's agents as the agents band (web) and the agents list
// (phone) read it under the owners model: the state a person reads from the
// daemon's raw status, and its owners from the one owners home
// (store sessionOwners, fed for the agents shown by the visible-cards feeder),
// falling back to the agents read's own list until that arrives.
import type { SessionStatus } from "./sessionStatus";
import { ownerFactsOf, ownerIdsOf, ownersReadOf } from "../store/sessionOwnersSlice";

export type SessionAgentRow = {
  _id: string;
  short_id: string;
  title: string | null;
  agent_status: string | null;
  owned_by_parent: boolean;
  owners: Array<{ _id: string; name: string | null; image: string | null }>;
};

export function agentStateOf(status: string | null): SessionStatus {
  switch (status) {
    case "working": case "thinking": case "compacting": case "connected": return "working";
    case "starting": case "resuming": return "starting";
    case "permission_blocked": return "needs_you";
    case "waiting": case "dormant": case "hibernated": return "dormant";
    case "done": return "done";
    default: return "idle";
  }
}

/** An agent's owners: whether the parent session still owns it, and its people. */
export function agentOwnersOf(s: Parameters<typeof ownerIdsOf>[0], parentId: string, agent: SessionAgentRow): { ownedByParent: boolean; people: Array<{ _id: string; name: string; image?: string }> } {
  const ids = ownerIdsOf(s, agent._id);
  const facts = ownerFactsOf(s, agent._id);
  if (!ids || !facts) return { ownedByParent: agent.owned_by_parent, people: agent.owners.map((o) => ({ _id: o._id, name: o.name ?? "Teammate", image: o.image ?? undefined })) };
  const read = ownersReadOf(s, agent._id)!;
  return {
    ownedByParent: String(facts.parent_conversation_id ?? "") === parentId,
    people: ids.map((id) => {
      const info = read.people_info[id] ?? agent.owners.find((o) => o._id === id);
      return { _id: id, name: (info as any)?.name ?? "Teammate", image: (info as any)?.image ?? undefined };
    }),
  };
}

/** What a band draws of its agents, as one string: its wake signature. */
export function agentsSig(s: any, parentId: string): string {
  const agents: SessionAgentRow[] = s.sessionAgents?.[parentId]?.agents ?? [];
  return agents.map((a) => {
    const o = agentOwnersOf(s, parentId, a);
    return `${a._id}:${a.title ?? ""}:${a.agent_status ?? ""}:${o.ownedByParent ? 1 : 0}:${o.people.map((p) => `${p._id}=${p.name}`).join(",")}`;
  }).join("|");
}
