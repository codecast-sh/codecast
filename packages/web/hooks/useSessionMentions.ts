import { useRef, useMemo, useCallback, useState } from "react";
import { extractFilePaths } from "../lib/conversationProcessor";
import { resolveSessionSkills } from "../lib/sessionSkills";
import { useInboxStore } from "../store/inboxStore";
import { useSyncUserSkills, useUserSkills } from "./useSyncUserSkills";
import type { MentionItem } from "../components/editor/MentionList";
import { buildMentionItems, sessionMentionTeamId } from "./useMentionQuery";
import type { ConversationData, Message } from "../components/conversation/types";
import { ToolCallMemo, sameElements } from "./toolCallMemo";

/**
 * extractFilePaths over the transcript, newest first, with each tool call's
 * paths memoized: a streamed update parses only the calls it added or changed
 * (a Write or Edit input carries the whole file).
 */
export function sessionFilePathsOf(messages: readonly Message[], memo: ToolCallMemo<string[]>): string[] {
  memo.begin();
  const paths: string[] = [];
  const seen = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !msg.tool_calls) continue;
    for (const tc of msg.tool_calls) {
      const named = memo.get(tc, (call) => extractFilePaths([{ role: "assistant", tool_calls: [call] }]));
      for (const p of named) {
        if (seen.has(p)) continue;
        seen.add(p);
        paths.push(p);
      }
    }
  }
  memo.end();
  return paths;
}

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
  }), [availableSkills, conversation?.project_path, conversation?.messages, conversation?.agent_type]);

  // Same array while the paths are unchanged: it is a prop of the memoized
  // composer, which re-rendered on every streamed update.
  const [filePathsMemo] = useState(() => new ToolCallMemo<string[]>());
  const sessionFilePathsRef = useRef<string[]>([]);
  const sessionFilePaths = useMemo(() => {
    const next = conversation?.messages ? sessionFilePathsOf(conversation.messages, filePathsMemo) : [];
    if (sameElements(sessionFilePathsRef.current, next)) return sessionFilePathsRef.current;
    sessionFilePathsRef.current = next;
    return next;
  }, [conversation?.messages, filePathsMemo]);

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
