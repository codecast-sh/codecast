import { useCallback, useEffect, useMemo } from "react";
import { CheckCircle2, FileCode2, MessageSquare, Quote } from "lucide-react";
import { useInboxStore, useTrackedStore, type ThreadInboxRow } from "../../../store/inboxStore";
import { useCurrentUser } from "../../../hooks/useCurrentUser";
import { useCommentActions, useConversationCommentsSync } from "../../../hooks/useConversationComments";
import {
  GLOBAL_THREAD_KEY,
  isAgentComment,
  isThreadResolved,
  parseCommentThreadRootKey,
  webThreadKeyFromAnchor,
  fileThreadKey,
  type Comment,
  type CommentThread as CommentThreadModel,
} from "../../../lib/commentThread";
import { sessionLabel } from "../../../lib/notificationTypes";
import { cleanContent } from "../../../lib/conversationProcessor";
import { summaryCount, type ThreadCardModel } from "../../../lib/threadCards";
import { AgentIcon } from "../../ConversationList";
import { CommentCard } from "../../comments/CommentCard";
import { CommentThread } from "../../comments/CommentThread";
import { FileLineThread } from "../../comments/FileLineThread";
import { useThreadsPage } from "../threadsContext";

// The comment kind: one comment thread on a session — anchored to a message,
// to a code line, or to the conversation itself. The collapsed card names the
// session and the anchor and shows the root comment; expanded, the whole
// thread through the same renderers the conversation's rail uses, composer
// and agent ping included.

function rowOf(card: ThreadCardModel): ThreadInboxRow {
  return card.source as ThreadInboxRow;
}

/** Where the thread lives and which anchor it hangs on, from the row. */
function anchorOf(row: ThreadInboxRow): { conversationId: string; webKey: string; messageId?: string; filePath?: string; lineNumber?: number } {
  const parsed = parseCommentThreadRootKey(row.root_key);
  const conversationId = String(row.conversation_id ?? parsed.conversationId);
  const webKey = webThreadKeyFromAnchor(parsed.anchorKey);
  return {
    conversationId,
    webKey,
    messageId: row.message_id ? String(row.message_id) : undefined,
    filePath: row.file_path,
    lineNumber: row.line_number,
  };
}

/** The rows of one thread, oldest first. Subscribed through a signature of the
 *  fields the card renders: the comments collection is one map for every
 *  conversation and its ref flips on every push. */
function threadCommentsSig(comments: Record<string, Comment>, conversationId: string, webKey: string): string {
  let sig = "";
  for (const id in comments) {
    const c = comments[id];
    if (c.conversation_id !== conversationId) continue;
    const key = c.message_id ? c.message_id : c.file_path ? fileThreadKey(c.file_path, c.line_number) : GLOBAL_THREAD_KEY;
    if (key !== webKey) continue;
    sig += `${c._id}|${c.created_at}|${c.content.length}|${c.resolved_at ?? ""}|${c.agent_status ?? ""};`;
  }
  return sig;
}

function useThreadComments(conversationId: string, webKey: string): Comment[] {
  const s = useTrackedStore([(s) => threadCommentsSig(s.comments as Record<string, Comment>, conversationId, webKey)]);
  const sig = threadCommentsSig(s.comments as Record<string, Comment>, conversationId, webKey);
  return useMemo(() => {
    const out: Comment[] = [];
    const all = s.comments as Record<string, Comment>;
    for (const id in all) {
      const c = all[id];
      if (c.conversation_id !== conversationId) continue;
      const key = c.message_id ? c.message_id : c.file_path ? fileThreadKey(c.file_path, c.line_number) : GLOBAL_THREAD_KEY;
      if (key === webKey) out.push(c);
    }
    return out.sort((a, b) => a.created_at - b.created_at);
    // The signature is the real dep: the raw map ref flips on every push.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, conversationId, webKey]);
}

function useAgentType(conversationId: string): string {
  return useInboxStore(
    (s) => ((s.conversations[conversationId] ?? s.sessions[conversationId]) as { agent_type?: string } | undefined)?.agent_type ?? "claude_code",
  );
}

/** The label leads with the session's agent mark, the way an Inbox row does.
 *  The kind tile keeps the kind's own icon, so a scan down the page reads
 *  kinds before it reads which agent. */
export function CommentLabel({ card }: { card: ThreadCardModel }) {
  const { conversationId } = anchorOf(rowOf(card));
  const agentType = useAgentType(conversationId);
  const label = useInboxStore((s) => sessionLabel(s.conversations[conversationId] ?? s.sessions[conversationId]));
  return (
    <>
      <AgentIcon agentType={agentType} className="w-3 h-3" />
      {label ?? "Session"}
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

export function CommentRoot({ card, expanded }: { card: ThreadCardModel; expanded: boolean }) {
  const row = rowOf(card);
  const anchor = anchorOf(row);
  const comments = useThreadComments(anchor.conversationId, anchor.webKey);
  const { user } = useCurrentUser();
  const currentUserId = user?._id as string | undefined;
  const agentType = useAgentType(anchor.conversationId);
  const { editComment, deleteComment } = useCommentActions(anchor.conversationId);
  const { toggle } = useThreadsPage();
  const root = comments[0];
  const resolved = isThreadResolved(comments);
  const replies = Math.max(0, comments.length - 1);
  const lastReply = row.last_reply;
  const open = useCallback(() => toggle(card), [toggle, card]);
  return (
    <>
      <div className="th-card-anchorrow">
        <AnchorLine {...anchor} />
        {resolved && (
          <span className="th-card-chip th-card-chip-resolved">
            <CheckCircle2 className="w-3 h-3" /> Resolved
          </span>
        )}
      </div>
      {!expanded && (
        root ? (
          <div className="th-card-root th-card-comment">
            <CommentCard
              comment={root}
              currentUserId={currentUserId}
              agentType={agentType}
              onReply={open}
              onEdit={editComment}
              onDelete={deleteComment}
            />
          </div>
        ) : (
          <div className="th-card-root th-card-ghost" aria-hidden="true">
            <div className="ch-skel-line ch-skel-head" />
            <div className="ch-skel-line" style={{ width: "62%" }} />
          </div>
        )
      )}
      {!expanded && (
        <button type="button" className="th-card-summary" onClick={open}>
          <span className="th-card-count">{summaryCount(replies, "reply", "replies")}</span>
          {lastReply && replies > 0 && (
            <span className="th-card-preview">
              <span className="th-card-preview-name">{lastReply.author_name ?? (lastReply.author_kind === "agent" ? "Agent" : "Teammate")}:</span>{" "}
              {lastReply.preview}
            </span>
          )}
        </button>
      )}
    </>
  );
}

export function CommentExpanded({ card, present }: { card: ThreadCardModel; present: boolean; frozenReadAt: number }) {
  const row = rowOf(card);
  const anchor = anchorOf(row);
  const { conversationId, webKey, messageId, filePath, lineNumber } = anchor;
  useConversationCommentsSync(conversationId);
  const comments = useThreadComments(conversationId, webKey);
  const { user, isAuthenticated } = useCurrentUser();
  const currentUserId = user?._id as string | undefined;
  const agentType = useAgentType(conversationId);
  const actions = useCommentActions(conversationId);

  // Reading is presence + the thread being open. Re-marks when a reply lands
  // while the reader is still looking (last_activity_at moves).
  useEffect(() => {
    if (!present) return;
    if (row.last_read_at >= row.last_activity_at && row.unread === 0) return;
    useInboxStore.getState().markThreadRead("comment", row.root_key);
  }, [present, row.root_key, row.last_activity_at, row.last_read_at, row.unread]);

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

  if (filePath) {
    return (
      <div className="th-card-open th-card-open-comments">
        <FileLineThread conversationId={conversationId} filePath={filePath} lineNumber={lineNumber} comments={comments} composerClassName="ch-composer" />
      </div>
    );
  }
  return (
    <div className="th-card-open th-card-open-comments">
      <CommentThread
        thread={thread}
        conversationId={conversationId}
        variant={messageId ? "anchored" : "global"}
        composerClassName="ch-composer"
        authed={isAuthenticated}
        canWrite={isAuthenticated}
        currentUserId={currentUserId}
        composerAutoFocus
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
