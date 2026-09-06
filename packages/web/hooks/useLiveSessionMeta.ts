import { useShallow } from "zustand/react/shallow";
import { useInboxStore } from "../store/inboxStore";

/**
 * Live model/effort/agent for one conversation. Conversations win per field
 * when set; sessions fill gaps. resolveLiveSessionId follows a stub→real rekey
 * so a pick after create isn't lost. Shared by the header badge and the
 * new-session launch pill so both surfaces paint from the same row.
 */
export function useLiveSessionMeta(conversationId: string | undefined) {
  return useInboxStore(useShallow((s) => {
    if (!conversationId) return undefined;
    const id = s.resolveLiveSessionId(conversationId);
    const sess = s.sessions[id] as
      | { model?: string | null; effort?: string | null; agent_type?: string; owner_device_id?: string | null }
      | undefined;
    const conv = s.conversations[id] as
      | { model?: string | null; effort?: string | null; agent_type?: string; owner_device_id?: string | null }
      | undefined;
    if (!sess && !conv) return undefined;
    return {
      model: conv?.model !== undefined ? conv.model : sess?.model,
      effort: conv?.effort !== undefined ? conv.effort : sess?.effort,
      agentType: conv?.agent_type ?? sess?.agent_type,
      ownerDeviceId: conv?.owner_device_id ?? sess?.owner_device_id,
    };
  }));
}
