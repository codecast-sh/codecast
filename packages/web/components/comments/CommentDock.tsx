import { memo, useCallback, useEffect, useRef, useState } from "react";
import { MessageSquare, PanelRightClose, CornerUpRight, Quote } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useCurrentUser } from "../../hooks/useCurrentUser";
import { isConvexId } from "../../lib/entityLinks";
import { cleanContent } from "../../lib/conversationProcessor";
import { useConversationComments } from "../../hooks/useConversationComments";
import { isAgentComment } from "../../lib/commentThread";
import { CommentThread } from "./CommentThread";

// The conversation's GLOBAL comment thread as a right-docked, full-height rail —
// like the sidebar, on the other side. Closed it's a slim pill at the bottom
// right; open it fills the height and is width-resizable by dragging its left
// edge. Anchored threads live inline at their messages; the rail also lists them
// as jump targets. Reserves its width on the transcript via commentRailWidth.

const MIN_W = 300;
const MAX_W = 760;
const DEFAULT_W = 384;
const WIDTH_KEY = "cc-comment-rail-width";

function loadWidth(): number {
  if (typeof window === "undefined") return DEFAULT_W;
  const v = Number(window.localStorage.getItem(WIDTH_KEY));
  return v >= MIN_W && v <= MAX_W ? v : DEFAULT_W;
}

function snippetFor(content: string | undefined): string {
  if (!content) return "a message";
  return cleanContent(content).replace(/```[\s\S]*?```/g, " code ").replace(/\s+/g, " ").trim().slice(0, 64) || "a message";
}

function jumpToMessage(messageId: string) {
  const el = document.getElementById("msg-" + messageId);
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.add("cc-msg-flash");
  setTimeout(() => el.classList.remove("cc-msg-flash"), 1300);
  // expand the inline thread at that message
  useInboxStore.getState().openCommentThread(messageId);
}

function CommentRailImpl({ conversationId, bottomOffset }: { conversationId: string; bottomOffset: number }) {
  const { user, isAuthenticated } = useCurrentUser();
  const currentUserId = user?._id as string | undefined;
  const comments = useConversationComments(conversationId);

  const open = useInboxStore((s) => s.commentRailOpen) === true;
  const setOpen = useInboxStore((s) => s.setCommentRailOpen);
  const setWidth = useInboxStore((s) => s.setCommentRailWidth);
  const messages = useInboxStore((s) => s.messages[conversationId]) as Array<{ _id: string; content?: string }> | undefined;

  const [width, setW] = useState(loadWidth);
  const dragRef = useRef<{ x: number; w: number } | null>(null);

  const globalBusy = comments.global.comments.some((c) => isAgentComment(c) && (c.agent_status === "thinking" || c.agent_status === "streaming"));

  // Reserve the rail's width on the transcript while open.
  useEffect(() => {
    setWidth(conversationId, open ? width : 0);
    return () => setWidth(conversationId, 0);
  }, [conversationId, open, width, setWidth]);

  const onResizeDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { x: e.clientX, w: width };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setW(Math.min(MAX_W, Math.max(MIN_W, d.w + (d.x - ev.clientX))));
    };
    const up = () => {
      dragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setW((w) => { window.localStorage.setItem(WIDTH_KEY, String(w)); return w; });
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }, [width]);

  if (!open) {
    return (
      <button type="button" className="cc-railx-badge" style={{ bottom: bottomOffset }} title="Comments" onClick={() => setOpen(true)}>
        <MessageSquare className="w-[18px] h-[18px]" />
        {comments.totalCount > 0 && <span className="cc-railx-badge-count">{comments.totalCount}</span>}
      </button>
    );
  }

  return (
    <aside className="cc-railx" style={{ width }}>
      <div className="cc-railx-resize" onMouseDown={onResizeDown} title="Drag to resize" />
      <header className="cc-railx-head">
        <MessageSquare className="w-3.5 h-3.5 text-sol-cyan" />
        <span className="cc-railx-title">Comments</span>
        {comments.totalCount > 0 && <span className="cc-railx-count">{comments.totalCount}</span>}
        <button type="button" className="cc-railx-close" title="Hide comments" onClick={() => setOpen(false)}>
          <PanelRightClose className="w-4 h-4" />
        </button>
      </header>

      {comments.anchored.length > 0 && (
        <div className="cc-railx-anchored">
          <div className="cc-railx-anchored-label">On specific messages</div>
          {comments.anchored.map((t) => (
            <button
              key={t.key}
              type="button"
              className="cc-railx-anchored-row"
              title="Jump to this message"
              onClick={() => t.messageId && jumpToMessage(t.messageId)}
            >
              <Quote className="w-3 h-3 shrink-0 text-sol-cyan/70" />
              <span className="cc-railx-anchored-snip">{t.messageId ? snippetFor((messages ?? []).find((m) => m._id === t.messageId)?.content) : "a message"}</span>
              <span className="cc-railx-anchored-count">{t.comments.length}</span>
              <CornerUpRight className="w-3 h-3 shrink-0 opacity-50" />
            </button>
          ))}
        </div>
      )}

      <div className="cc-railx-global">
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
      </div>
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
  return <CommentRailImpl conversationId={conversationId} bottomOffset={bottomOffset} />;
});
