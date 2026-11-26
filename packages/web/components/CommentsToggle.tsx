import { memo, useMemo } from "react";
import { MessageSquare } from "lucide-react";
import { TopbarButton } from "./TopbarButton";
import { ShortcutTooltip } from "./KeyboardShortcutsHelp";
import { useTrackedStore, selectCommentRailOpen } from "../store/inboxStore";
import { useTipActions } from "../tips";
import { resolveCommentsEnabled } from "../lib/uiPrefDefaults";

// The teammate comment rail's header toggle. A conversation-scoped overlay, so
// it shows only while a conversation is on screen. The comment tools are
// opt-in (off by default), but a conversation that already has comments still
// surfaces the toggle so you can open it to read and reply. A leaf: a comment
// anywhere and every session switch wake this button, not the shell.
export const CommentsToggle = memo(function CommentsToggle({ isOnConversationPage, isOnInboxPage }: { isOnConversationPage: boolean; isOnInboxPage: boolean }) {
  const s = useTrackedStore([
    s => s.currentSessionId,
    s => s.viewingDismissedId,
    s => selectCommentRailOpen(s),
    s => resolveCommentsEnabled(s.clientState.ui),
    // The comments map REF (an O(1) Object.is compare), not a scan: comments
    // is low-churn (heartbeats never touch it), so the ref is stable between
    // comment syncs, and the "does the viewed conversation have comments"
    // answer is derived below off the same ref.
    s => s.comments,
  ]);
  const tipActions = useTipActions();
  // Conversation ids that carry at least one comment, indexed once per
  // comments-map change (not per render), so the check below is a Set lookup.
  const commentedConvIds = useMemo(() => {
    const set = new Set<string>();
    for (const c of Object.values(s.comments) as { conversation_id?: string }[]) {
      if (c.conversation_id) set.add(c.conversation_id);
    }
    return set;
  }, [s.comments]);
  const isViewingConversation = isOnConversationPage || (isOnInboxPage && !!(s.currentSessionId || s.viewingDismissedId));
  const commentRailOpen = selectCommentRailOpen(s);
  const viewedConvIds = [s.currentSessionId, s.viewingDismissedId].filter(Boolean) as string[];
  const convHasComments = viewedConvIds.some((id) => commentedConvIds.has(id));
  if (!isViewingConversation || !(resolveCommentsEnabled(s.clientState.ui) || convHasComments)) return null;
  return (
    <ShortcutTooltip label={commentRailOpen ? "Hide comments" : "Show comments"} action="sidebar.toggleComments">
      <TopbarButton
        onClick={(e) => { s.setCommentRailOpen(!commentRailOpen); tipActions.whisper('sidebar.toggleComments', e); }}
        active={commentRailOpen}
        aria-label={commentRailOpen ? "Hide comments" : "Show comments"}
      >
        <MessageSquare />
      </TopbarButton>
    </ShortcutTooltip>
  );
});
