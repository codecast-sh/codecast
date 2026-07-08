import { X } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useDocPresence } from "../../hooks/useDocPresence";
import { MessageInput } from "../ConversationView";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { PingAgentButton } from "./PingAgentButton";
import { presenceDocId, commentAuthorName, type Comment } from "../../lib/commentThread";

// Composer for one thread. Reuses the conversation's own MessageInput (mentions,
// image paste, auto-grow, and a submit path that clears the box synchronously) in
// `bareComposer` mode — no session chrome. The draft lives under an isolated
// `comment:<thread>` key so it never collides with the conversation's own draft,
// and we read it back to broadcast typing presence. The agent affordance lives in
// the thread, not here.

export function CommentComposer({
  conversationId,
  messageId,
  enabled,
  authed,
  replyTo,
  currentUserId,
  onCancelReply,
  onClose,
  onPingAgent,
  agentType,
  onSubmit,
  placeholder = "Comment…",
  autoFocus,
}: {
  conversationId: string;
  messageId?: string;
  enabled: boolean;
  authed: boolean;
  replyTo?: Comment | null;
  currentUserId?: string;
  onCancelReply?: () => void;
  onClose?: () => void;
  onPingAgent?: () => void;
  agentType?: string;
  onSubmit: (content: string) => void | Promise<void>;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const draftKey = `comment:${conversationId}:${messageId ?? "global"}`;
  const draft = useInboxStore((s) => (s.drafts[draftKey]?.draft_message as string | undefined) ?? "");

  const present = useDocPresence({
    docId: presenceDocId(conversationId, messageId),
    draftText: draft,
    enabled: authed && enabled,
    forceBroadcast: draft.trim().length > 0,
  });
  const typing = present.filter((p) => p.draft_text && p.draft_text.trim());

  if (!authed) return <div className="cc-cmt-signedout">Sign in to comment.</div>;

  // Esc backs out (capture phase, before MessageInput sees it): cancel a reply
  // first, otherwise close. Enter posts the comment as usual.
  const onKeyDownCapture = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (replyTo && onCancelReply) { e.preventDefault(); e.stopPropagation(); onCancelReply(); }
    else if (onClose) { e.preventDefault(); e.stopPropagation(); onClose(); }
  };

  return (
    <div className="cc-cmt-composer" onKeyDownCapture={onKeyDownCapture}>
      {typing.length > 0 && (
        <div className="cc-cmt-typing">
          <span className="cc-cmt-typing-dots"><i /><i /><i /></span>
          {typing.length === 1 ? (
            <span className="truncate">
              <b style={{ color: typing[0].user_color }}>{typing[0].user_name}</b>{" "}
              <span className="cc-cmt-typing-preview">{typing[0].draft_text}</span>
            </span>
          ) : (
            <span>{typing.map((t) => t.user_name).join(", ")} are typing…</span>
          )}
        </div>
      )}

      {replyTo && (
        <div className="cc-cmt-replyto">
          <span className="truncate">
            Replying to <b>{commentAuthorName(replyTo, currentUserId)}</b>
          </span>
          <button type="button" className="cc-cmt-replyto-x" onClick={onCancelReply} title="Cancel reply">
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      <div className="cc-cmt-mi">
        <MessageInput
          conversationId={draftKey}
          bareComposer
          composerPlaceholder={placeholder}
          autoFocusInput={autoFocus}
          onGateSend={async (text) => { await onSubmit(text); onCancelReply?.(); }}
        />
      </div>

      {(onPingAgent || onClose) && (
        <div className="cc-cmt-composer-foot">
          {onPingAgent ? <PingAgentButton agentType={agentType} onClick={onPingAgent} /> : <span />}
          {onClose && (
            <button type="button" className="cc-comment-btn" onMouseDown={(e) => e.preventDefault()} onClick={onClose}>
              Cancel <KeyCap size="xs">Esc</KeyCap>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
