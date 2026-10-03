import { useMemo } from "react";
import { pinnedAgentIds, pinnedLaunchOptions, type AgentClientId, type AgentLaunchOption } from "@codecast/shared/contracts";
// Relative, not "@/": mobile reaches this file and its "@/" is a different tree.
import { useInboxStore } from "../store/inboxStore";

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

/** A picker's agent row: the pinned agents plus `keep`, the agent already in use. */
export function usePinnedLaunchOptions(keep?: AgentClientId | null): AgentLaunchOption[] {
  const key = usePinKey();
  return useMemo(() => pinnedLaunchOptions(splitPins(key), keep), [key, keep]);
}
