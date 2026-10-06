import { useMemo } from "react";
import { pinnedAgentIds, pinnedPickerOptions, type AgentClientId, type AgentPickerOption, type ConvexAgentType } from "@codecast/shared/contracts";
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
