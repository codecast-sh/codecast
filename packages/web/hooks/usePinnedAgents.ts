import { useMemo } from "react";
import { fromConvexAgentType, pinnedAgentIds, pinnedPickerOptions, type AgentClientId, type AgentPickerOption, type ConvexAgentType } from "@codecast/shared/contracts";
// Relative, not "@/": mobile reaches this file and its "@/" is a different tree.
import { useInboxStore } from "../store/inboxStore";
import { defaultAgentType, onlyHostedAgent } from "../lib/defaultAgent";

/** The viewer's own pin list (users.pinned_agents), or null when they never
 *  set one. A joined string keeps the subscription quiet across user pushes. */
function usePinKey(): string | null {
  return useInboxStore((s) => {
    const pins = (s.currentUser as { pinned_agents?: string[] } | null | undefined)?.pinned_agents;
    return pins ? pins.join(",") : null;
  });
}

function splitPins(key: string | null): string[] | null {
  return key === null ? null : key.split(",").filter(Boolean);
}

/** The agents the viewer has pinned, in registry order. */
export function usePinnedAgentIds(): AgentClientId[] {
  const key = usePinKey();
  return useMemo(() => pinnedAgentIds(splitPins(key)), [key]);
}

/** A new-conversation picker's agent row (local and hosted): the pinned
 *  agents plus `keep`, the agent already chosen. */
export function usePinnedPickerOptions(keep?: AgentClientId | null): AgentPickerOption[] {
  const key = usePinKey();
  return useMemo(() => pinnedPickerOptions(splitPins(key), keep), [key, keep]);
}

/** The viewer's default agent (lib/defaultAgent), live. */
export function useDefaultAgentType(): ConvexAgentType {
  return useInboxStore((s) => defaultAgentType(s));
}

/** True where only the hosted assistant can answer (lib/defaultAgent), live:
 *  hosted mode, or an account with no machine. */
export function useOnlyHostedAgent(): boolean {
  return useInboxStore(onlyHostedAgent);
}

/** How many of the inbox's sessions each agent ran, as "agent:count,…" so
 *  the subscription stays quiet across heartbeats. Counting walks every
 *  session on each store change, so it runs only while `active`. */
function useAgentUseKey(active: boolean): string {
  return useInboxStore((s) => {
    if (!active) return "";
    const counts = new Map<AgentClientId, number>();
    for (const row of Object.values(s.sessions)) {
      if (!row.agent_type) continue;
      const id = fromConvexAgentType(row.agent_type);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return [...counts].map(([id, n]) => `${id}:${n}`).join(",");
  });
}

/** A picker's agent options, the ones the viewer runs most first. Ties keep
 *  the given (registry) order. */
export function useAgentsByUse<T extends { id: AgentClientId }>(options: T[], active = true): T[] {
  const key = useAgentUseKey(active);
  return useMemo(() => {
    const uses = new Map(key.split(",").filter(Boolean).map((pair) => {
      const [id, n] = pair.split(":");
      return [id, Number(n)] as const;
    }));
    return [...options].sort((a, b) => (uses.get(b.id) ?? 0) - (uses.get(a.id) ?? 0));
  }, [options, key]);
}
