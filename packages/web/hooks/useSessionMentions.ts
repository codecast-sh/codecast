import { useRef, useMemo, useCallback } from "react";
import { extractFilePaths } from "../lib/conversationProcessor";
import { resolveSessionSkills } from "../lib/sessionSkills";
import { useInboxStore } from "../store/inboxStore";
import type { MentionItem } from "../components/editor/MentionList";
import { buildMentionItems } from "./useMentionQuery";
import type { ConversationData } from "../components/conversation/types";

export function useSessionMentions({ currentUser, conversation, managedSession }: {
  currentUser: any;
  conversation: ConversationData | null | undefined;
  managedSession: { agent_status: "working" | "idle" | "permission_blocked" | "compacting" | "thinking" | "connected" | "stopped" | "starting" | "resuming" | "waiting" | "dormant" | "done" | "hibernated" | undefined; permission_mode: string | null | undefined; session_id: string; is_connected: boolean | undefined; tmux_session: string | null | undefined; team_id: string | null | undefined; } | null;
}) {
  const sessionSkills = useMemo(() => resolveSessionSkills({
    availableSkills: (currentUser as any)?.available_skills,
    projectPath: conversation?.project_path,
    agentType: conversation?.agent_type,
    messages: conversation?.messages,
  }), [currentUser, conversation?.project_path, conversation?.messages, conversation?.agent_type]);

  const sessionFilePaths = useMemo(() => {
    if (!conversation?.messages) return [];
    return extractFilePaths(conversation.messages);
  }, [conversation?.messages]);

  const mentionItemsRef = useRef<MentionItem[]>([]);
  const convTeamId = managedSession?.team_id ? String(managedSession.team_id) : null;
  // Mention items are computed lazily (on dropdown open) to avoid subscribing
  // ConversationView to s.sessions, mentionIndex, and teamMembers — those
  // change on every heartbeat and would re-render this 10K-line component.
  const refreshMentionItems = useCallback(() => {
    const state = useInboxStore.getState();
    const scope = convTeamId
      ? { kind: "team" as const, teamId: convTeamId }
      : { kind: "personal" as const, userId: String(state.currentUser?._id ?? "") };
    mentionItemsRef.current = buildMentionItems(state, scope);
  }, [convTeamId]);
  const handleMentionQuery = useCallback((_q: string) => { refreshMentionItems(); }, [refreshMentionItems]);

  return { sessionSkills, sessionFilePaths, mentionItemsRef, handleMentionQuery };
}
