import { useInboxStore } from "../store/inboxStore";

// The rewind reads the turn boundaries the prompt hook marks and the edits the
// transcript records; Claude Code is the agent that provides both.
const REWINDABLE_AGENTS = new Set(["claude_code"]);

/**
 * Whether this viewer can rewind this conversation's files to before a message
 * sent at `messageTs`: they run it, on a machine. A fork's snapshots and edits
 * start at the fork, so a message it inherited from its parent is not offered.
 */
export function useCanRewindFiles(conversationId: string | undefined, messageTs: number): boolean {
  return useInboxStore((s) => {
    const c: any = conversationId ? s.conversations[conversationId] : null;
    const me = s.currentUser?._id;
    if (!c || !me || String(c.user_id) !== String(me) || !c.owner_device_id || !REWINDABLE_AGENTS.has(c.agent_type)) return false;
    return !c.forked_from || messageTs >= (c.started_at ?? 0);
  });
}
