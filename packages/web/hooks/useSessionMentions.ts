import { useRef, useMemo, useCallback } from "react";
import { extractFilePaths } from "../lib/conversationProcessor";
import { resolveSessionSkills } from "../lib/sessionSkills";
import { useInboxStore } from "../store/inboxStore";
import { useSyncUserSkills, useUserSkills } from "./useSyncUserSkills";
import type { MentionItem } from "../components/editor/MentionList";
import { buildMentionItems, sessionMentionTeamId } from "./useMentionQuery";
import type { ConversationData } from "../components/conversation/types";

export function useSessionMentions({ conversation, managedSession }: {
  conversation: ConversationData | null | undefined;
  managedSession: { agent_status: "working" | "idle" | "permission_blocked" | "compacting" | "thinking" | "connected" | "stopped" | "starting" | "resuming" | "waiting" | "dormant" | "done" | "hibernated" | undefined; permission_mode: string | null | undefined; session_id: string; is_connected: boolean | undefined; tmux_session: string | null | undefined; team_id: string | null | undefined; } | null;
}) {
  useSyncUserSkills();
  const availableSkills = useUserSkills();
  const sessionSkills = useMemo(() => resolveSessionSkills({
    availableSkills,
    projectPath: conversation?.project_path,
    agentType: conversation?.agent_type,
    messages: conversation?.messages,
    sideQuestions: true,
  }), [availableSkills, conversation?.project_path, conversation?.messages, conversation?.agent_type]);

  const sessionFilePaths = useMemo(() => {
    if (!conversation?.messages) return [];
    return extractFilePaths(conversation.messages);
  }, [conversation?.messages]);

  const mentionItemsRef = useRef<MentionItem[]>([]);
  const convTeamId = managedSession?.team_id ? String(managedSession.team_id) : null;
  // Mention items are computed lazily (on dropdown open) to avoid subscribing
  // ConversationView to s.sessions, mentionIndex, and teamMembers — those
  // change on every heartbeat and would re-render this 10K-line component.
  const conversationId = conversation?._id ? String(conversation._id) : "";
  const refreshMentionItems = useCallback(() => {
    const state = useInboxStore.getState();
    const teamId = convTeamId ?? sessionMentionTeamId(state, state.sessions[conversationId]);
    const scope = teamId
      ? { kind: "team" as const, teamId }
      : { kind: "personal" as const, userId: String(state.currentUser?._id ?? "") };
    mentionItemsRef.current = buildMentionItems(state, scope);
  }, [convTeamId, conversationId]);
  const handleMentionQuery = useCallback((_q: string) => { refreshMentionItems(); }, [refreshMentionItems]);

  return { sessionSkills, sessionFilePaths, mentionItemsRef, handleMentionQuery };
}
