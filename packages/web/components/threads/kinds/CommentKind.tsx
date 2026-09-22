import { useMemo } from "react";
import { CheckCircle2, FileCode2, MessageSquare, Quote } from "lucide-react";
import { useInboxStore } from "../../../store/inboxStore";
import { useCurrentUser } from "../../../hooks/useCurrentUser";
import { useCommentActions, useConversationCommentsSync } from "../../../hooks/useConversationComments";
import { isAgentComment, isThreadResolved, type CommentThread as CommentThreadModel } from "../../../lib/commentThread";
import { sessionLabel } from "../../../lib/notificationTypes";
import { cleanContent } from "../../../lib/conversationProcessor";
import type { ThreadCardModel } from "../../../lib/threadCards";
import { commentAnchorOf as anchorOf, rowOf } from "../../../lib/threadRows";
import { useCommentThreadRows } from "../../../hooks/useThreadPreviews";
import { AgentIcon } from "../../ConversationList";
import { CommentThread } from "../../comments/CommentThread";
import { FileLineThread } from "../../comments/FileLineThread";
import { useTailPin } from "../cardWindow";
import { useThreadsPage } from "../threadsContext";

import { useWatchEffect } from "../../../hooks/useWatchEffect";
// The comment kind: one comment thread on a session — anchored to a message,
// to a code line, or to the conversation itself. The row names the session
// and previews the newest reply (or the root comment while it has none);
// open, the anchor line, then the whole thread through the same renderers
// the conversation's rail uses, composer and agent ping included.

function useAgentType(conversationId: string): string {
  return useInboxStore(
    (s) => ((s.conversations[conversationId] ?? s.sessions[conversationId]) as { agent_type?: string } | undefined)?.agent_type ?? "claude_code",
  );
}

/** The label leads with the session's agent mark, the way an Inbox row does.
 *  The kind tile keeps the kind's own icon, so a scan down the page reads
 *  kinds before it reads which agent. */
export function CommentLabel({ card }: { card: ThreadCardModel }) {
  const row = rowOf(card);
  const { conversationId, filePath, lineNumber } = anchorOf(row);
  const agentType = useAgentType(conversationId);
  const label = useInboxStore((s) => sessionLabel(s.conversations[conversationId] ?? s.sessions[conversationId]));
  // Never the literal word "Session": when the conversation is not cached,
  // the anchor still says what this thread is about.
  const fallback = filePath
    ? `${filePath.split("/").pop()}${lineNumber ? `:${lineNumber}` : ""}`
    : row.last_reply?.preview ?? "Comment thread";
  return (
    <>
      <AgentIcon agentType={agentType} className="w-3 h-3" />
      {label ?? fallback}
    </>
  );
}

/** The anchor line: a quoted excerpt of the message, the file and line, or
 *  "General" for the conversation thread. */
function AnchorLine({ conversationId, messageId, filePath, lineNumber }: { conversationId: string; messageId?: string; filePath?: string; lineNumber?: number }) {
  const excerpt = useInboxStore((s) => {
    if (!messageId) return undefined;
    const content = s.messages[conversationId]?.find((m) => m._id === messageId)?.content;
    if (!content) return undefined;
    return cleanContent(content).replace(/```[\s\S]*?```/g, " code ").replace(/\s+/g, " ").trim().slice(0, 120) || undefined;
  });
  if (messageId) {
    return (
      <div className="th-card-anchor">
        <Quote className="w-3 h-3 shrink-0" />
        <span className="th-card-anchor-text">{excerpt ?? "a message"}</span>
      </div>
    );
  }
  if (filePath) {
    return (
      <div className="th-card-anchor">
        <FileCode2 className="w-3 h-3 shrink-0" />
        <span className="th-card-anchor-text">{filePath}{lineNumber ? `:${lineNumber}` : ""}</span>
      </div>
    );
  }
  return (
    <div className="th-card-anchor">
      <MessageSquare className="w-3 h-3 shrink-0" />
      <span className="th-card-anchor-text">General</span>
    </div>
  );
}

export function CommentMeta({ card }: { card: ThreadCardModel }) {
  const row = rowOf(card);
  const anchor = anchorOf(row);
  const comments = useCommentThreadRows(card);
  const resolved = isThreadResolved(comments);
  return (
    <div className="th-card-anchorrow">
      <AnchorLine {...anchor} />
      {resolved && (
        <span className="th-card-chip th-card-chip-resolved">
          <CheckCircle2 className="w-3 h-3" /> Resolved
        </span>
      )}
    </div>
  );
}

export function CommentExpanded({ card, seen, focusComposer }: { card: ThreadCardModel; present: boolean; seen: boolean; frozenReadAt: number; focusComposer: boolean }) {
  const row = rowOf(card);
  const anchor = anchorOf(row);
  const { conversationId, webKey, messageId, filePath, lineNumber } = anchor;
  useConversationCommentsSync(conversationId);
  const comments = useCommentThreadRows(card);
  const { user, isAuthenticated } = useCurrentUser();
  const currentUserId = user?._id as string | undefined;
  const agentType = useAgentType(conversationId);
  const actions = useCommentActions(conversationId);

  // The read law: the row is open and the reader is here (`seen`), and the
  // store holds the thread — never while it holds nothing for an unread
  // thread (a cold cache renders an empty body with the newest reply never
  // shown; the length dep fires the mark once it syncs in). Re-marks when a
  // reply lands while the reader is still looking (last_activity_at moves).
  useWatchEffect(() => {
    if (!seen) return;
    if (row.unread > 0 && comments.length === 0) return;
    if (row.last_read_at >= row.last_activity_at && row.unread === 0) return;
    useInboxStore.getState().markThreadRead("comment", row.root_key);
  }, [seen, row.root_key, row.last_activity_at, row.last_read_at, row.unread, comments.length]);

  const thread: CommentThreadModel = useMemo(
    () => ({
      key: webKey,
      messageId,
      filePath,
      lineNumber,
      comments,
      lastActivity: comments.length ? comments[comments.length - 1].created_at : 0,
      resolved: isThreadResolved(comments),
    }),
    [webKey, messageId, filePath, lineNumber, comments],
  );
  const agentBusy = comments.some((c) => isAgentComment(c) && (c.agent_status === "thinking" || c.agent_status === "streaming"));

  // The wrapper IS the capped scroller; pinned to the tail so the newest
  // reply is what shows first.
  const pinRef = useTailPin(comments.length ? `${comments[comments.length - 1]._id}|${comments.length}` : "");

  if (filePath) {
    return (
      <div ref={pinRef} className="th-card-open th-card-open-comments">
        <FileLineThread conversationId={conversationId} filePath={filePath} lineNumber={lineNumber} comments={comments} composerClassName="ch-composer" />
      </div>
    );
  }
  return (
    <div ref={pinRef} className="th-card-open th-card-open-comments">
      <CommentThread
        thread={thread}
        conversationId={conversationId}
        variant={messageId ? "anchored" : "global"}
        composerClassName="ch-composer"
        authed={isAuthenticated}
        canWrite={isAuthenticated}
        currentUserId={currentUserId}
        composerAutoFocus={focusComposer}
        onAdd={actions.addComment}
        onEdit={actions.editComment}
        onDelete={actions.deleteComment}
        onAskAgent={actions.askAgent}
        agentBusy={agentBusy}
        agentType={agentType}
      />
    </div>
  );
}
