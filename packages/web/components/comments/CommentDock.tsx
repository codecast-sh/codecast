import { memo, useCallback, useEffect, useRef, useState } from "react";
import { MessageSquare, X, CornerUpRight, Quote } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useCurrentUser } from "../../hooks/useCurrentUser";
import { isConvexId } from "../../lib/entityLinks";
import { cleanContent } from "../../lib/conversationProcessor";
import { useConversationComments } from "../../hooks/useConversationComments";
import { isAgentComment } from "../../lib/commentThread";
import { CommentThread } from "./CommentThread";

// The conversation's GLOBAL comment thread as a bottom-right chat dock: a pill
// when closed (count badge), a resizable side-chat panel when open. Anchored
// threads live inline at their messages (InlineMessageComments); this is the
// catch-all team chat for the whole conversation, plus a jump list to any
// anchored thread.

const MIN_W = 300, MIN_H = 280, MAX_W = 680, MAX_H = 900;

function snippetFor(content: string | undefined): string {
  if (!content) return "a message";
  return cleanContent(content).replace(/```[\s\S]*?```/g, " code ").replace(/\s+/g, " ").trim().slice(0, 60) || "a message";
}

function jumpToMessage(messageId: string) {
  const el = document.getElementById("msg-" + messageId);
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.add("cc-msg-flash");
  setTimeout(() => el.classList.remove("cc-msg-flash"), 1300);
}

function CommentDockImpl({ conversationId, bottomOffset }: { conversationId: string; bottomOffset: number }) {
  const { user, isAuthenticated } = useCurrentUser();
  const currentUserId = user?._id as string | undefined;
  const comments = useConversationComments(conversationId);

  const open = useInboxStore((s) => s.commentRailOpen);
  const setOpen = useInboxStore((s) => s.setCommentRailOpen);
  const messages = useInboxStore((s) => s.messages[conversationId]) as Array<{ _id: string; content?: string }> | undefined;

  const [size, setSize] = useState({ w: 380, h: 480 });
  const dragRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  const effectiveOpen = open === true; // closed by default — the pill invites
  const globalBusy = comments.global.comments.some((c) => isAgentComment(c) && (c.agent_status === "thinking" || c.agent_status === "streaming"));

  const onResizeDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { x: e.clientX, y: e.clientY, w: size.w, h: size.h };
    const move = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      // Handle is top-left: dragging left/up grows the panel.
      const w = Math.min(MAX_W, Math.max(MIN_W, d.w + (d.x - ev.clientX)));
      const h = Math.min(MAX_H, Math.max(MIN_H, d.h + (d.y - ev.clientY)));
      setSize({ w, h });
    };
    const up = () => { dragRef.current = null; window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }, [size]);

  const snippetById = (mid: string) => {
    const m = (messages ?? []).find((x) => x._id === mid);
    return snippetFor(m?.content);
  };

  if (!effectiveOpen) {
    return (
      <button
        type="button"
        className="cc-dock-pill"
        style={{ bottom: bottomOffset }}
        title="Comments"
        onClick={() => setOpen(true)}
      >
        <MessageSquare className="w-4 h-4" />
        <span>Comments</span>
        {comments.totalCount > 0 && <span className="cc-dock-pill-count">{comments.totalCount}</span>}
      </button>
    );
  }

  return (
    <aside className="cc-dock" style={{ width: size.w, height: size.h, bottom: bottomOffset }}>
      <div className="cc-dock-resize" onMouseDown={onResizeDown} title="Drag to resize" />
      <header className="cc-dock-head">
        <MessageSquare className="w-3.5 h-3.5 text-sol-cyan" />
        <span className="cc-dock-title">Comments</span>
        {comments.totalCount > 0 && <span className="cc-dock-count">{comments.totalCount}</span>}
        <button type="button" className="cc-dock-close" title="Close" onClick={() => setOpen(false)}>
          <X className="w-4 h-4" />
        </button>
      </header>

      {comments.anchored.length > 0 && (
        <div className="cc-dock-anchored">
          <div className="cc-dock-anchored-label">On specific messages</div>
          {comments.anchored.map((t) => (
            <button
              key={t.key}
              type="button"
              className="cc-dock-anchored-row"
              title="Jump to this message"
              onClick={() => t.messageId && jumpToMessage(t.messageId)}
            >
              <Quote className="w-3 h-3 shrink-0 text-sol-cyan/70" />
              <span className="cc-dock-anchored-snip">{t.messageId ? snippetById(t.messageId) : "a message"}</span>
              <span className="cc-dock-anchored-count">{t.comments.length}</span>
              <CornerUpRight className="w-3 h-3 shrink-0 opacity-50" />
            </button>
          ))}
        </div>
      )}

      <CommentThread
        thread={comments.global}
        conversationId={conversationId}
        variant="global"
        authed={isAuthenticated}
        canWrite={isAuthenticated}
        currentUserId={currentUserId}
        composerAutoFocus
        emptyHint={
          comments.totalCount === 0
            ? "Start a thread for your team. Comments are visible to everyone who can see this conversation."
            : undefined
        }
        onAdd={comments.addComment}
        onEdit={comments.editComment}
        onDelete={comments.deleteComment}
        onAskAgent={comments.askAgent}
        agentBusy={globalBusy}
      />
    </aside>
  );
}

export const CommentDock = memo(function CommentDock({
  conversationId,
  bottomOffset = 24,
}: {
  conversationId: string;
  bottomOffset?: number;
}) {
  if (!isConvexId(conversationId)) return null;
  return <CommentDockImpl conversationId={conversationId} bottomOffset={bottomOffset} />;
});
