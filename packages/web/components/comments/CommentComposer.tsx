import { useRef, useState } from "react";
import { ArrowUp, Bot, X, Loader2 } from "lucide-react";
import { useDocPresence } from "../../hooks/useDocPresence";
import { useMentionQuery } from "../../hooks/useMentionQuery";
import { ComposeEditor, type ComposeEditorHandle } from "../editor/ComposeEditor";
import { presenceDocId, commentAuthorName, type Comment } from "../../lib/commentThread";

// Composer for one thread. Reuses the conversation's rich ComposeEditor so
// comments get @-mentions (people, sessions, tasks, docs) for free, broadcasts
// the live draft as typing presence, sends on Enter, and exposes the opt-in
// "Ask agent" icon. Replying to a comment threads the next message under it.

export function CommentComposer({
  conversationId,
  messageId,
  enabled,
  authed,
  replyTo,
  currentUserId,
  onCancelReply,
  onSubmit,
  onAskAgent,
  agentBusy,
  placeholder = "Comment… (@ to mention)",
  autoFocus,
}: {
  conversationId: string;
  messageId?: string;
  enabled: boolean;
  authed: boolean;
  replyTo?: Comment | null;
  currentUserId?: string;
  onCancelReply?: () => void;
  onSubmit: (content: string) => void | Promise<void>;
  onAskAgent?: () => void | Promise<void>;
  agentBusy?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [editorKey, setEditorKey] = useState(0); // remount to clear after send
  const editorRef = useRef<ComposeEditorHandle>(null);
  const mentionQuery = useMentionQuery({ kind: "any" });

  // Broadcast the live draft as typing presence while there's content; watch others'.
  const present = useDocPresence({
    docId: presenceDocId(conversationId, messageId),
    draftText: text,
    enabled: authed && enabled,
    forceBroadcast: text.trim().length > 0,
  });
  const typing = present.filter((p) => p.draft_text && p.draft_text.trim());

  const submit = async () => {
    const body = (editorRef.current?.getMarkdown() ?? "").trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await onSubmit(body);
      editorRef.current?.clear();
      setText("");
      setEditorKey((k) => k + 1);
      onCancelReply?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cc-cmt-composer">
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

      {authed ? (
        <div className="cc-cmt-editorbox">
          <div className="cc-cmt-editor">
            <ComposeEditor
              key={editorKey}
              ref={editorRef}
              initialContent=""
              onMentionQuery={mentionQuery}
              onSubmit={submit}
              onExit={() => {}}
              onTextChange={setText}
              onContentChange={() => {}}
              submitOnEnter
              placeholder={placeholder}
            />
          </div>
          <div className="cc-cmt-editor-actions">
            {onAskAgent && (
              <button
                type="button"
                className={"cc-cmt-agentbtn" + (agentBusy ? " cc-cmt-agentbtn-busy" : "")}
                disabled={agentBusy || !enabled}
                title={agentBusy ? "Agent is replying…" : "Ask the agent to reply in this thread"}
                aria-label="Ask the agent to reply in this thread"
                onClick={() => onAskAgent()}
              >
                {agentBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bot className="w-3.5 h-3.5" />}
              </button>
            )}
            <button
              type="button"
              className="cc-cmt-send"
              disabled={!text.trim() || busy || !enabled}
              title="Send (Enter)"
              onMouseDown={(e) => e.preventDefault()}
              onClick={submit}
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowUp className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      ) : (
        <div className="cc-cmt-signedout">Sign in to comment.</div>
      )}
    </div>
  );
}
